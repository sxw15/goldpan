export interface FormatResetData {
  archived: boolean;
  language: 'en' | 'zh';
}

/** Telegram's plain-text formatter for `/reset`. Byte-identical to Phase 1. */
export function formatResetText(data: FormatResetData): string {
  return data.archived
    ? 'Done. The next message starts a fresh conversation.'
    : 'No active conversation. The next message will start a fresh one.';
}
