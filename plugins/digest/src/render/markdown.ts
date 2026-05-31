import type { Language } from '@goldpan/core/i18n';
import type {
  AiSummaryData,
  CapturesModule,
  ChannelSlot,
  DataSnapshot,
  ModuleHasMore,
  NewEntitiesModule,
  StatsModule,
  ThoughtsModule,
  TrackingFindingsModule,
} from '../types.js';
import { isFullyEmpty } from './empty-state.js';
import { formatDate, HEADINGS, titleFor } from './helpers.js';

export interface RenderOptions {
  /** Slot order to render. Caller decides inclusion and sequence. */
  slots: ChannelSlot[];
  /** Output language. Controls headings and date formatting. */
  language: Language;
  /** When true, sections with zero items/counts are omitted entirely. */
  skipEmpty: boolean;
  /**
   * IANA timezone for per-entry date rendering (`formatDate`). Required so a
   * snapshot keyed by `yesterdayLocalISO(now, tz)` doesn't render its line
   * items in a different (host) tz — Docker UTC host + `GOLDPAN_TIMEZONE=
   * Asia/Shanghai` would otherwise drift entry dates by 8h relative to the
   * digest's own date key. Plumbed by every caller (push scheduler / intent
   * handler / service `renderMarkdown`).
   */
  tz: string;
}

/**
 * Render a digest snapshot to Markdown. The caller chooses slot order and
 * whether empty sections are skipped. If every requested slot is empty, a
 * single full-empty placeholder is emitted instead of a bare title.
 */
export function renderDigestMarkdown(snapshot: DataSnapshot, options: RenderOptions): string {
  const { slots, language, skipEmpty, tz } = options;
  const H = HEADINGS[language];
  const parts: string[] = [];

  parts.push(`# ${titleFor(snapshot.period, language)} — ${snapshot.digestId.date}`);

  // Full-empty short-circuit only makes sense when the caller also asked to
  // skip empty sections. If skipEmpty is false the caller explicitly wants
  // to see the section skeleton even when each slot is empty, so we render
  // each section with its empty-state placeholder instead.
  if (skipEmpty && isFullyEmpty(snapshot, slots)) {
    parts.push('');
    parts.push(H.full_empty);
    return `${parts.join('\n')}\n`;
  }

  for (const slot of slots) {
    const section = renderModule(slot, snapshot, language, skipEmpty, tz);
    if (section === null) continue;
    parts.push('');
    parts.push(section);
  }

  return `${parts.join('\n')}\n`;
}

function renderModule(
  slot: ChannelSlot,
  snapshot: DataSnapshot,
  language: Language,
  skipEmpty: boolean,
  tz: string,
): string | null {
  const H = HEADINGS[language];

  if (slot === 'ai_summary') {
    return renderAiSummary(snapshot.aiSummary, H.ai_summary, skipEmpty);
  }

  const mod = snapshot.modules[slot];
  if (!mod) return null;

  switch (mod.type) {
    case 'tracking_findings':
      return renderTrackingFindings(mod, language, skipEmpty, tz);
    case 'captures':
      return renderCaptures(mod, language, skipEmpty, tz);
    case 'thoughts':
      return renderThoughts(mod, language, skipEmpty, tz);
    case 'new_entities':
      return renderNewEntities(mod, language, skipEmpty, tz);
    case 'stats':
      return renderStats(mod, language, skipEmpty);
    default: {
      // Exhaustiveness check: unreachable if ModuleData is exhaustive.
      const _exhaustive: never = mod;
      void _exhaustive;
      return null;
    }
  }
}

function sectionHeader(title: string): string {
  return `## ${title}`;
}

function moreFooter(mod: ModuleHasMore, language: Language): string | null {
  if (!mod.hasMore || mod.hiddenCount <= 0) return null;
  return HEADINGS[language].more_footer(mod.hiddenCount);
}

function emptySectionOrNull(title: string, language: Language, skipEmpty: boolean): string | null {
  if (skipEmpty) return null;
  return `${sectionHeader(title)}\n\n${HEADINGS[language].empty_section}`;
}

function renderTrackingFindings(
  mod: TrackingFindingsModule,
  language: Language,
  skipEmpty: boolean,
  tz: string,
): string | null {
  const title = HEADINGS[language].tracking_findings;
  if (mod.items.length === 0) return emptySectionOrNull(title, language, skipEmpty);

  const lines = mod.items.map((it) => {
    const rulePart = it.ruleId !== null ? `rule #${it.ruleId}, ` : '';
    return `- [${it.title}](${it.url}) _(${rulePart}${formatDate(it.createdAt, language, tz)})_`;
  });
  const footer = moreFooter(mod, language);
  if (footer) lines.push('', footer);
  return `${sectionHeader(title)}\n\n${lines.join('\n')}`;
}

function renderCaptures(
  mod: CapturesModule,
  language: Language,
  skipEmpty: boolean,
  tz: string,
): string | null {
  const title = HEADINGS[language].captures;
  if (mod.items.length === 0) return emptySectionOrNull(title, language, skipEmpty);

  const lines = mod.items.map(
    (it) => `- [${it.title}](${it.url}) _(${formatDate(it.createdAt, language, tz)})_`,
  );
  const footer = moreFooter(mod, language);
  if (footer) lines.push('', footer);
  return `${sectionHeader(title)}\n\n${lines.join('\n')}`;
}

function renderThoughts(
  mod: ThoughtsModule,
  language: Language,
  skipEmpty: boolean,
  tz: string,
): string | null {
  const title = HEADINGS[language].thoughts;
  if (mod.items.length === 0) return emptySectionOrNull(title, language, skipEmpty);

  const lines = mod.items.map((it) => `- ${it.text} _(${formatDate(it.createdAt, language, tz)})_`);
  const footer = moreFooter(mod, language);
  if (footer) lines.push('', footer);
  return `${sectionHeader(title)}\n\n${lines.join('\n')}`;
}

function renderNewEntities(
  mod: NewEntitiesModule,
  language: Language,
  skipEmpty: boolean,
  tz: string,
): string | null {
  const title = HEADINGS[language].new_entities;
  if (mod.items.length === 0) return emptySectionOrNull(title, language, skipEmpty);

  const lines = mod.items.map((it) => {
    const desc = it.description ? ` — ${it.description}` : '';
    return `- **${it.name}**${desc} _(${formatDate(it.createdAt, language, tz)})_`;
  });
  const footer = moreFooter(mod, language);
  if (footer) lines.push('', footer);
  return `${sectionHeader(title)}\n\n${lines.join('\n')}`;
}

function renderStats(mod: StatsModule, language: Language, skipEmpty: boolean): string | null {
  const title = HEADINGS[language].stats;
  const allZero =
    mod.captures === 0 && mod.findings === 0 && mod.thoughts === 0 && mod.entities === 0;
  if (allZero) return emptySectionOrNull(title, language, skipEmpty);

  const H = HEADINGS[language];
  const lines = [
    `- ${H.captures}: ${mod.captures}`,
    `- ${H.tracking_findings}: ${mod.findings}`,
    `- ${H.thoughts}: ${mod.thoughts}`,
    `- ${H.new_entities}: ${mod.entities}`,
  ];
  return `${sectionHeader(title)}\n\n${lines.join('\n')}`;
}

function renderAiSummary(data: AiSummaryData, title: string, skipEmpty: boolean): string | null {
  const text = data.text.trim();
  if (text.length === 0) {
    if (skipEmpty) return null;
    return `${sectionHeader(title)}\n\n_(${data.status})_`;
  }
  return `${sectionHeader(title)}\n\n${text}`;
}
