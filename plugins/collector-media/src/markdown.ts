export interface VideoData {
  title: string;
  uploader: string;
  channel: string;
  /** yt-dlp upload_date (YYYYMMDD) */
  uploadDate: string;
  durationSec: number;
  webpageUrl: string;
  description: string;
  transcript: string;
  subtitleLang: string;
  subtitleKind: 'manual' | 'auto';
}

function formatDate(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function humanizeDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

export function formatVideoMarkdown(data: VideoData): string {
  const lines: string[] = [];
  lines.push(`# ${data.title}`);
  lines.push('');
  lines.push(`- **Uploader**: ${data.uploader}`);
  lines.push(`- **Channel**: ${data.channel}`);
  lines.push(`- **Published**: ${formatDate(data.uploadDate)}`);
  lines.push(`- **Duration**: ${humanizeDuration(data.durationSec)}`);
  lines.push(`- **URL**: ${data.webpageUrl}`);
  lines.push('');
  if (data.description.trim()) {
    lines.push('## Description');
    lines.push('');
    lines.push(data.description.trim());
    lines.push('');
  }
  lines.push(`## Transcript (${data.subtitleLang}, ${data.subtitleKind})`);
  lines.push('');
  lines.push(data.transcript.trim());
  lines.push('');
  return lines.join('\n');
}
