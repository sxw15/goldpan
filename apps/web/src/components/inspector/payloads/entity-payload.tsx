'use client';

import type { EntityDetail, NoteDetail } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useTz } from '@/components/tz-provider';
import { useEntityLinkedNotes } from '@/hooks/use-entity-linked-notes';
import type { FetchState } from '@/hooks/use-fetch-on-id-change';
import { useFetchOnIdChange } from '@/hooks/use-fetch-on-id-change';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { formatDateOnly } from '@/lib/format';
import { rethrowNextErrors } from '@/lib/rethrow';
import { safeHref } from '../../../lib/url';
import { GithubRepoCard } from '../../github-repo-card';
import { NoteCard } from '../../library/note-card';
import { StateEmpty } from '../../state/state-empty';
import { StateError } from '../../state/state-error';
import { StateLoading } from '../../state/state-loading';
import { BilingualText } from '../../ui/bilingual-text';
import type { InspectorPayload, PayloadAction, PayloadCapabilitySet } from './types';

interface EntityPayloadProps {
  id: number;
  onTitleReady: (title: string) => void;
  onNavigateEntity: (next: InspectorPayload) => void;
  onAction?: (action: PayloadAction) => Promise<void>;
  capabilities?: PayloadCapabilitySet;
}

const fetchEntity = (id: number, signal: AbortSignal) =>
  getBrowserApiClient().getEntity(id, signal);

export function EntityPayload({
  id,
  onTitleReady,
  onNavigateEntity,
  onAction,
  capabilities,
}: EntityPayloadProps) {
  const [trackError, setTrackError] = useState<Error | null>(null);
  const [trackPending, setTrackPending] = useState(false);
  const tState = useTranslations('state');
  const tInspector = useTranslations('inspector');
  const tEntity = useTranslations('entity_detail');
  const tSourceStatus = useTranslations('source.status');
  const tCommon = useTranslations('common');

  const { state, retry } = useFetchOnIdChange(id, fetchEntity, {
    onReady: (detail) => onTitleReady(detail.entity.name),
  });
  // P5 Fix Batch 5 (I4): linkedNotes hook 提升到外层组件 — 之前调用在
  // EntityPayloadBody 内，hasAnyContent 不算 linkedNotes 时只挂 note 的 sparse
  // entity 会被 StateEmpty 提前拦截、note section 永远不出现。把 hook 上提后
  // linkedNotes 加入 hasAnyContent 判定 + 同时给 I10 提供 linkedNotesState
  // 让 error 状态能渲染独立 UI（之前 status !== 'ready' 全部静默退化为空）。
  const { state: linkedNotesState, retry: retryLinkedNotes } = useEntityLinkedNotes(id);

  if (state.status === 'loading') return <StateLoading label={tState('loading_default')} />;
  if (state.status === 'error')
    return <StateError error={state.error} onRetry={retry} retryLabel={tState('retry')} />;

  const { entity, points, sources, relations, githubRepo } = state.data;
  const facts = points.filter((p) => p.type === 'fact' && p.status === 'active');
  const opinions = points.filter((p) => p.type === 'opinion' && p.status === 'active');
  const linkedNotes: NoteDetail[] =
    linkedNotesState.status === 'ready' ? linkedNotesState.data : [];

  // P5 Fix Batch 7 thread #7: include non-ready linkedNotesState so a sparse
  // entity whose `useEntityLinkedNotes` failed isn't short-circuited by
  // StateEmpty — that path needs to fall through to EntityPayloadBody so the
  // inline `linked_notes_load_failed` UI (added in I10) actually renders.
  // Loading state will briefly flash the Body before notes resolve, which is
  // preferable to the alternative (StateEmpty → Body content flash).
  const hasAnyContent =
    entity.categoryPaths.length > 0 ||
    Boolean(entity.description) ||
    entity.aliases.length > 0 ||
    entity.keywords.length > 0 ||
    facts.length > 0 ||
    opinions.length > 0 ||
    relations.length > 0 ||
    sources.length > 0 ||
    Boolean(githubRepo) ||
    linkedNotes.length > 0 ||
    linkedNotesState.status !== 'ready';

  const canTrack = Boolean(onAction) && (capabilities?.has('trackFromEntity') ?? false);
  const cta = canTrack ? (
    <>
      <button
        type="button"
        className="gp-entity-payload__track-cta gp-btn"
        data-variant="track"
        disabled={trackPending}
        aria-busy={trackPending}
        onClick={async () => {
          if (trackPending || !onAction) return;
          setTrackError(null);
          setTrackPending(true);
          try {
            await onAction({
              type: 'trackFromEntity',
              entityId: entity.id,
              entityName: entity.name,
            });
          } catch (err) {
            // NEXT_REDIRECT propagation: if the underlying handler does a server
            // `redirect()` (e.g. onUnauthorized), the redirect digest must
            // re-throw past this catch — otherwise Next swallows it and renders
            // a fake "track failed" message. `rethrowNextErrors` is a no-op for
            // plain errors so the degraded path still works.
            rethrowNextErrors(err);
            setTrackError(
              err instanceof Error ? err : Object.assign(new Error(String(err)), { cause: err }),
            );
          } finally {
            setTrackPending(false);
          }
        }}
      >
        ＋ {tEntity('track_cta')}
      </button>
      {trackError && (
        <p role="alert" className="gp-entity-payload__track-error">
          {trackError.message}
        </p>
      )}
    </>
  ) : null;

  // Action row: track CTA + decorative icon buttons (copy / export / edit).
  // Icons are placeholders matching the prototype affordance bar — wired up in
  // a later pass. They must coexist with the inline `track-error` paragraph.
  const actions = (
    <div className="gp-entity-payload__actions">
      {cta}
      <button
        type="button"
        className="gp-btn"
        data-variant="icon"
        data-size="sm"
        title={tEntity('action_copy')}
        aria-label={tEntity('action_copy')}
      >
        ⧉
      </button>
      <button
        type="button"
        className="gp-btn"
        data-variant="icon"
        data-size="sm"
        title={tEntity('action_export')}
        aria-label={tEntity('action_export')}
      >
        ↓
      </button>
      <button
        type="button"
        className="gp-btn"
        data-variant="icon"
        data-size="sm"
        title={tEntity('action_edit')}
        aria-label={tEntity('action_edit')}
      >
        ✎
      </button>
    </div>
  );

  if (!hasAnyContent) {
    return (
      <div className="gp-entity-payload">
        {actions}
        <StateEmpty title={tInspector('empty_entity_title')} />
      </div>
    );
  }

  return (
    <EntityPayloadBody
      id={id}
      entity={entity}
      facts={facts}
      opinions={opinions}
      relations={relations}
      sources={sources}
      githubRepo={githubRepo}
      linkedNotes={linkedNotes}
      linkedNotesState={linkedNotesState}
      retryLinkedNotes={retryLinkedNotes}
      onNavigateEntity={onNavigateEntity}
      tEntity={tEntity}
      tSourceStatus={tSourceStatus}
      tCommon={tCommon}
      actions={actions}
    />
  );
}

interface EntityPayloadBodyProps {
  id: number;
  entity: EntityDetail['entity'];
  facts: EntityDetail['points'];
  opinions: EntityDetail['points'];
  relations: EntityDetail['relations'];
  sources: EntityDetail['sources'];
  githubRepo: EntityDetail['githubRepo'];
  /** P5 Fix Batch 5 (I4/I10): linkedNotes 数据 + fetch state 由外层
   * EntityPayload 注入 — 之前在 Body 内调用 hook，导致 sparse entity 被
   * StateEmpty 拦截后 hook 永远不触发；同时把 retryLinkedNotes 透传下来供
   * I10 的 inline error 重试按钮调用。 */
  linkedNotes: NoteDetail[];
  linkedNotesState: FetchState<NoteDetail[]>;
  retryLinkedNotes: () => void;
  onNavigateEntity: (next: InspectorPayload) => void;
  tEntity: ReturnType<typeof useTranslations>;
  tSourceStatus: ReturnType<typeof useTranslations>;
  tCommon: ReturnType<typeof useTranslations>;
  actions: React.ReactNode;
}

type EntityTab = 'overview' | 'facts' | 'opinions' | 'relations';

function EntityPayloadBody({
  id,
  entity,
  facts,
  opinions,
  relations,
  sources,
  githubRepo,
  linkedNotes,
  linkedNotesState,
  retryLinkedNotes,
  onNavigateEntity,
  tEntity,
  tSourceStatus,
  tCommon,
  actions,
}: EntityPayloadBodyProps) {
  const [tab, setTab] = useState<EntityTab>('overview');
  const tz = useTz();

  const tabSpec: { id: EntityTab; label: string; count?: number }[] = [
    { id: 'overview', label: tEntity('tab_overview') },
    { id: 'facts', label: tEntity('tab_facts'), count: facts.length },
    { id: 'opinions', label: tEntity('tab_opinions'), count: opinions.length },
    { id: 'relations', label: tEntity('tab_relations'), count: relations.length },
  ];

  return (
    <div className="gp-entity-payload" data-active-tab={tab}>
      {entity.categoryPaths.length > 0 && (
        <p className="gp-entity-payload__category gp-entity-payload__path">
          {entity.categoryPaths.join(' / ')}
        </p>
      )}

      {actions}

      {entity.description && (
        <p className="gp-entity-payload__description gp-entity-desc" data-show-on="overview">
          <BilingualText original={entity.description} translated={entity.descriptionTranslated} />
        </p>
      )}

      <div className="gp-inspector-tabs" role="tablist">
        {tabSpec.map((s) => (
          <button
            key={s.id}
            type="button"
            className="gp-inspector-tabs__tab"
            role="tab"
            aria-selected={tab === s.id}
            onClick={() => setTab(s.id)}
          >
            {s.label}
            {typeof s.count === 'number' && (
              <span className="gp-inspector-tabs__count">{s.count}</span>
            )}
          </button>
        ))}
      </div>

      {entity.aliases.length > 0 && (
        <section className="gp-entity-payload__section gp-section-mini" data-show-on="overview">
          <h3 className="gp-entity-payload__section-title gp-section-mini__title">
            {tEntity('aliases')} <b>· {entity.aliases.length}</b>
          </h3>
          <ul className="gp-entity-payload__aliases gp-chip-row">
            {entity.aliases.map((a) => (
              <li key={a} className="gp-entity-payload__alias gp-chip">
                {a}
              </li>
            ))}
          </ul>
        </section>
      )}

      {entity.keywords.length > 0 && (
        <section className="gp-entity-payload__section gp-section-mini" data-show-on="overview">
          <h3 className="gp-entity-payload__section-title gp-section-mini__title">
            {tEntity('keywords')} <b>· {entity.keywords.length}</b>
          </h3>
          <ul className="gp-entity-payload__keywords gp-chip-row">
            {entity.keywords.map((k) => (
              <li key={k} className="gp-entity-payload__keyword gp-chip">
                {k}
              </li>
            ))}
          </ul>
        </section>
      )}

      {facts.length > 0 && (
        <section
          className="gp-entity-payload__section gp-section-mini"
          data-show-on="overview facts"
        >
          <h3 className="gp-entity-payload__section-title gp-section-mini__title">
            {tEntity('facts_title', { count: facts.length })}
          </h3>
          <ul className="gp-entity-payload__facts gp-kp-list">
            {facts.map((f) => (
              <li key={f.id} className="gp-kp-item">
                <BilingualText original={f.content} translated={f.contentTranslated} />
                <span className="gp-kp-meta">
                  <span className="gp-entity-payload__fact-date">
                    {formatDateOnly(f.createdAt, tz)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {opinions.length > 0 && (
        <section
          className="gp-entity-payload__section gp-entity-payload__opinions gp-section-mini"
          data-show-on="overview opinions"
        >
          <h3 className="gp-entity-payload__section-title gp-section-mini__title">
            {tEntity('opinions_title', { count: opinions.length })}
          </h3>
          <ul className="gp-entity-payload__opinion-list gp-kp-list">
            {opinions.map((o) => (
              <li
                key={o.id}
                className="gp-entity-payload__opinion-item gp-kp-item gp-kp-item--opinion"
              >
                <BilingualText original={o.content} translated={o.contentTranslated} />
                <span className="gp-kp-meta">
                  <span className="gp-entity-payload__fact-date">
                    {formatDateOnly(o.createdAt, tz)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {relations.length > 0 && (
        <section
          className="gp-entity-payload__section gp-section-mini"
          data-show-on="overview relations"
        >
          <h3 className="gp-entity-payload__section-title gp-section-mini__title">
            {tEntity('relationships_title', { count: relations.length })}
          </h3>
          <div className="gp-entity-payload__relations gp-chip-row">
            {relations.map((r) => {
              const otherId = r.sourceEntityId === id ? r.targetEntityId : r.sourceEntityId;
              const otherName = r.sourceEntityId === id ? r.targetEntityName : r.sourceEntityName;
              return (
                <button
                  type="button"
                  key={r.id}
                  className="gp-entity-payload__relation-chip gp-chip"
                  onClick={() => onNavigateEntity({ kind: 'entity', id: otherId })}
                >
                  {otherName}
                  <span className="gp-chip__count" aria-hidden="true">
                    ↗
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {sources.length > 0 && (
        <section
          className="gp-entity-payload__section gp-entity-payload__sources gp-section-mini"
          data-show-on="overview"
        >
          <h3 className="gp-entity-payload__section-title gp-section-mini__title">
            {tEntity('sources_title', { count: sources.length })}
          </h3>
          <ul className="gp-entity-payload__source-list">
            {sources.map((s) => (
              <li key={s.id} className="gp-entity-payload__source-item">
                {s.originalUrl ? (
                  <a href={safeHref(s.originalUrl)} target="_blank" rel="noopener noreferrer">
                    {s.originalUrl}
                  </a>
                ) : (
                  <span>#{s.id}</span>
                )}
                <span
                  className={`gp-source-status-chip gp-source-status-chip--${s.status} gp-status gp-status--${s.status}`}
                >
                  {tSourceStatus(s.status)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* P5 Fix Batch 5 (I10): linkedNotes 加载失败时显式区分 'ready 空'，
       * 之前两种状态都被 silently 折叠成"不渲染 section"，用户没法发现 / 重试。 */}
      {linkedNotesState.status === 'error' && (
        <section
          className="gp-entity-payload__section gp-entity-payload__notes gp-section-mini"
          data-show-on="overview"
          role="alert"
        >
          <h3 className="gp-entity-payload__section-title gp-section-mini__title">
            {tEntity('linked_notes_title', { count: 0 })}
          </h3>
          <p className="gp-entity-payload__notes-error">
            {tEntity('linked_notes_load_failed')}{' '}
            <button
              type="button"
              className="gp-btn"
              data-variant="ghost"
              data-size="sm"
              onClick={retryLinkedNotes}
            >
              {tCommon('retry')}
            </button>
          </p>
        </section>
      )}

      {linkedNotes.length > 0 && (
        <section
          className="gp-entity-payload__section gp-entity-payload__notes gp-section-mini"
          data-show-on="overview"
        >
          <h3 className="gp-entity-payload__section-title gp-section-mini__title">
            {tEntity('linked_notes_title', { count: linkedNotes.length })}
          </h3>
          <ul className="gp-entity-payload__notes-list">
            {linkedNotes.map((n) => (
              <NoteCard key={n.id} note={n} onOpen={onNavigateEntity} />
            ))}
          </ul>
        </section>
      )}

      {githubRepo && (
        <section
          className="gp-entity-payload__section gp-entity-payload__github"
          data-show-on="overview"
        >
          <GithubRepoCard
            owner={githubRepo.owner}
            repo={githubRepo.repo}
            normalizedUrl={githubRepo.normalizedUrl}
            archived={githubRepo.archived}
            lastRefreshed={githubRepo.lastRefreshedAt}
          />
        </section>
      )}
    </div>
  );
}
