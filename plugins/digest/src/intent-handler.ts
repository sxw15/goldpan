import type { DrizzleDB } from '@goldpan/core/db';
import type { DigestEngine } from './engine.js';
import { loadPluginPrompt } from './prompt-loader.js';
import { yesterdayLocalISO } from './render/helpers.js';
import { renderDigestMarkdown } from './render/markdown.js';
import type { DigestCrudService } from './service.js';
import type { ChannelSlot, DigestId } from './types.js';

export interface DigestQueryDeps {
  db: DrizzleDB;
  service: DigestCrudService;
  engine: DigestEngine;
  channel: string;
  language: 'en' | 'zh';
  /**
   * IANA timezone for computing "yesterday". Passed in from `execute()` where
   * `configStoreRef.getSnapshot().config.timezone` is the live source. Threaded
   * as a value (not a callback) because the handler runs synchronously inside
   * a single execute() call — no need for re-read on each access.
   */
  tz: string;
}

export async function handleDigestQuery(deps: DigestQueryDeps): Promise<{
  type: 'content';
  text: string;
  format: 'markdown';
}> {
  const defaultPreset = deps.service.listPresets(deps.channel).find((p) => p.isDefault) ?? null;
  const id: DigestId = {
    channel: deps.channel,
    date: yesterdayLocalISO(new Date(), deps.tz),
    presetId: defaultPreset?.id ?? null,
  };
  const result = await deps.engine.generate(id, {
    includeAiSummary: defaultPreset?.includeAiSummary ?? false,
  });
  const slots: ChannelSlot[] = defaultPreset?.slots ?? [
    'stats',
    'tracking_findings',
    'captures',
    'thoughts',
    'new_entities',
    'ai_summary',
  ];
  deps.service.saveGeneratedResult(result);
  const text = renderDigestMarkdown(result.snapshot, {
    language: deps.language,
    slots,
    skipEmpty: defaultPreset?.skipEmpty ?? true,
    tz: deps.tz,
  });
  return { type: 'content', text, format: 'markdown' };
}

export function disabledContent(language: 'en' | 'zh'): {
  type: 'content';
  text: string;
  format: 'markdown';
} {
  return {
    type: 'content',
    text:
      language === 'zh'
        ? '日报插件未启用。请在配置里设置 GOLDPAN_DIGEST_ENABLED=true 后重启。'
        : 'Digest plugin is disabled. Set GOLDPAN_DIGEST_ENABLED=true and restart.',
    format: 'markdown',
  };
}

// Ensure prompt-loader paths resolve even when digest is disabled (validates install).
export function validatePrompts(): void {
  loadPluginPrompt('digest_summary', false);
  loadPluginPrompt('digest_summary', true);
  loadPluginPrompt('digest_action_parser', false);
  loadPluginPrompt('digest_action_parser', true);
}
