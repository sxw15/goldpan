// apps/server/src/cors.ts
import type http from 'node:http';

/**
 * Parse GOLDPAN_CORS_ORIGINS into a set of allowed origins.
 * Supports comma-separated values. '*' means allow all.
 */
export function parseCorsOrigins(envValue: string | undefined): Set<string> | '*' {
  if (!envValue) return new Set();
  const trimmed = envValue.trim();
  if (trimmed === '*') return '*';
  const origins = trimmed
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return new Set(origins);
}

/**
 * Apply CORS headers if the request origin is allowed.
 * Returns true if this was a preflight (OPTIONS) request that was fully handled.
 */
export function handleCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowedOrigins: Set<string> | '*',
): boolean {
  // No CORS configured — skip entirely
  if (allowedOrigins instanceof Set && allowedOrigins.size === 0) {
    return false;
  }

  const origin = req.headers.origin;
  if (!origin) return false;

  const isAllowed = allowedOrigins === '*' || allowedOrigins.has(origin);

  if (!isAllowed) return false;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');

  // Preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    req.resume();
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}
