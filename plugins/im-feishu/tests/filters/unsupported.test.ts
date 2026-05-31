import type { InboundMessage } from '@goldpan/im-runtime';
import { describe, expect, it } from 'vitest';
import { FeishuUnsupportedContentFilter } from '../../src/filters/unsupported.js';
import { createTranslator } from '../../src/i18n/loader.js';

const msg = (contentType: InboundMessage['contentType']): InboundMessage => ({
  channelId: 'feishu',
  accountId: 'cli_x',
  chatId: 'oc_1',
  userId: 'ou',
  platformMsgId: 'om_1',
  contentType,
  raw: null,
  receivedAt: new Date(),
});

describe('FeishuUnsupportedContentFilter', () => {
  const filter = new FeishuUnsupportedContentFilter({
    translator: createTranslator('en'),
  });

  it('passes text messages', () => {
    expect(filter.shouldHandle(msg('text'))).toEqual({ type: 'pass' });
  });

  it('short-circuits image / voice / file / video / other with the content type interpolated', () => {
    for (const ct of ['image', 'voice', 'file', 'video', 'other'] as const) {
      const decision = filter.shouldHandle(msg(ct));
      expect(decision.type).toBe('short_circuit');
      if (decision.type === 'short_circuit') {
        const reply = decision.reply as { kind: string; text: string };
        expect(reply.kind).toBe('text');
        // Regression guard: the actual contentType must appear in the reply so
        // the user knows which kind of message was rejected. A pre-rendered
        // filter message with an empty `${type}` substitution would fail here.
        expect(reply.text).toContain(ct);
        expect(reply.text).toMatch(/not yet supported/);
      }
    }
  });

  it('localizes per the translator passed at construction time', () => {
    const zhFilter = new FeishuUnsupportedContentFilter({ translator: createTranslator('zh') });
    const decision = zhFilter.shouldHandle(msg('image'));
    if (decision.type !== 'short_circuit') throw new Error('expected short_circuit');
    const reply = decision.reply as { text: string };
    expect(reply.text).toContain('image');
    expect(reply.text).toContain('暂不支持');
  });
});
