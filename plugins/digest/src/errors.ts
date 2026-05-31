export type DigestErrorCode =
  | 'preset_not_found'
  | 'preset_channel_mismatch'
  | 'preset_in_use'
  | 'subscription_not_found'
  | 'generation_failed'
  | 'plugin_disabled'
  | 'channel_not_connected'
  | 'regenerator_not_attached';

export class DigestGenerateError extends Error {
  constructor(
    public readonly code: DigestErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DigestGenerateError';
  }
}
