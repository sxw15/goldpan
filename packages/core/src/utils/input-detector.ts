export interface InputDetectionResult {
  hasUrl: boolean;
  extractedUrl?: string;
  userAnnotation?: string;
  warnings?: string[];
  /** Number of URLs found in input (set when > 1) */
  urlCount?: number;
}

const URL_PATTERN = /https?:\/\/[^\s"'，。、；：！？\u201C\u201D\u2018\u2019（）【】《》<>]+/gi;
const TRAILING_PUNCT = /[.,;:!?"']+$/;

function cleanUrlBoundary(raw: string): string {
  let url = raw;
  url = url.replace(TRAILING_PUNCT, '');
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    let depth = 0;
    for (let i = 0; i < url.length; i++) {
      if (url[i] === open) depth++;
      else if (url[i] === close) {
        depth--;
        if (depth < 0) {
          url = url.slice(0, i);
          break;
        }
      }
    }
  }
  return url;
}

export function detectInputUrl(rawInput: string): InputDetectionResult {
  const trimmed = rawInput.trim();
  if (!trimmed) return { hasUrl: false };

  const matches = [...trimmed.matchAll(URL_PATTERN)];
  if (matches.length === 0) return { hasUrl: false };

  const firstMatch = matches[0];
  const extractedUrl = cleanUrlBoundary(firstMatch[0]);
  const matchStart = firstMatch.index ?? 0;

  const before = trimmed.slice(0, matchStart).trim();
  const after = trimmed
    .slice(matchStart + extractedUrl.length)
    .replace(/^[.,;:!?"')\]}>]+/, '')
    .trim();

  const cleanBefore = before.replace(URL_PATTERN, '').replace(/\s+/g, ' ').trim();
  const cleanAfter = after.replace(URL_PATTERN, '').replace(/\s+/g, ' ').trim();

  let annotation: string | undefined;
  if (cleanBefore && cleanAfter) {
    annotation = `${cleanBefore} ${cleanAfter}`;
  } else if (cleanBefore) {
    annotation = cleanBefore;
  } else if (cleanAfter) {
    annotation = cleanAfter;
  }

  const warnings: string[] | undefined =
    matches.length > 1
      ? [
          `Input contains multiple URLs (${matches.length} total), only the first one will be processed`,
        ]
      : undefined;

  return {
    hasUrl: true,
    extractedUrl,
    userAnnotation: annotation || undefined,
    warnings,
    urlCount: matches.length > 1 ? matches.length : undefined,
  };
}
