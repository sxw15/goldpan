// apps/server/src/routes/auth.ts
import crypto from 'node:crypto';
import { verifyAuth } from '../auth.js';
import { createSlidingWindowLimiter } from '../rate-limit.js';
import { buildSessionCookie, buildSessionCookieClear, generateSessionToken } from '../session.js';
import { parseJsonBody, type RouteContext, respond, respondError } from './types.js';

function verifyPassword(input: string, authPassword: string): boolean {
  const expectedHash = crypto.createHash('sha256').update(authPassword).digest();
  const actualHash = crypto.createHash('sha256').update(input).digest();
  return crypto.timingSafeEqual(expectedHash, actualHash);
}

// Failed-login throttle. Separate bucket from the global rate limiter so a
// brute-forcer hitting /auth/login doesn't deplete the same window that gates
// non-auth traffic. Bills only failed attempts (peek before / record after).
const loginLimiter = createSlidingWindowLimiter({
  windowMs: 60_000,
  max: 5,
  maxKeys: 1_000,
});

/**
 * Handle all /auth/* routes.
 * segments[0] = 'login' | 'logout' | 'status'
 */
export async function handleAuthRoutes(ctx: RouteContext): Promise<void> {
  const { req, res, segments, handle, readBody, getClientIp } = ctx;
  const authPassword = handle.config.authPassword;
  const action = segments[0];

  // POST /auth/login
  if (req.method === 'POST' && action === 'login') {
    if (!authPassword) {
      // No password configured — auth is disabled, auto-succeed
      req.resume();
      respond(res, 200, { authenticated: true });
      return;
    }

    const ip = getClientIp();
    if (!loginLimiter.peek(ip)) {
      req.resume();
      respondError(res, 429, 'rate_limited', 'Too many login attempts');
      return;
    }

    const body = await readBody();
    if (body === null) return;

    const parsed = parseJsonBody<{ password?: string }>(res, body);
    if (parsed === null) return;

    if (typeof parsed.password !== 'string' || !parsed.password) {
      respondError(res, 400, 'missing_password', 'Password is required');
      return;
    }

    if (!verifyPassword(parsed.password, authPassword)) {
      loginLimiter.record(ip);
      respondError(res, 401, 'invalid_password', 'Invalid password');
      return;
    }

    const token = generateSessionToken(authPassword);
    const secure = process.env.NODE_ENV === 'production';
    res.setHeader('Set-Cookie', buildSessionCookie(token, secure));
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    respond(res, 200, { token, expiresAt });
    return;
  }

  // POST /auth/logout
  if (req.method === 'POST' && action === 'logout') {
    req.resume();
    res.setHeader('Set-Cookie', buildSessionCookieClear());
    respond(res, 200, { authenticated: false });
    return;
  }

  // GET /auth/status
  if (req.method === 'GET' && action === 'status') {
    req.resume();
    const { config } = handle;
    const language = config.language ?? 'en';

    if (!authPassword) {
      respond(res, 200, {
        authenticated: true,
        authRequired: false,
        language,
        features: {
          embedding: !!config.embedding.enabled,
          relations: !!config.relation.enabled,
          debug: ctx.debugApiEnabled,
        },
        config: {
          // live (hot setting): the web client reads this per request, so its
          // textarea cap reflects a Settings change without a web restart.
          maxTextInputLength: handle.configStore.getSnapshot().config.maxTextInputLength,
        },
      });
      return;
    }

    // Accept both session token AND legacy Bearer-password mode so probing
    // clients see the same auth view that protected routes use.
    const authenticated = verifyAuth(req, authPassword);
    respond(res, 200, {
      authenticated,
      authRequired: true,
      language,
      features: {
        embedding: !!config.embedding.enabled,
        relations: !!config.relation.enabled,
        debug: ctx.debugApiEnabled,
      },
      config: {
        // live (hot setting) — see the authenticated branch above.
        maxTextInputLength: handle.configStore.getSnapshot().config.maxTextInputLength,
      },
    });
    return;
  }

  req.resume();
  respondError(res, 404, 'not_found', 'Not found');
}
