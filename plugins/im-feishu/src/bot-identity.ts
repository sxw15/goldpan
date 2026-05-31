import { errorMessage } from '@goldpan/core/errors';
import type { ILogObj, Logger } from 'tslog';

/**
 * Closure-style fetcher so tests can inject a fake without pulling in the
 * Lark SDK. Production callers pass `() => fetchBotInfo(client)` from the
 * `src/sdk/bot-info.ts` wrapper.
 */
export type BotInfoFetcher = () => Promise<{ open_id?: string }>;

export interface FetchBotOpenIdOptions {
  fetcher: BotInfoFetcher;
  logger: Logger<ILogObj>;
}

/**
 * Resolve the bot's `open_id` at adapter startup with loud failures. The
 * `open_id` powers `FeishuGroupMentionFilter`'s structured mention check; a
 * missing / silently-degraded value would cause the bot to silently stop
 * responding in groups after a restart. We therefore treat any SDK rejection
 * or missing field as a hard startup error — the adapter fails to start
 * rather than running with a broken filter.
 */
export async function fetchBotOpenId(opts: FetchBotOpenIdOptions): Promise<string> {
  let result: { open_id?: string };
  try {
    result = await opts.fetcher();
  } catch (err) {
    throw new Error(`Feishu adapter: failed to fetch bot identity (${errorMessage(err)})`);
  }
  if (!result.open_id) {
    throw new Error('Feishu adapter: bot identity response missing open_id');
  }
  opts.logger.info('feishu bot identity resolved', { openId: result.open_id });
  return result.open_id;
}
