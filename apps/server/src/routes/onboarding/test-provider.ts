// apps/server/src/routes/onboarding/test-provider.ts
import type http from 'node:http';
import {
  resolveSsrfValidationEnabled,
  validateProviderBaseUrl,
} from '../../lib/base-url-security.js';
import { parseJsonBody, respond, respondError } from '../types.js';
import { readJsonBody } from './_body.js';

export interface TestProviderInput {
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface TestProviderResult {
  ok: boolean;
  error?: string;
}

const TIMEOUT_MS = 5_000;

/**
 * Default API endpoints by provider. The wizard lets the user override via
 * `baseUrl` (mostly for self-hosted Ollama or proxied OpenAI-compatible
 * endpoints), but ships sensible defaults so the connectivity check works
 * out-of-the-box for the standard cloud providers.
 *
 * Ollama defaults to `http://localhost:11434/v1` to mirror goldpan's
 * provider-config convention (everywhere else stores the OpenAI-compatible
 * `/v1` URL). The probe strips `/v1` to call the native `/api/tags` route,
 * which Ollama exposes for service-discovery.
 */
const DEFAULT_BASE: Record<string, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
  deepseek: 'https://api.deepseek.com',
  ollama: 'http://localhost:11434/v1',
  // OpenRouter base already includes `/v1` — the probe uses `${base}/models`
  // (NOT `${base}/v1/models`) so this URL is full-pathed.
  openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * Probe a provider's API for connectivity + auth correctness. Each provider
 * uses its cheapest available "is the key valid" call:
 *
 * - OpenAI / Anthropic / Google → list-models endpoints (no token spend)
 * - DeepSeek → `POST /chat/completions` with `max_tokens: 1`. DeepSeek
 *   doesn't expose a list-models endpoint, so we fire the smallest possible
 *   completion (~1 output token) just to verify the key.
 * - Ollama → `GET /api/tags` (local, no auth)
 *
 * 5 s AbortController timeout caps the wait so a wizard "Test" button never
 * leaves the user staring at a spinner.
 */
export async function testProvider(input: TestProviderInput): Promise<TestProviderResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const hasCustomBaseUrl = input.baseUrl !== undefined && input.baseUrl !== '';
    const base = hasCustomBaseUrl ? input.baseUrl : DEFAULT_BASE[input.providerId];
    if (!base) {
      return { ok: false, error: `Unknown provider: ${input.providerId}` };
    }
    if (hasCustomBaseUrl) {
      // No staged-keys map here — testProvider runs from a "Test" button mid-
      // wizard, before commit, so we read the SSRF flag straight from
      // process.env (Fake-IP users put it in their initial .env / shell env).
      await validateProviderBaseUrl(input.providerId, base, resolveSsrfValidationEnabled());
    }

    let res: Response;
    switch (input.providerId) {
      case 'openai':
        res = await fetch(`${base}/v1/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${input.apiKey ?? ''}` },
          signal: ctl.signal,
        });
        break;
      case 'anthropic':
        res = await fetch(`${base}/v1/models`, {
          method: 'GET',
          headers: {
            'x-api-key': input.apiKey ?? '',
            'anthropic-version': '2023-06-01',
          },
          signal: ctl.signal,
        });
        break;
      case 'google': {
        const url = new URL(`${base}/v1beta/models`);
        url.searchParams.set('key', input.apiKey ?? '');
        res = await fetch(url, { method: 'GET', signal: ctl.signal });
        break;
      }
      case 'deepseek':
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${input.apiKey ?? ''}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'deepseek-v4-flash',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
          }),
          signal: ctl.signal,
        });
        break;
      case 'ollama': {
        // Ollama config stores the OpenAI-compatible `/v1` URL, but the
        // tags endpoint is on the native API path. Strip a trailing `/v1`
        // (with optional slash) before calling `/api/tags`.
        const tagsBase = base.replace(/\/v1\/?$/, '');
        res = await fetch(`${tagsBase}/api/tags`, {
          method: 'GET',
          signal: ctl.signal,
        });
        break;
      }
      case 'openrouter':
        // Default base already includes `/v1`, so just `${base}/models` —
        // the OpenAI case prepends `/v1` because its base does NOT.
        res = await fetch(`${base}/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${input.apiKey ?? ''}` },
          signal: ctl.signal,
        });
        break;
      default:
        return { ok: false, error: `Unsupported provider: ${input.providerId}` };
    }

    if (!res.ok) {
      return { ok: false, error: `${res.status} ${res.statusText}`.trim() };
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { ok: false, error: 'timeout (5s)' };
    }
    if (e instanceof Error && e.name === 'AbortError') {
      // Some fetch implementations throw a generic Error with name=AbortError
      // instead of a DOMException. Treat both as timeout.
      return { ok: false, error: 'timeout (5s)' };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleTestProviderRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    respondError(res, 405, 'method_not_allowed', 'Use POST');
    return;
  }
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const parsed = parseJsonBody<TestProviderInput>(res, body);
  if (parsed === null) return;
  if (!parsed.providerId || typeof parsed.providerId !== 'string') {
    respondError(res, 400, 'invalid_input', 'providerId is required');
    return;
  }
  const result = await testProvider(parsed);
  respond(res, 200, result);
}
