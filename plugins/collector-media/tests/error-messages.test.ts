import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGES } from '../src/error-messages';

describe('ERROR_MESSAGES', () => {
  const ctx = { siteName: 'YouTube', videoId: 'abc123', lang: 'en' };

  it('NOT_FOUND mentions site, videoId, and reason hints', () => {
    const msg = ERROR_MESSAGES.NOT_FOUND(ctx);
    expect(msg).toMatch(/youtube/i);
    expect(msg).toContain('abc123');
    expect(msg).toMatch(/deleted|private|not public/i);
  });

  it('INVALID_REQUEST hints at cookies env', () => {
    const msg = ERROR_MESSAGES.INVALID_REQUEST(ctx);
    expect(msg).toContain('GOLDPAN_YT_DLP_COOKIES_PATH');
  });

  it('CONTENT_EMPTY mentions language', () => {
    const msg = ERROR_MESSAGES.CONTENT_EMPTY({ ...ctx, lang: 'zh' });
    expect(msg).toMatch(/zh/);
    expect(msg).toMatch(/subtitle/i);
  });

  it('handles missing videoId gracefully', () => {
    const msg = ERROR_MESSAGES.NOT_FOUND({ siteName: 'Bilibili' });
    expect(msg).toMatch(/unknown id|bilibili/i);
    expect(msg).not.toContain('undefined');
  });

  it('error messages stay as English diagnostic strings (i18n is the web/IM layer, not the plugin)', () => {
    // Plugin-layer error messages travel via CollectorError.message and serve as
    // diagnostic identifiers, not user-facing UI text — the IM/web runtimes own
    // localization. Keeping these English avoids a translation dependency in
    // the plugin, while leaving the door open to message-key-based i18n later.
    const allMsgs = Object.entries(ERROR_MESSAGES).map(([, fn]) => fn(ctx));
    const cjkPattern = /[一-鿿㐀-䶿＀-￯]/u;
    for (const msg of allMsgs) {
      expect(msg).not.toMatch(cjkPattern);
    }
  });
});
