'use client';

import Link from 'next/link';
import { useState } from 'react';
import { BilingualText } from '@/components/ui/bilingual-text';
import type { ProcessingResultEntity } from '@/types/processing-result';
import { avatarColor, initialOf } from './utils';

export type EntityTabId = 'facts' | 'opinions' | 'summary' | 'meta';

export interface EntityCardLabels {
  newBadge: string;
  factsTab: string;
  opinionsTab: string;
  summaryTab: string;
  keywordsTab: string;
  factCountLabel: string;
  opinionCountLabel: string;
  noFacts: string;
  noOpinions: string;
  skippedFactsNote: (n: number) => string;
  copyAction: string;
  entityPageAction: string;
}

interface EntityCardProps {
  entity: ProcessingResultEntity;
  expanded: boolean;
  onToggle: () => void;
  defaultTab?: EntityTabId;
  labels: EntityCardLabels;
  onCopyEntity?: (e: ProcessingResultEntity) => void;
  /** When provided, hover actions render an "open entity page" link. */
  entityHref?: (e: ProcessingResultEntity) => string;
  mobile?: boolean;
}

export function EntityCard({
  entity,
  expanded,
  onToggle,
  defaultTab = 'facts',
  labels,
  onCopyEntity,
  entityHref,
  mobile,
}: EntityCardProps) {
  const [tab, setTab] = useState<EntityTabId>(defaultTab);
  const color = avatarColor(entity.entityId ?? entity.entityKey);
  const factCount = entity.newFactPoints.length;
  const opCount = entity.newOpinionPoints?.length ?? 0;
  const hasSummary = !!entity.summary;

  const tabs: Array<{ id: EntityTabId; label: string; n: number | null }> = [
    { id: 'facts', label: labels.factsTab, n: factCount },
    { id: 'opinions', label: labels.opinionsTab, n: opCount },
    ...(hasSummary
      ? [{ id: 'summary' as EntityTabId, label: labels.summaryTab, n: null as number | null }]
      : []),
    { id: 'meta', label: labels.keywordsTab, n: entity.keywords?.length ?? 0 },
  ];

  return (
    <article className="gp-td-entity" data-expanded={expanded ? 'true' : 'false'}>
      <button
        type="button"
        className="gp-td-entity__head"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span
          className="gp-td-entity__avatar"
          style={{ background: color.bg, color: color.fg }}
          aria-hidden="true"
        >
          {initialOf(entity.entityName)}
        </span>
        <span className="gp-td-entity__name-wrap">
          <span className="gp-td-entity__name">
            {entity.entityName}
            {entity.isNew && <span className="gp-td-entity__new-badge">{labels.newBadge}</span>}
          </span>
          <span className="gp-td-entity__path">{entity.categoryPath}</span>
        </span>
        <span className="gp-td-entity__counts" aria-hidden="true">
          <span
            className={`gp-td-entity__count${factCount === 0 ? ' gp-td-entity__count--zero' : ''}`}
          >
            <b>{factCount}</b>
            <span>{labels.factCountLabel}</span>
          </span>
          <span
            className={`gp-td-entity__count gp-td-entity__count--opinion${
              opCount === 0 ? ' gp-td-entity__count--zero' : ''
            }`}
          >
            <b>{opCount}</b>
            <span>{labels.opinionCountLabel}</span>
          </span>
        </span>
        <span className="gp-td-entity__chev" aria-hidden="true">
          ›
        </span>
      </button>

      {!mobile && (onCopyEntity || entityHref) && (
        <div className="gp-td-entity__hover-actions">
          {onCopyEntity && (
            <button
              type="button"
              className="gp-td-entity__hover-btn"
              onClick={(e) => {
                e.stopPropagation();
                onCopyEntity(entity);
              }}
            >
              ⧉ {labels.copyAction}
            </button>
          )}
          {entityHref && (
            <Link
              href={entityHref(entity)}
              className="gp-td-entity__hover-btn"
              onClick={(e) => e.stopPropagation()}
            >
              ↗ {labels.entityPageAction}
            </Link>
          )}
        </div>
      )}

      <div className="gp-td-entity__body-wrap" inert={!expanded}>
        <div className="gp-td-entity__body">
          <div className="gp-td-entity__tabs" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                className="gp-td-entity__tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.n != null && <small>{t.n}</small>}
              </button>
            ))}
          </div>

          {tab === 'facts' && (
            <>
              {factCount === 0 ? (
                <div className="gp-td-entity__skipped-note">{labels.noFacts}</div>
              ) : (
                <ul className="gp-td-kp-list">
                  {entity.newFactPoints.map((f) => (
                    <li key={f.pointKey} className="gp-td-kp">
                      <BilingualText
                        className="gp-td-kp__content"
                        original={f.content}
                        translated={f.contentTranslated}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {entity.skippedFactCount > 0 && (
                <div className="gp-td-entity__skipped-note">
                  {labels.skippedFactsNote(entity.skippedFactCount)}
                </div>
              )}
            </>
          )}

          {tab === 'opinions' &&
            (opCount === 0 ? (
              <div className="gp-td-entity__skipped-note">{labels.noOpinions}</div>
            ) : (
              <ul className="gp-td-kp-list">
                {(entity.newOpinionPoints ?? []).map((o) => (
                  <li key={o.pointKey} className="gp-td-kp gp-td-kp--opinion">
                    <BilingualText
                      className="gp-td-kp__content"
                      original={o.content}
                      translated={o.contentTranslated}
                    />
                  </li>
                ))}
              </ul>
            ))}

          {tab === 'summary' && hasSummary && (
            <BilingualText
              as="p"
              className="gp-td-entity__summary"
              original={entity.summary ?? ''}
              translated={entity.summaryTranslated}
            />
          )}

          {tab === 'meta' && (
            <div className="gp-td-entity__keywords">
              {(entity.keywords ?? []).map((k) => (
                <span key={k} className="gp-td-entity__kw">
                  {k}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
