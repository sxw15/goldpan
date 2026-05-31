'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { ConfirmModal } from '@/components/confirm-modal';
import type { ToastInput } from '@/components/toast-stack';
import { useTz } from '@/components/tz-provider';
import { Hero } from '@/components/ui/hero';
import { copyToClipboard } from '@/lib/clipboard';
import type { ProcessingResult } from '@/types/processing-result';
import { ClassificationStrip } from './classification';
import { EntityCard } from './entity-card';
import { KpDrawer } from './kp-drawer';
import { MobileBar } from './mobile-bar';
import { StatsCard } from './stats-card';
import { StickyBar } from './sticky-bar';
import {
  downloadTextFile,
  entitiesToClipboard,
  entitiesToMarkdown,
  totalAcceptedKp,
} from './utils';

export interface DoneViewProps {
  taskId: number;
  sourceUrl: string | null;
  createdAt: number | null;
  runtime?: string | null;
  sourceKindLabel: string;
  result: ProcessingResult;
  showDiscard: boolean;
  isDiscarded: boolean;
  isDiscarding: boolean;
  onDiscardConfirm: () => void;
  toast: (t: ToastInput) => void;
  mobile?: boolean;
}

const FIRST_TAB = 'facts' as const;

export function DoneView({
  taskId,
  sourceUrl,
  createdAt,
  runtime,
  sourceKindLabel,
  result,
  showDiscard,
  isDiscarded,
  isDiscarding,
  onDiscardConfirm,
  toast,
  mobile,
}: DoneViewProps) {
  const t = useTranslations('task_detail');
  const td = useTranslations('task_detail.done');
  const tStatus = useTranslations('task.status');
  const tz = useTz();

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => {
    const first = result.entities[0]?.entityKey;
    return first ? new Set([first]) : new Set();
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  // If entity list changes (e.g. after polling refresh), keep at least the
  // first entity expanded so the user always lands on visible content.
  useEffect(() => {
    setExpandedKeys((prev) => {
      if (prev.size > 0) return prev;
      const first = result.entities[0]?.entityKey;
      return first ? new Set([first]) : new Set();
    });
  }, [result.entities]);

  const toggle = (key: string) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const expandAll = () => setExpandedKeys(new Set(result.entities.map((e) => e.entityKey)));
  const collapseAll = () => setExpandedKeys(new Set());
  const allExpanded =
    result.entities.length > 0 && result.entities.every((e) => expandedKeys.has(e.entityKey));

  const totalKp = totalAcceptedKp(result);

  const handleCopyAll = async () => {
    const text = entitiesToClipboard(result);
    const ok = await copyToClipboard(text);
    toast({
      msg: ok ? td('toast_copied_all', { count: totalKp }) : td('toast_copy_failed'),
      kind: ok ? 'success' : 'danger',
    });
  };

  const handleExportMd = () => {
    const md = entitiesToMarkdown(taskId, result);
    downloadTextFile(`task-${taskId}.md`, md);
    toast({ msg: td('toast_exported', { taskId }), kind: 'success' });
  };

  const handleCopyEntity = async (e: ProcessingResult['entities'][number]) => {
    const lines: string[] = [`## ${e.entityName}`];
    if (e.summary) lines.push(`> ${e.summary}`);
    for (const f of e.newFactPoints) lines.push(`- ${f.content}`);
    for (const o of e.newOpinionPoints ?? []) lines.push(`- (opinion) ${o.content}`);
    const ok = await copyToClipboard(lines.join('\n'));
    toast({
      msg: ok
        ? td('toast_copied_entity', {
            name: e.entityName,
            count: e.newFactPoints.length + (e.newOpinionPoints?.length ?? 0),
          })
        : td('toast_copy_failed'),
      kind: ok ? 'success' : 'danger',
    });
  };

  const locale = useLocale();
  const heroMeta: Array<{ label: string; value: string }> = [];
  if (createdAt != null)
    heroMeta.push({
      label: td('meta_created'),
      value: new Date(createdAt).toLocaleString(locale, { timeZone: tz }),
    });
  if (runtime) heroMeta.push({ label: td('meta_runtime'), value: runtime });
  if (sourceKindLabel) heroMeta.push({ label: td('meta_source'), value: sourceKindLabel });

  return (
    <div className={`gp-td-page${mobile ? ' gp-td-page--mobile' : ''}`}>
      <StickyBar
        status="done"
        taskId={taskId}
        backHref="/library"
        backLabel={td('back')}
        taskCrumbLabel={td('crumb_task')}
        statusLabel={tStatus('done')}
        primaryMetric={td.rich('sticky_metric', {
          accepted: result.stats.accepted,
          skipped: result.stats.skipped,
          b: (ch) => <b>{ch}</b>,
        })}
        secondaryActions={
          mobile ? null : (
            <>
              <button
                type="button"
                className="gp-td-action"
                title={td('action_copy_all')}
                onClick={handleCopyAll}
              >
                ⧉
              </button>
              <button
                type="button"
                className="gp-td-action"
                title={td('action_export')}
                onClick={handleExportMd}
              >
                ↓
              </button>
            </>
          )
        }
        primaryAction={
          mobile ? null : (
            <button
              type="button"
              className="gp-td-action gp-td-action--primary"
              onClick={() => toast({ msg: td('toast_track_started'), kind: 'success' })}
            >
              {td('action_track')}
            </button>
          )
        }
      />

      <div className="gp-td-main">
        <Hero
          eyebrow={`${td('eyebrow_done')} · TASK #${taskId}`}
          title={result.source?.title ?? td('untitled_source')}
          sourceLabel={t('source_label_prefix')}
          sourceUrl={result.source?.originalUrl ?? sourceUrl}
          meta={heroMeta}
          toolbox={
            mobile ? null : (
              <>
                <button type="button" className="gp-td-action" onClick={handleCopyAll}>
                  ⧉ {td('action_copy_all')}
                </button>
                <button type="button" className="gp-td-action" onClick={handleExportMd}>
                  ↓ {td('action_export')}
                </button>
              </>
            )
          }
        />

        <StatsCard
          stats={result.stats}
          labels={{
            title: td('stats_label'),
            knowledgeUnit: td('stats_knowledge_unit'),
            sub: ({ extracted, rate, skipped }) => td('stats_sub', { extracted, rate, skipped }),
            extracted: td('stats_extracted'),
            skipped: td('stats_skipped'),
            droppedUnassigned: td('stats_dropped'),
            quarantined: td('stats_quarantined'),
            verifierRejected: td('stats_verifier_rejected'),
          }}
        />

        {result.classification && (
          <ClassificationStrip
            classification={result.classification}
            categoryLabel={td('classification_category')}
            keywordsLabel={td('classification_keywords')}
          />
        )}

        <div className="gp-td-section-title">
          <h2>
            {td('entities_title')}
            <small>· {result.entities.length}</small>
          </h2>
          <div className="gp-td-expand-bar">
            {totalKp > 0 && (
              <button
                type="button"
                className="gp-td-view-all-link"
                style={{ marginRight: 6 }}
                onClick={() => setDrawerOpen(true)}
              >
                {td('view_all_kp', { count: totalKp })} →
              </button>
            )}
            {result.entities.length > 0 && (
              <button
                type="button"
                className="gp-td-expand-bar__btn"
                onClick={allExpanded ? collapseAll : expandAll}
              >
                {allExpanded ? td('collapse_all') : td('expand_all')}
              </button>
            )}
          </div>
        </div>

        {result.entities.length > 0 ? (
          <div className="gp-td-entities">
            {result.entities.map((e) => (
              <EntityCard
                key={e.entityKey}
                entity={e}
                expanded={expandedKeys.has(e.entityKey)}
                onToggle={() => toggle(e.entityKey)}
                defaultTab={FIRST_TAB}
                mobile={mobile}
                onCopyEntity={handleCopyEntity}
                entityHref={(en) => `/library?focus=${encodeURIComponent(en.entityKey)}`}
                labels={{
                  newBadge: td('entity_new'),
                  factsTab: td('entity_tab_facts'),
                  opinionsTab: td('entity_tab_opinions'),
                  summaryTab: td('entity_tab_summary'),
                  keywordsTab: td('entity_tab_keywords'),
                  factCountLabel: td('entity_count_facts'),
                  opinionCountLabel: td('entity_count_opinions'),
                  noFacts: td('entity_no_facts'),
                  noOpinions: td('entity_no_opinions'),
                  skippedFactsNote: (n: number) => td('entity_skipped_facts', { count: n }),
                  copyAction: td('entity_action_copy'),
                  entityPageAction: td('entity_action_page'),
                }}
              />
            ))}
          </div>
        ) : (
          <div className="gp-td-entity__skipped-note">{td('no_entities')}</div>
        )}

        {showDiscard && !isDiscarded && (
          <div className="gp-td-discard-row">
            <div className="gp-td-discard-row__text">
              {td.rich('discard_explainer', { b: (ch) => <b>{ch}</b> })}
            </div>
            <button
              type="button"
              className="gp-btn"
              data-variant="danger"
              onClick={() => setDiscardOpen(true)}
              disabled={isDiscarding}
            >
              {td('discard_cta')}
            </button>
          </div>
        )}
        {isDiscarded && <div className="gp-td-discard-tombstone">{td('discard_tombstone')}</div>}

        {mobile && (
          <MobileBar>
            <button
              type="button"
              className="gp-td-mobile-bar__btn gp-td-mobile-bar__btn--primary"
              onClick={() => toast({ msg: td('toast_track_started'), kind: 'success' })}
            >
              ★ {td('action_track')}
            </button>
            <button type="button" className="gp-td-mobile-bar__btn" onClick={handleCopyAll}>
              ⧉ {td('action_copy_short')}
            </button>
            <button type="button" className="gp-td-mobile-bar__btn" onClick={handleExportMd}>
              ↓ {td('action_export_short')}
            </button>
          </MobileBar>
        )}
      </div>

      <KpDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        result={result}
        labels={{
          title: (n) => td('drawer_title', { count: n }),
          subtitle: td('drawer_subtitle'),
          closeLabel: td('drawer_close'),
        }}
      />

      <ConfirmModal
        open={discardOpen}
        title={td('confirm_discard_title')}
        message={td('confirm_discard_msg', { count: result.stats.accepted })}
        confirmLabel={td('discard_cta')}
        cancelLabel={td('cancel')}
        danger
        onConfirm={() => {
          setDiscardOpen(false);
          onDiscardConfirm();
        }}
        onCancel={() => setDiscardOpen(false)}
      />
    </div>
  );
}
