import { parseHtml } from '../builtin/collector-web/parser';
import { CollectorError } from '../errors';
import type { CollectorOutput } from '../types';

export function parseCollectedHtml(html: string, finalUrl: string): CollectorOutput {
  const parsed = parseHtml(html, finalUrl);

  if (!parsed.content.trim()) {
    throw new CollectorError('Extracted content is empty', 'CONTENT_EMPTY', false);
  }

  const metadata: Record<string, unknown> = {
    collector_finalUrl: finalUrl,
  };
  if (parsed.author) metadata.collector_author = parsed.author;
  if (parsed.publishedAt) metadata.collector_publishedAt = parsed.publishedAt;

  return {
    content: parsed.content,
    title: parsed.title,
    metadata,
    finalUrl,
  };
}
