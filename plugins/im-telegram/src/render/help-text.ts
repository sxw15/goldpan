export interface FormatHelpData {
  commands: ReadonlyArray<{ name: string; description: string }>;
  intents: ReadonlyArray<{ name: string; description: string }>;
  language: 'en' | 'zh';
}

/**
 * Telegram's plain-text formatter for `/help`. Byte-identical to the Phase 1
 * `dispatcher.runBuiltIn('help')` output so the user-visible surface does not
 * change when Layer A stops rendering the command itself.
 *
 * `language` is currently ignored — Phase 1 always emitted English. Future
 * localization can branch on `data.language`.
 */
export function formatHelpText(data: FormatHelpData): string {
  const lines: string[] = ['Available commands:'];
  for (const c of data.commands) {
    lines.push(`  /${c.name} — ${c.description}`);
  }
  if (data.intents.length > 0) {
    lines.push('', 'Available intents:');
    for (const decl of data.intents) {
      lines.push(`  ${decl.name} — ${decl.description}`);
    }
  }
  return lines.join('\n');
}
