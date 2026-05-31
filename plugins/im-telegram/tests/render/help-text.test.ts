import { describe, expect, it, vi } from 'vitest';
import { createTelegramAdapter } from '../../src/adapter.js';

describe('Telegram buildHelpReply (byte-identical to Phase 1 dispatcher output)', () => {
  it('produces the same text the Phase 1 dispatcher built for /help', () => {
    const adapter = createTelegramAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    const payload = adapter.buildHelpReply({
      commands: [
        { name: 'ask', description: 'Ask the knowledge base a question.' },
        { name: 'note', description: 'Record a thought / opinion.' },
        { name: 'save', description: 'Submit a URL to the knowledge base.' },
        { name: 'help', description: 'List available commands.' },
        {
          name: 'reset',
          description: 'Abort the current reply and start a fresh conversation.',
        },
      ],
      intents: [{ name: 'summarize_recent', description: 'Summarize recently added knowledge' }],
      language: 'en',
    });
    expect((payload as { text: string }).text).toBe(
      [
        'Available commands:',
        '  /ask — Ask the knowledge base a question.',
        '  /note — Record a thought / opinion.',
        '  /save — Submit a URL to the knowledge base.',
        '  /help — List available commands.',
        '  /reset — Abort the current reply and start a fresh conversation.',
        '',
        'Available intents:',
        '  summarize_recent — Summarize recently added knowledge',
      ].join('\n'),
    );
  });

  it('omits the intents section when there are no intents', () => {
    const adapter = createTelegramAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    const payload = adapter.buildHelpReply({
      commands: [{ name: 'ask', description: 'Ask a question.' }],
      intents: [],
      language: 'en',
    });
    expect((payload as { text: string }).text).toBe(
      'Available commands:\n  /ask — Ask a question.',
    );
  });
});

describe('Telegram buildResetReply (byte-identical to Phase 1 dispatcher output)', () => {
  it('returns the archived wording when archived=true', () => {
    const adapter = createTelegramAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    expect(
      (adapter.buildResetReply({ archived: true, language: 'en' }) as { text: string }).text,
    ).toBe('Done. The next message starts a fresh conversation.');
  });

  it('returns the no-active wording when archived=false', () => {
    const adapter = createTelegramAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    expect(
      (adapter.buildResetReply({ archived: false, language: 'en' }) as { text: string }).text,
    ).toBe('No active conversation. The next message will start a fresh one.');
  });
});
