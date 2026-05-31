import { describe, expect, it } from 'vitest';
import { CommandParser, defaultCommands } from '../../src/inbound/command-parser.js';

describe('CommandParser.parse', () => {
  const p = new CommandParser({ botUsername: 'mybot' });

  it('parses a leading slash command', () => {
    expect(p.parse('/ask what is X?')).toEqual({
      name: 'ask',
      args: 'what is X?',
      raw: '/ask what is X?',
    });
  });

  it('parses bare command without args', () => {
    expect(p.parse('/reset')).toEqual({ name: 'reset', args: '', raw: '/reset' });
  });

  it('strips telegram-style /cmd@botname suffix', () => {
    expect(p.parse('/help@mybot')).toEqual({ name: 'help', args: '', raw: '/help@mybot' });
  });

  it('returns null for non-commands', () => {
    expect(p.parse('hello there')).toBeNull();
    expect(p.parse('  /')).toBeNull();
    expect(p.parse('not /a command')).toBeNull();
  });

  it('lowercases the command name', () => {
    expect(p.parse('/Ask hi')?.name).toBe('ask');
  });

  it('ignores commands addressed to a different bot', () => {
    expect(p.parse('/ask@otherbot hi')).toBeNull();
  });

  it('detects commands addressed to a different bot', () => {
    expect(p.isForeignCommand('/ask@otherbot hi')).toBe(true);
    expect(p.isForeignCommand('/ask@mybot hi')).toBe(false);
    expect(p.isForeignCommand('hello there')).toBe(false);
  });
});

describe('defaultCommands', () => {
  it('exposes the Layer-A-owned commands (P3 adds /release + /cancel for buffered_wait UX)', () => {
    const names = defaultCommands.map((c) => c.name).sort();
    expect(names).toEqual(['ask', 'cancel', 'help', 'note', 'release', 'reset', 'save']);
  });

  it('marks /release and /cancel as built-ins so the dispatcher handles them, not a plugin', () => {
    expect(defaultCommands.find((c) => c.name === 'release')?.builtIn).toBe('release');
    expect(defaultCommands.find((c) => c.name === 'cancel')?.builtIn).toBe('cancel');
  });

  it('binds /ask to the query intent', () => {
    expect(defaultCommands.find((c) => c.name === 'ask')?.boundIntent).toBe('query');
  });

  it('binds /note to record_thought', () => {
    expect(defaultCommands.find((c) => c.name === 'note')?.boundIntent).toBe('record_thought');
  });

  it('binds /save to submit_url', () => {
    expect(defaultCommands.find((c) => c.name === 'save')?.boundIntent).toBe('submit_url');
  });

  it('marks /help and /reset as built-ins', () => {
    expect(defaultCommands.find((c) => c.name === 'help')?.builtIn).toBe('help');
    expect(defaultCommands.find((c) => c.name === 'reset')?.builtIn).toBe('reset');
  });

  it('does NOT carry a /start entry (Telegram registers it as a commandOverride)', () => {
    expect(defaultCommands.find((c) => c.name === 'start')).toBeUndefined();
  });

  it('built-ins do NOT carry boundIntent (mutual exclusion)', () => {
    for (const name of ['help', 'reset'] as const) {
      expect(defaultCommands.find((c) => c.name === name)?.boundIntent).toBeUndefined();
    }
  });
});
