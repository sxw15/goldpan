import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../src/i18n/loader.js';

describe('createTranslator', () => {
  it('returns english string for known InputErrorCode', () => {
    const t = createTranslator('en');
    expect(t('text_too_long', { maxLen: 4096 })).toBe(
      'Your message is too long (max 4096 characters).',
    );
  });

  it('returns chinese string for known InputErrorCode', () => {
    const t = createTranslator('zh');
    expect(t('text_too_long', { maxLen: 4096 })).toBe('消息太长（最长 4096 个字符）。');
  });

  it('renders the synthetic unknown code with message variable', () => {
    const t = createTranslator('en');
    expect(t('unknown', { message: 'oh no' })).toBe('Internal error: oh no');
  });

  it('falls back to the raw code when key is missing', () => {
    const t = createTranslator('en');
    expect(t('truly_made_up_code', {})).toBe('truly_made_up_code');
  });

  it('leaves placeholders intact when variable is missing', () => {
    const t = createTranslator('en');
    expect(t('unknown', {})).toBe('Internal error: $' + '{message}');
  });

  it('covers all 9 InputErrorCode values + synthetic unknown', () => {
    const t = createTranslator('en');
    const codes = [
      'input_empty',
      'text_too_long',
      'query_too_long',
      'input_too_long_for_intent',
      'intent_failed',
      'submit_failed',
      'query_failed',
      'unknown_intent',
      'plugin_error',
      'unknown',
    ];
    for (const c of codes) {
      const out = t(c, { maxLen: 99, message: 'm' });
      expect(out).not.toBe(c);
    }
  });

  it('covers all SubmitRejectCode values via submit_reject.* namespace', () => {
    const t = createTranslator('en');
    const codes = [
      'submit_reject.input_empty',
      'submit_reject.text_too_short',
      'submit_reject.text_too_long',
      'submit_reject.url_blocked',
      'submit_reject.url_invalid',
      'submit_reject.unknown',
    ];
    for (const c of codes) {
      const out = t(c, { maxLen: 99 });
      expect(out).not.toBe(c);
    }
  });
});
