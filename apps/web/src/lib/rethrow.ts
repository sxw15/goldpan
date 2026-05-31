import { unstable_rethrow } from 'next/navigation';

/**
 * Re-throw Next.js framework errors (NEXT_REDIRECT / NEXT_NOT_FOUND / etc.)
 * that must not be caught by action error handlers. Call at the start of every
 * catch block in server actions / client handlers.
 *
 * 用 Next 的 `unstable_rethrow` 而不是朴素的 `'digest' in err` 自检 ——
 * 后者会误判：Next.js 16 给所有 server action 抛出的错误都附 `digest`
 * 字符串（生产环境的 hash，例如 `'366611260'`），不只是 NEXT_REDIRECT。
 * `if ('digest' in err) throw err` 会把业务错误（GoldpanApiError 等）也
 * rethrow，让 dev overlay / error boundary 替代 toast 显示，UI 拿不到错。
 *
 * `unstable_rethrow` 内部用 `isRedirectError(err)` 等精确判断 —— 解析
 * `digest` 字符串前缀（`NEXT_REDIRECT;...` / `NEXT_NOT_FOUND` 等），
 * 业务错误 no-op。`unstable_` 前缀只是 Next 团队预留改 API 余地，
 * 协议本身（按 digest 前缀分发）不会变。
 *
 * Client-safe — 不 import 任何 server-only 模块（next/headers 之类），
 * 'use client' 组件可以直接 import 使用。
 */
export function rethrowNextErrors(err: unknown): void {
  unstable_rethrow(err);
}
