'use client';
import type { DigestChannelSlot, DigestDataSnapshot, DigestRenderPreset } from '@goldpan/web-sdk';
import { Fragment } from 'react';
import { CapturesSection } from './captures-section';
import { ConnectionsSection } from './connections-section';
import { DigestHero } from './digest-hero';
import { NewEntitiesSection } from './new-entities-section';
import { StatsSection } from './stats-section';
import { ThoughtsSection } from './thoughts-section';
import { TrackingFindingsSection } from './tracking-findings-section';

/**
 * Snapshot 没绑 preset (presetId IS NULL,backfill / 日 cron 行) 时的退化方案。
 * ai_summary 不在 slots 里:web 总把 AI summary 收到 Hero 顶端 (受
 * includeAiSummary 控制),slot 位置不重复渲染。
 * period: 'daily' —— 默认 cron 跑日报 ([digest.md]),周报需要显式 preset。
 */
const DEFAULT_RENDER_PRESET: DigestRenderPreset = {
  slots: ['tracking_findings', 'new_entities', 'thoughts', 'captures', 'stats'],
  skipEmpty: false,
  includeAiSummary: true,
  period: 'daily',
};

/** Discriminated by pageContext:share 模式无 Inspector,callback 在类型层就拿不到。 */
export type DigestSectionsProps =
  | {
      snapshot: DigestDataSnapshot;
      /** Render preset (slot order / skipEmpty / includeAiSummary). `null` → fallback default. */
      preset: DigestRenderPreset | null;
      pageContext: 'main';
      /** ms epoch lower bound;由 DigestShell 钉住,避免 Inspector toggle 触发 refetch。 */
      connectionsSinceMs: number;
      onOpenSource: (id: number) => void;
      onOpenEntity: (id: number) => void;
      /** Threaded through to DigestHero failed-state CTA so it links to /settings?channel=… */
      channel?: string;
    }
  | {
      snapshot: DigestDataSnapshot;
      preset: DigestRenderPreset | null;
      pageContext: 'share';
    };

export function DigestSections(props: DigestSectionsProps) {
  const { snapshot, preset, pageContext } = props;
  const { modules, aiSummary } = snapshot;
  const effective = preset ?? DEFAULT_RENDER_PRESET;
  const onOpenSource = pageContext === 'main' ? props.onOpenSource : undefined;
  const onOpenEntity = pageContext === 'main' ? props.onOpenEntity : undefined;
  const channel = pageContext === 'main' ? props.channel : undefined;

  const period = effective.period;

  function renderSlot(slot: DigestChannelSlot): React.ReactNode {
    switch (slot) {
      case 'tracking_findings': {
        if (effective.skipEmpty && modules.tracking_findings.items.length === 0) return null;
        return (
          <TrackingFindingsSection
            items={modules.tracking_findings.items}
            hasMore={modules.tracking_findings.hasMore}
            hiddenCount={modules.tracking_findings.hiddenCount}
            onOpenSource={onOpenSource}
            period={period}
          />
        );
      }
      case 'new_entities': {
        if (effective.skipEmpty && modules.new_entities.items.length === 0) return null;
        return (
          <NewEntitiesSection
            items={modules.new_entities.items}
            hasMore={modules.new_entities.hasMore}
            hiddenCount={modules.new_entities.hiddenCount}
            onOpenEntity={onOpenEntity}
            period={period}
          />
        );
      }
      case 'thoughts': {
        if (effective.skipEmpty && modules.thoughts.items.length === 0) return null;
        return (
          <ThoughtsSection
            items={modules.thoughts.items}
            hasMore={modules.thoughts.hasMore}
            hiddenCount={modules.thoughts.hiddenCount}
            onOpenSource={onOpenSource}
            period={period}
          />
        );
      }
      case 'captures': {
        if (effective.skipEmpty && modules.captures.items.length === 0) return null;
        return (
          <CapturesSection
            items={modules.captures.items}
            hasMore={modules.captures.hasMore}
            hiddenCount={modules.captures.hiddenCount}
            onOpenSource={onOpenSource}
            period={period}
          />
        );
      }
      case 'stats': {
        const s = modules.stats;
        if (effective.skipEmpty && s.captures + s.findings + s.thoughts + s.entities === 0) {
          return null;
        }
        return (
          <StatsSection
            captures={s.captures}
            findings={s.findings}
            thoughts={s.thoughts}
            entities={s.entities}
            period={period}
          />
        );
      }
      case 'ai_summary':
        // AI summary 在 Hero 顶端渲染（受 includeAiSummary 控制），slot 位置不重复。
        return null;
      default: {
        // 编译期 never 守 DigestChannelSlot 新增 variant；运行时回退 null —
        // 否则 web 与 SDK 跨版本部署时会把 slot 字符串作为 text node 渲染到 DOM。
        const _exhaustive: never = slot;
        void _exhaustive;
        return null;
      }
    }
  }

  return (
    <div className="gp-digest-sections">
      {effective.includeAiSummary && (
        <DigestHero text={aiSummary.text} status={aiSummary.status} channel={channel} />
      )}
      {effective.slots.map((slot, idx) => {
        const node = renderSlot(slot);
        if (node === null) return null;
        // slot 唯一性由 server zod schema 保障 (PresetInputSchema slots refine);
        // 万一有遗漏的写入路径绕过校验,key 加 idx 兜底防 React 双渲染 / 冲突。
        // biome-ignore lint/suspicious/noArrayIndexKey: idx 是 slot 重复时的兜底,不是主 key
        return <Fragment key={`${slot}-${idx}`}>{node}</Fragment>;
      })}
      {pageContext === 'main' && (
        <ConnectionsSection sinceMs={props.connectionsSinceMs} onOpenEntity={props.onOpenEntity} />
      )}
    </div>
  );
}
