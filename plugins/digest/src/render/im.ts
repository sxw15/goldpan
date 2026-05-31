import type { DataSnapshot } from '../types.js';
import { type RenderOptions, renderDigestMarkdown } from './markdown.js';

/**
 * Render a digest snapshot for IM delivery. Currently delegates to the shared
 * markdown renderer; if IM channels later need a more compact output (for
 * example dropping the `ai_summary` heading or shorter titles) the
 * specialization lives here instead of bloating `markdown.ts`.
 */
export function renderIMDigest(snapshot: DataSnapshot, opts: RenderOptions): string {
  return renderDigestMarkdown(snapshot, opts);
}
