import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// Load env from monorepo root .env / .env.local (does not override existing vars)
const monorepoRoot = path.join(__dirname, '../..');
const merged: Record<string, string> = {};
for (const name of ['.env', '.env.local'] as const) {
  const envPath = path.join(monorepoRoot, name);
  if (fs.existsSync(envPath)) {
    Object.assign(merged, dotenv.parse(fs.readFileSync(envPath)));
  }
}
for (const [key, value] of Object.entries(merged)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// /api/* → server proxy is handled at request time by `src/middleware.ts`
// (NextResponse.rewrite to process.env.GOLDPAN_SERVER_URL). next.config.ts
// `rewrites` are evaluated at `next build` and baked into the standalone
// output, so they cannot read runtime env vars — using middleware instead
// keeps the same image deployable in all-in-one and split modes.

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  experimental: {
    // Next.js dev proxy 默认 30s 上限，而 /api/input → server 在 clarify 后接
    // forcedIntent=query 这条链上要跑 query_understand + RRF + query 三段
    // LLM，p95 可以触到 25-30s+。一旦超 30s，proxy 切断，浏览器收到 plain
    // "Internal Server Error" 500（不是 server 写的 JSON），但 server 端
    // 已经把 assistant turn 落库 —— 出现"数据对、响应 500"假象。
    //
    // 调到 5min 与 apps/server 的 DEFAULT_INPUT_TIMEOUT_MS 对齐，让 server
    // 的 AbortController + 504 JSON 兜底成为唯一超时来源，proxy 不再当瓶颈。
    proxyTimeout: 5 * 60_000,
  },
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        {
          key: 'Content-Security-Policy',
          value: `default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';`,
        },
      ],
    },
  ],
  webpack: (config) => {
    // Prefer "default" export condition so workspace packages resolve to raw .ts
    // source (better HMR DX with @goldpan/web-sdk).
    const names = config.resolve?.conditionNames ?? [];
    if (!names.includes('default') || names.indexOf('default') > names.indexOf('import')) {
      config.resolve = config.resolve ?? {};
      config.resolve.conditionNames = ['default', ...names.filter((n: string) => n !== 'default')];
    }

    return config;
  },
};

export default withNextIntl(nextConfig);
