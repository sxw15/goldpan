/**
 * Concrete payload shape this channel emits.
 *
 * Deliberately NOT `extends ChannelReplyPayload`: `ChannelReplyPayload` is
 * `unknown` (opaque at Layer A), and `interface T extends unknown` is
 * meaningless. The runtime relationship is enforced by `ChannelAdapter`
 * method signatures accepting `TelegramReplyPayload` (which is assignable to
 * `unknown`); the channel-internal `sendReply` casts back at the boundary.
 */
export interface TelegramReplyPayload {
  /** Plain or formatted text body. Splitter respects `capabilities.maxMessageLength`. */
  text: string;
  /** Channel decides how to send (HTML parsing vs. plain). */
  format?: 'plain' | 'html' | 'markdown';
  /**
   * Optional inline keyboard rows (e.g. `clarify` options). Each button has a
   * label and a `callbackData` string the channel will receive on tap.
   */
  inlineButtons?: Array<Array<{ label: string; callbackData: string }>>;
  /**
   * If true, the channel must split into multiple sends to respect length
   * limits. Renderers mostly leave this `false` — the dispatcher's chunking
   * step decides.
   */
  preChunked?: boolean;
}
