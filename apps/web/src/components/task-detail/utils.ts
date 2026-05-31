import type { ProcessingResult, ProcessingResultEntity } from '@/types/processing-result';

const AVATAR_PALETTE = [
  { bg: '#fef3c7', fg: '#92400e' },
  { bg: '#dcfce7', fg: '#14532d' },
  { bg: '#dbeafe', fg: '#1e3a8a' },
  { bg: '#fce7f3', fg: '#831843' },
  { bg: '#ede9fe', fg: '#4c1d95' },
  { bg: '#ccfbf1', fg: '#134e4a' },
  { bg: '#ffe4e6', fg: '#881337' },
];

export function avatarColor(seed: number | string): { bg: string; fg: string } {
  if (typeof seed === 'number') {
    return AVATAR_PALETTE[Math.abs(seed) % AVATAR_PALETTE.length];
  }
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

export function initialOf(name: string): string {
  const stripped = (name || '').replace(/[“”"·]/g, '');
  return stripped[0] || '·';
}

export function entityKpCount(e: ProcessingResultEntity): number {
  return e.newFactPoints.length + (e.newOpinionPoints?.length ?? 0);
}

export function totalAcceptedKp(result: ProcessingResult): number {
  return result.entities.reduce((sum, e) => sum + entityKpCount(e), 0);
}

export function entitiesToClipboard(result: ProcessingResult): string {
  const lines: string[] = [];
  for (const e of result.entities) {
    lines.push(`## ${e.entityName}  [${e.categoryPath}]`);
    if (e.summary) lines.push(`> ${e.summary}`);
    for (const f of e.newFactPoints) lines.push(`- ${f.content}`);
    for (const o of e.newOpinionPoints ?? []) lines.push(`- (opinion) ${o.content}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

export function entitiesToMarkdown(taskId: number, result: ProcessingResult): string {
  const head = [
    `# Task #${taskId}`,
    result.source?.title ? `**${result.source.title}**` : '',
    result.source?.originalUrl ? `<${result.source.originalUrl}>` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
  return `${head}\n${entitiesToClipboard(result)}\n`;
}

export function downloadTextFile(filename: string, content: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
