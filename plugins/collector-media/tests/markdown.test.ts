import { describe, expect, it } from 'vitest';
import { formatVideoMarkdown, type VideoData } from '../src/markdown';

const baseData: VideoData = {
  title: 'Software Architecture 101',
  uploader: 'Tech Channel',
  channel: 'Tech Channel Official',
  uploadDate: '20260101',
  durationSec: 4530, // 1h 15m 30s
  webpageUrl: 'https://www.youtube.com/watch?v=xyz',
  description: 'In this video we discuss...',
  transcript: 'Hello and welcome to the show.',
  subtitleLang: 'en',
  subtitleKind: 'manual',
};

describe('formatVideoMarkdown', () => {
  it('renders title as H1', () => {
    const md = formatVideoMarkdown(baseData);
    expect(md).toMatch(/^# Software Architecture 101$/m);
  });

  it('renders metadata as bullet list (not pseudo-table)', () => {
    const md = formatVideoMarkdown(baseData);
    expect(md).toMatch(/^- \*\*Uploader\*\*: Tech Channel$/m);
    expect(md).toMatch(/^- \*\*Channel\*\*: Tech Channel Official$/m);
    expect(md).toMatch(/^- \*\*Published\*\*: 2026-01-01$/m);
    expect(md).toMatch(/^- \*\*URL\*\*: https:\/\/www\.youtube\.com\/watch\?v=xyz$/m);
  });

  it('humanizes duration (4530s = 1h 15m 30s)', () => {
    const md = formatVideoMarkdown(baseData);
    expect(md).toMatch(/Duration\*\*: 1h 15m 30s/);
  });

  it('handles short duration (90s = 1m 30s)', () => {
    const md = formatVideoMarkdown({ ...baseData, durationSec: 90 });
    expect(md).toMatch(/Duration\*\*: 1m 30s/);
  });

  it('includes Transcript heading with kind/lang annotation', () => {
    const md = formatVideoMarkdown(baseData);
    expect(md).toMatch(/^## Transcript \(en, manual\)$/m);
  });

  it('omits Description heading when description is empty', () => {
    const md = formatVideoMarkdown({ ...baseData, description: '' });
    expect(md).not.toContain('## Description');
  });

  it('formats upload_date YYYYMMDD into YYYY-MM-DD', () => {
    expect(formatVideoMarkdown({ ...baseData, uploadDate: '20260315' })).toContain(
      'Published**: 2026-03-15',
    );
  });
});
