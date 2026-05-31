import { describe, expect, it } from 'vitest';
import { createIntentSchema } from './schema';

const INTENTS = [
  'submit_url',
  'submit_text',
  'record_thought',
  'query',
  'create_note',
  'create_tracking',
] as const;

describe('createIntentSchema (v2)', () => {
  const schema = createIntentSchema([...INTENTS]);

  it('parses execute decision with create_note + noteSubtype', () => {
    const ok = schema.parse({
      decision: 'execute',
      intent: 'create_note',
      noteSubtype: 'note',
      linkedSourceId: 42,
      relatedTo: null,
    });
    expect(ok.decision).toBe('execute');
    if (ok.decision === 'execute') {
      expect(ok.noteSubtype).toBe('note');
      expect(ok.linkedSourceId).toBe(42);
    }
  });

  it('parses wait decision with fallbackIntent + waitReason', () => {
    const ok = schema.parse({
      decision: 'wait',
      intent: 'create_note',
      fallbackIntent: 'create_note',
      maxWaitMs: 30000,
      waitReason: 'incomplete_command',
      relatedTo: null,
    });
    expect(ok.decision).toBe('wait');
    if (ok.decision === 'wait') {
      expect(ok.fallbackIntent).toBe('create_note');
      expect(ok.waitReason).toBe('incomplete_command');
    }
  });

  it('parses clarify decision with intentKey options', () => {
    const ok = schema.parse({
      decision: 'clarify',
      clarifyQuestionKey: 'ambiguous_intent',
      clarifyOptions: [{ intentKey: 'create_note' }, { intentKey: 'query', payload: 'about AI' }],
      relatedTo: null,
    });
    expect(ok.decision).toBe('clarify');
    if (ok.decision === 'clarify') {
      expect(ok.clarifyOptions).toHaveLength(2);
      expect(ok.clarifyOptions[0]?.intentKey).toBe('create_note');
    }
  });

  it('rejects wait with non-whitelist fallbackIntent', () => {
    expect(() =>
      schema.parse({
        decision: 'wait',
        intent: 'create_tracking',
        fallbackIntent: 'create_tracking', // 不在白名单
        maxWaitMs: 30000,
        waitReason: 'incomplete_command',
        relatedTo: null,
      }),
    ).toThrow();
  });

  it('rejects wait with maxWaitMs over 120000', () => {
    expect(() =>
      schema.parse({
        decision: 'wait',
        intent: 'create_note',
        fallbackIntent: 'create_note',
        maxWaitMs: 999999, // 超上限
        waitReason: 'incomplete_command',
        relatedTo: null,
      }),
    ).toThrow();
  });

  it('rejects clarify with fewer than 2 options', () => {
    expect(() =>
      schema.parse({
        decision: 'clarify',
        clarifyQuestionKey: 'ambiguous_intent',
        clarifyOptions: [{ intentKey: 'create_note' }],
        relatedTo: null,
      }),
    ).toThrow();
  });

  it('rejects empty intentNames at schema construction', () => {
    expect(() => createIntentSchema([])).toThrow(/at least one IntentPlugin/);
  });
});
