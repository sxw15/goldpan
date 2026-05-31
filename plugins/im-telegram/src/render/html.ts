import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'code',
  'pre',
  'a',
  'br',
];
const ALLOWED_ATTRS = { a: ['href'] };

export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Convert markdown into the small subset of HTML Telegram supports. */
export function markdownToTelegramHtml(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  // Strip paragraph wrappers — Telegram renders <p> as blank space
  const noParagraphs = raw.replace(/<\/?p>/g, '');
  return sanitizeHtml(noParagraphs, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    // Telegram prefers <b>/<i> over <strong>/<em>
    transformTags: {
      strong: 'b',
      em: 'i',
      ins: 'u',
      strike: 's',
      del: 's',
    },
    // Telegram uses <br> not <br/>
    selfClosing: [],
  }).trim();
}
