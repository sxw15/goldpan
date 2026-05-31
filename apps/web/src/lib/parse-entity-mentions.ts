// P7.3 — parse entity mentions from note content.
//
// Supported forms:
// - Simple: `@OpenAI`, `@公司` (ASCII word chars + CJK Unified Ideographs)
// - Bracketed: `@[Claude Code]`, `@[gpt-4o-mini]`, `@[Node.js]`
//
// Simple mentions intentionally require a boundary around the token so e-mail
// addresses (`alice@example.com`), package scopes (`@goldpan/core`), and partial
// hyphen/dot matches do not become false entity links. CALLER is responsible
// for deduplication + case-folding before SDK lookup; parser preserves source
// positions.

const SIMPLE_NAME_RE = /^[一-龥\w]+/u;
const SIMPLE_NAME_CHAR_RE = /^[A-Za-z0-9_一-龥]$/u;
const ASCII_WORD_CHAR_RE = /^[A-Za-z0-9_]$/u;

export interface EntityMention {
  /** Inclusive start index in source content (position of `@`). */
  start: number;
  /** Exclusive end index in source content (one past last char of name). */
  end: number;
  /** Raw name text without the leading `@`, original case preserved. */
  name: string;
}

export function parseEntityMentions(content: string): EntityMention[] {
  if (!content?.trim()) return [];
  const out: EntityMention[] = [];

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '@') continue;
    if (!hasLeftBoundary(content, i)) continue;

    if (content[i + 1] === '[') {
      const close = content.indexOf(']', i + 2);
      if (close === -1) continue;
      const name = content.slice(i + 2, close).trim();
      if (name) {
        out.push({ start: i, end: close + 1, name });
      }
      i = close;
      continue;
    }

    const m = SIMPLE_NAME_RE.exec(content.slice(i + 1));
    if (!m) continue;
    const end = i + 1 + m[0].length;
    if (!hasSimpleRightBoundary(content, end)) continue;
    out.push({
      start: i,
      end,
      name: m[0],
    });
    i = end - 1;
  }

  return out;
}

function hasLeftBoundary(content: string, atIndex: number): boolean {
  if (atIndex === 0) return true;
  const prev = content[atIndex - 1];
  // ASCII word chars immediately before `@` are overwhelmingly e-mail/userinfo
  // syntax (`alice@example.com`, `user:pass@example.com`). CJK before `@` is
  // allowed so Chinese text can write `关注@OpenAI`.
  if (ASCII_WORD_CHAR_RE.test(prev)) return false;
  return prev !== '.' && prev !== '-' && prev !== '/';
}

function hasSimpleRightBoundary(content: string, endIndex: number): boolean {
  const next = content[endIndex];
  if (next === undefined) return true;
  if (SIMPLE_NAME_CHAR_RE.test(next)) return false;
  if (next === '-' || next === '/' || next === '@') return false;
  // Sentence-ending periods are fine (`@OpenAI.`), but dotted identifiers or
  // domains (`@openai.com`, `@scope.pkg`) should not partial-match.
  if (next === '.' && SIMPLE_NAME_CHAR_RE.test(content[endIndex + 1] ?? '')) return false;
  return true;
}
