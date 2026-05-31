/**
 * Strategy Z (spec §6.2.5): remove only high-frequency, zero-value noise
 * (shields.io family badges + HTML comments). Preserve HTML tags, tables,
 * <details>, emoji shortcodes — the extractor LLM handles those contextually.
 */
const SHIELDS_IO_WRAPPED = /\[!\[[^\]]*\]\(https:\/\/img\.shields\.io\/[^)]*\)\]\([^)]*\)/g;
const SHIELDS_IO_BARE = /!\[[^\]]*\]\(https:\/\/img\.shields\.io\/[^)]*\)/g;

const BADGE_HOST_PATTERNS = [
  'badgen\\.net',
  'badge\\.fury\\.io',
  'travis-ci\\.(org|com)',
  'circleci\\.com',
  'github\\.com/.+/(workflows|actions)/.+/badge\\.svg',
  'codecov\\.io/gh/[^)]+\\.svg',
  'coveralls\\.io/repos/[^)]+\\.svg',
  'snyk\\.io/test/github/[^)]+/badge\\.svg',
];

const BADGE_PATTERNS = BADGE_HOST_PATTERNS.flatMap((pattern) => [
  new RegExp(`\\[!\\[[^\\]]*\\]\\(https:\\/\\/${pattern}[^)]*\\)\\]\\([^)]*\\)`, 'g'),
  new RegExp(`!\\[[^\\]]*\\]\\(https:\\/\\/${pattern}[^)]*\\)`, 'g'),
]);

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const TRIPLE_NEWLINES = /\n{3,}/g;

export function cleanReadmeForExtraction(raw: string): string {
  let cleaned = raw.replace(SHIELDS_IO_WRAPPED, '').replace(SHIELDS_IO_BARE, '');
  for (const pattern of BADGE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  cleaned = cleaned.replace(HTML_COMMENT, '').replace(TRIPLE_NEWLINES, '\n\n');
  return cleaned.trim();
}
