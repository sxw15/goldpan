import { errorMessage } from '../../../errors';
import { CollectorError, formatAbortSignalReason } from '../../errors';
import { parseCollectedHtml } from '../../shared/parse-collected-html';
import type { CollectorInput, CollectorOutput, CollectorPlugin, PluginContext } from '../../types';
import { safeFetch } from './safe-fetch';

// Module-level shadow of `pluginConfig.ssrfValidationEnabled` (set by
// bootstrap from `GoldpanConfig.ssrfValidationEnabled`). Default `true` is
// the safe behaviour for tests that register the plugin standalone, before
// `initialize` runs. Shadow rather than re-reading `context.pluginConfig` at
// call time keeps the convention used elsewhere in the plugin layer
// (`collector-browser` does the same for `browserStrategy` /
// `collectTimeoutMs`); if that convention is ever revisited, sweep both
// plugins together.
let ssrfValidationEnabled = true;

/**
 * Built-in web page collector (spec §9.3).
 *
 * Pipeline: safeFetch (SSRF-safe) → Readability (extract) → Turndown (HTML→MD)
 *
 * - Priority 0: fallback collector. Future plugins (e.g. JS renderer) use higher priority.
 * - Single attempt, no retry/fallback (V1).
 * - Does NOT support JavaScript-rendered pages (SPA).
 */
export const collectorWebPlugin: CollectorPlugin = {
  name: 'collector-web',
  version: '0.1.0',
  type: 'collector',
  description: 'Built-in web page collector using readability + turndown',
  priority: 0,

  async initialize(context: PluginContext): Promise<void> {
    const flag = context.pluginConfig.ssrfValidationEnabled;
    if (typeof flag === 'boolean') ssrfValidationEnabled = flag;
  },

  canHandle: (input: CollectorInput): boolean => {
    try {
      const url = new URL(input.url);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  },

  collect: async (input: CollectorInput, signal: AbortSignal): Promise<CollectorOutput> => {
    try {
      const { response, finalUrl } = await safeFetch(input.url, signal, {
        ssrfValidationEnabled,
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new CollectorError(
          `HTTP ${response.status} ${response.statusText}`,
          'FETCH_FAILED',
          response.status >= 500 || response.status === 429,
        );
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        await response.body?.cancel();
        throw new CollectorError(
          `Unsupported content type: ${contentType}. Only HTML pages are supported.`,
          'PARSE_FAILED',
          false,
        );
      }

      const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB hard limit
      const contentLength = response.headers.get('content-length');
      const parsedContentLength = contentLength ? parseInt(contentLength, 10) : NaN;
      if (Number.isFinite(parsedContentLength) && parsedContentLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new CollectorError(
          `Response too large (${contentLength} bytes, limit ${MAX_RESPONSE_BYTES})`,
          'FETCH_FAILED',
          false,
        );
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      const reader = response.body?.getReader();
      if (!reader) {
        throw new CollectorError('Response body is not readable', 'FETCH_FAILED', false);
      }
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new CollectorError(
              `Response body too large: exceeded ${MAX_RESPONSE_BYTES} bytes`,
              'FETCH_FAILED',
              false,
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const buffer = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const html = new TextDecoder().decode(buffer);
      if (!html.trim()) {
        throw new CollectorError('Empty response body', 'CONTENT_EMPTY', false);
      }

      return parseCollectedHtml(html, finalUrl);
    } catch (error) {
      if (error instanceof CollectorError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        const detail =
          signal.reason !== undefined && signal.reason !== null
            ? formatAbortSignalReason(signal)
            : error.message;
        throw new CollectorError(`Request aborted: ${detail}`, 'ABORTED', false, error);
      }
      throw new CollectorError(
        `Collection failed: ${errorMessage(error)}`,
        'FETCH_FAILED',
        false,
        error,
      );
    }
  },
};
