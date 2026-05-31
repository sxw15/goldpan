import { describe, expect, it } from 'vitest';
import { SentMessageCache } from '../src/sent-message-cache.js';

describe('SentMessageCache', () => {
  it('markSent + wasSent round-trip', () => {
    const c = new SentMessageCache({ maxPerChat: 4 });
    c.markSent('oc_1', 'om_a');
    expect(c.wasSent('oc_1', 'om_a')).toBe(true);
    expect(c.wasSent('oc_1', 'om_other')).toBe(false);
    expect(c.wasSent('oc_2', 'om_a')).toBe(false);
  });

  it('per-chat capacity bound: oldest message ids evicted FIFO', () => {
    const c = new SentMessageCache({ maxPerChat: 3 });
    for (const id of ['om_1', 'om_2', 'om_3', 'om_4']) c.markSent('oc_1', id);
    expect(c.wasSent('oc_1', 'om_1')).toBe(false);
    expect(c.wasSent('oc_1', 'om_2')).toBe(true);
    expect(c.wasSent('oc_1', 'om_4')).toBe(true);
  });

  it('chats are independent (no cross-chat eviction)', () => {
    const c = new SentMessageCache({ maxPerChat: 2 });
    c.markSent('oc_1', 'a');
    c.markSent('oc_1', 'b');
    c.markSent('oc_2', 'x');
    c.markSent('oc_2', 'y');
    expect(c.wasSent('oc_1', 'a')).toBe(true);
    expect(c.wasSent('oc_2', 'x')).toBe(true);
  });

  it('double-marking the same messageId is a no-op (no duplicate-induced eviction)', () => {
    const c = new SentMessageCache({ maxPerChat: 2 });
    c.markSent('oc_1', 'a');
    c.markSent('oc_1', 'a');
    c.markSent('oc_1', 'b');
    expect(c.wasSent('oc_1', 'a')).toBe(true);
    expect(c.wasSent('oc_1', 'b')).toBe(true);
  });
});
