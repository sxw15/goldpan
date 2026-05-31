import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { CollectorError } from '../../errors';

export interface ParseResult {
  /** Article content as Markdown */
  content: string;
  /** Article title */
  title: string | null;
  /** Author/byline */
  author: string | null;
  /** Published time (from meta tags) */
  publishedAt: string | null;
}

/**
 * Parse HTML and extract article content as Markdown.
 * Uses JSDOM for DOM creation, Readability for article extraction,
 * and Turndown for HTML→Markdown conversion.
 *
 * @throws {CollectorError} PARSE_FAILED if Readability cannot extract content
 */
// Heuristic threshold: Readability sometimes "succeeds" on trivial content
// (a single nav link, a cookie banner) — if the extracted plain text is shorter
// than this we treat it as a failed extraction (PARSE_FAILED). This is a
// PARSER-internal "did we get a real article body" check, distinct from the
// pipeline's user-facing minimum-content rule (GOLDPAN_MIN_CONTENT_LENGTH,
// enforced in pipeline/steps/collecting.ts). They are deliberately decoupled:
// this one guards Readability output quality and stays a fixed constant; the
// other is the operator-tunable business floor for what's worth processing.
const MIN_EXTRACTED_TEXT_LENGTH = 50;

export function parseHtml(html: string, url: string): ParseResult {
  const dom = new JSDOM(html, { url });
  try {
    const doc = dom.window.document;

    // Capture fallback title before Readability mutates the DOM
    const fallbackTitle = doc.title || doc.querySelector('h1')?.textContent || null;

    const reader = new Readability(doc);
    const article = reader.parse();

    if (!article?.content) {
      throw new CollectorError('Failed to extract article content', 'PARSE_FAILED', false);
    }

    // Readability may return trivial content (e.g. a single nav link).
    // Verify the extracted text has meaningful length.
    if (article.textContent && article.textContent.trim().length < MIN_EXTRACTED_TEXT_LENGTH) {
      throw new CollectorError('Failed to extract article content', 'PARSE_FAILED', false);
    }

    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });
    const markdown = turndown.turndown(article.content);

    const title = article.title || fallbackTitle;

    return {
      content: markdown,
      title,
      author: article.byline || null,
      publishedAt: article.publishedTime || null,
    };
  } finally {
    dom.window.close();
  }
}
