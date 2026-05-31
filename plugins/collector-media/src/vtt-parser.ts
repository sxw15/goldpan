const TIMESTAMP_LINE = /^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/;
const INLINE_TAG = /<\/?[a-z][^>]*>|<\d{2}:\d{2}:\d{2}\.\d{3}>/gi;

/**
 * Auto captions from YouTube emit cue N as a prefix-extension of cue N-1
 * (rolling window); applying the same dedup to manual subtitles eats real
 * content where consecutive cues happen to share prefixes.
 */
export function parseVtt(content: string, kind: 'manual' | 'auto' = 'auto'): string {
  const lines = content.split(/\r?\n/);
  const cues: string[] = [];
  let i = 0;

  if (lines[i]?.startsWith('WEBVTT')) {
    i++;
    while (i < lines.length && lines[i].trim() !== '') i++;
  }

  while (i < lines.length) {
    const line = lines[i].trim();
    i++;
    if (line === '') continue;

    if (line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) {
      while (i < lines.length && lines[i].trim() !== '') i++;
      continue;
    }

    if (TIMESTAMP_LINE.test(line)) {
      const cueLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        cueLines.push(lines[i].trim());
        i++;
      }
      const cueText = cueLines.join(' ').replace(INLINE_TAG, '').trim();
      if (cueText) cues.push(cueText);
    }
  }

  if (kind !== 'auto') return cues.join(' ').trim();

  const deduped: string[] = [];
  let prev = '';
  for (const cue of cues) {
    if (cue.startsWith(prev) && prev.length > 0) {
      const delta = cue.slice(prev.length).trim();
      if (delta) deduped.push(delta);
    } else {
      deduped.push(cue);
    }
    prev = cue;
  }
  return deduped.join(' ').trim();
}
