import { Bot, GrammyError, HttpError } from 'grammy';

export type TelegramTestErrorKind =
  | 'unauthorized'
  | 'chat_not_found'
  | 'forbidden'
  | 'rate_limited'
  | 'network'
  | 'unknown';

export interface TelegramTestErrorMeta {
  /** Telegram error description (when available). Surfaced to logs only — never put on HTTP body. */
  telegramDescription?: string;
  /** Original grammy `error_code` so callers can preserve 4xx vs 5xx distinction in logs. */
  errorCode?: number;
  /** For `rate_limited`: seconds until the next call is allowed (Telegram `parameters.retry_after`). */
  retryAfter?: number;
}

export class TelegramTestError extends Error {
  readonly kind: TelegramTestErrorKind;
  readonly telegramDescription?: string;
  readonly errorCode?: number;
  readonly retryAfter?: number;

  constructor(kind: TelegramTestErrorKind, message: string, meta: TelegramTestErrorMeta = {}) {
    super(message);
    this.name = 'TelegramTestError';
    this.kind = kind;
    if (meta.telegramDescription !== undefined) this.telegramDescription = meta.telegramDescription;
    if (meta.errorCode !== undefined) this.errorCode = meta.errorCode;
    if (meta.retryAfter !== undefined) this.retryAfter = meta.retryAfter;
  }
}

export interface SendTelegramTestMessageOptions {
  token: string;
  chatId: string | number;
  text: string;
}

// Telegram 对"chat 不存在"返回的描述变体多达数种 — 经验上 `chat not found`
// 占多数，但 `PEER_ID_INVALID` / `chat_id is empty` / `chat id is empty` 都
// 出现过。只靠单一字符串匹配会让用户在描述变体下看到 "Server error" 而无法
// 自助排查 chat ID。把变体集中在一处，并给将来加 case 留一个清晰扩展点。
const CHAT_NOT_FOUND_RE = /chat[ _](?:not[ _]?found|id is empty)|PEER_ID_INVALID/i;

export async function sendTelegramTestMessage(opts: SendTelegramTestMessageOptions): Promise<void> {
  // grammy `Bot` 构造器对空 token 同步抛 `Error("Empty token!")`。把 self-validation
  // 放在 plugin 函数顶部而不是 require 每个调用方记得 guard —— 调用方契约越窄越好。
  if (!opts.token) {
    throw new TelegramTestError('unauthorized', 'Bot token is empty');
  }
  let bot: Bot;
  try {
    bot = new Bot(opts.token);
  } catch (err) {
    // Defensive — `if (!opts.token)` 已经挡了空字符串，但 grammy 未来可能加更多
    // 同步校验（token 格式、长度等），都属于"token 不可用"语义。
    throw new TelegramTestError(
      'unauthorized',
      err instanceof Error ? err.message : 'Failed to initialize bot',
    );
  }
  try {
    await bot.api.sendMessage(opts.chatId, opts.text, {
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (err instanceof GrammyError) {
      if (err.error_code === 401) {
        throw new TelegramTestError('unauthorized', 'Telegram rejected bot token', {
          telegramDescription: err.description,
          errorCode: 401,
        });
      }
      if (err.error_code === 400 && CHAT_NOT_FOUND_RE.test(err.description ?? '')) {
        throw new TelegramTestError('chat_not_found', 'Telegram chat not found', {
          telegramDescription: err.description,
          errorCode: 400,
        });
      }
      if (err.error_code === 403) {
        throw new TelegramTestError('forbidden', 'Bot blocked or kicked', {
          telegramDescription: err.description,
          errorCode: 403,
        });
      }
      if (err.error_code === 429) {
        // grammy 在 GrammyError.parameters 里附带 retry_after（秒）。
        const retryAfter =
          typeof err.parameters?.retry_after === 'number' ? err.parameters.retry_after : undefined;
        throw new TelegramTestError('rate_limited', 'Telegram rate limit hit', {
          telegramDescription: err.description,
          errorCode: 429,
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        });
      }
      throw new TelegramTestError('unknown', err.description ?? 'unknown grammy error', {
        telegramDescription: err.description,
        errorCode: err.error_code,
      });
    }
    if (err instanceof HttpError) {
      // 透传下层错误信息（ECONNREFUSED / ETIMEDOUT / TLS 失败）方便 self-host
      // 用户排查代理 / 防火墙问题。message 收敛成稳定前缀避免上层把 raw 文案拼到
      // 用户可见 toast。
      const lower = err.error instanceof Error ? `: ${err.error.message}` : '';
      throw new TelegramTestError('network', `Cannot reach Telegram API${lower}`);
    }
    throw err;
  }
}
