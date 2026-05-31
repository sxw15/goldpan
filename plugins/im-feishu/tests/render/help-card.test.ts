import { describe, expect, it } from 'vitest';
import { renderHelpCard } from '../../src/render/help-card.js';

describe('renderHelpCard', () => {
  it('renders a card with each command and intent as its own block', () => {
    const card = renderHelpCard({
      commands: [
        { name: 'ask', description: 'Ask a question.' },
        { name: 'help', description: 'Show this menu.' },
      ],
      intents: [{ name: 'summarize_recent', description: 'Summarize recent.' }],
      language: 'en',
    });
    expect(card.kind).toBe('interactive');
    const json = JSON.stringify(card.card);
    expect(json).toContain('/ask');
    expect(json).toContain('Ask a question.');
    expect(json).toContain('/help');
    expect(json).toContain('summarize_recent');
    expect(json).toContain('Summarize recent.');
  });

  it('omits the intents section when empty', () => {
    const card = renderHelpCard({
      commands: [{ name: 'ask', description: 'Ask a question.' }],
      intents: [],
      language: 'en',
    });
    const json = JSON.stringify(card.card);
    expect(json).not.toContain('summarize_recent');
  });

  it('uses Chinese header when language=zh', () => {
    const card = renderHelpCard({
      commands: [{ name: 'ask', description: 'desc' }],
      intents: [],
      language: 'zh',
    });
    const json = JSON.stringify(card.card);
    expect(json).toContain('命令列表');
  });
});

describe('renderResetCard', () => {
  it('renders archived and no-active variants', async () => {
    const { renderResetCard } = await import('../../src/render/reset-card.js');
    const archived = renderResetCard({ archived: true, language: 'en' });
    expect(JSON.stringify(archived.card)).toContain('Conversation reset');
    const noop = renderResetCard({ archived: false, language: 'en' });
    expect(JSON.stringify(noop.card)).toContain('No active conversation');
  });
});
