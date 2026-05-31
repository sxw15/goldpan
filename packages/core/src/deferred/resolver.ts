import { extractAssistantTurn } from '../conversation/assistant-turn';
import type { SourceStatus } from '../db/repositories/types';
import { errorMessage } from '../errors';
import { t } from '../i18n/index';
import { backfillNoteEntitiesForSource } from '../notes/backfill';
import type { IntentPluginResult } from '../plugins/types';
import type { DeferredResolverDeps, DeferredTrackingPort, PendingResolutionPayload } from './types';

const TERMINAL_CONFIRMED: ReadonlySet<SourceStatus> = new Set(['confirmed', 'confirmed_empty']);
const TERMINAL_FAILED: ReadonlySet<SourceStatus> = new Set(['failed', 'discarded']);

/**
 * SourceRepository.onTerminated hook 入口。
 *
 * Source 进入终态时：
 * 1) confirmed* → 反查 note_sources 给关联 notes 回填 note_entities
 * 2) trackingPort 注入时 → 反查 pending_pipeline tracking rules，按 status +
 *    entity_count 走 5 分支（resolve / clarify / fail_no_entity / fail_source_pipeline）
 *
 * 失败 swallowed —— deferred 错误不能 cascade fail 整个 pipeline。
 * IM push 是 fire-and-forget（不 await）。
 */
export function onSourceTerminated(
  sourceId: number,
  status: SourceStatus,
  deps: DeferredResolverDeps,
): void {
  if (TERMINAL_CONFIRMED.has(status)) {
    try {
      const result = backfillNoteEntitiesForSource(sourceId, deps.db);
      if (result.notesUpdated > 0) {
        deps.logger.info('deferred: note_entities backfilled', { sourceId, ...result });
      }
    } catch (err) {
      deps.logger.error('deferred: note backfill failed', { sourceId, err: errorMessage(err) });
    }
  }

  if (!deps.trackingPort) {
    deps.logger.debug('deferred: trackingPort not registered, skipping', { sourceId });
    return;
  }

  let pending: ReturnType<DeferredTrackingPort['findPendingByPipelineSource']>;
  try {
    pending = deps.trackingPort.findPendingByPipelineSource(sourceId);
  } catch (err) {
    deps.logger.error('deferred: findPending failed', { sourceId, err: errorMessage(err) });
    return;
  }

  if (pending.length === 0) {
    deps.logger.debug('deferred: no pending tracking rules', { sourceId, status });
    return;
  }

  for (const rule of pending) {
    try {
      resolveOneRule(rule, sourceId, status, deps);
    } catch (err) {
      deps.logger.error('deferred: resolveOneRule threw', {
        sourceId,
        ruleId: rule.id,
        err: errorMessage(err),
      });
    }
  }
}

function resolveOneRule(
  rule: { id: number; pendingResolution: PendingResolutionPayload | null },
  sourceId: number,
  status: SourceStatus,
  deps: DeferredResolverDeps,
): void {
  if (!deps.trackingPort) return;
  const payload = rule.pendingResolution;
  if (!payload) {
    deps.logger.warn('deferred: pending_resolution payload missing', { ruleId: rule.id });
    return;
  }

  if (TERMINAL_FAILED.has(status)) {
    const ok = deps.trackingPort.markFailedResolution(rule.id, {
      targetStatus: 'failed_source_pipeline',
      expectedStatus: 'pending_pipeline',
    });
    if (ok) {
      pushAssistant(deps, payload, {
        type: 'action',
        message: t('tracking.failed_source_pipeline_assistant_text'),
        actionId: `tracking-${rule.id}-failed_source_pipeline`,
      });
    }
    return;
  }

  const entityIds = deps.knowledge.getEntityIdsForSource(sourceId);

  if (status === 'confirmed_empty' || entityIds.length === 0) {
    const ok = deps.trackingPort.markFailedResolution(rule.id, {
      targetStatus: 'failed_no_entity',
      expectedStatus: 'pending_pipeline',
    });
    if (ok) {
      pushAssistant(deps, payload, {
        type: 'action',
        message: t('tracking.failed_no_entity_assistant_text'),
        actionId: `tracking-${rule.id}-failed_no_entity`,
      });
    }
    return;
  }

  if (entityIds.length === 1 && entityIds[0] !== undefined) {
    const firstId = entityIds[0];
    const entity = deps.knowledge.getEntitiesByIds([firstId])[0];
    const entityName = entity?.name ?? payload.placeholderName ?? `entity ${firstId}`;
    const ok = deps.trackingPort.markResolved(rule.id, {
      name: entityName,
      searchQueries: [entityName],
      linkedEntityIds: [firstId],
      expectedStatus: 'pending_pipeline',
    });
    if (ok) {
      pushAssistant(deps, payload, {
        type: 'action',
        message: t('tracking.resolved_assistant_text', { name: entityName }),
        actionId: `tracking-${rule.id}-resolved`,
      });
    }
    return;
  }

  const ok = deps.trackingPort.markAwaitingClarify(rule.id, {
    candidateEntityIds: entityIds,
    expectedStatus: 'pending_pipeline',
  });
  if (ok) {
    const candidates = deps.knowledge.getEntitiesByIds(entityIds);
    const structuredOptions = candidates.map((e) => ({
      intentKey: 'resolve_tracking_entity' as const,
      payload: JSON.stringify({ trackingRuleId: rule.id, entityId: e.id, entityName: e.name }),
    }));
    pushAssistant(deps, payload, {
      type: 'clarify',
      questionKey: 'tracking_resolve_entity',
      structuredOptions,
      question: t('tracking.awaiting_clarify_assistant_text'),
      options: candidates.map((e) => e.name),
    });
  }
}

function pushAssistant(
  deps: DeferredResolverDeps,
  payload: PendingResolutionPayload,
  result: IntentPluginResult,
): void {
  if (payload.conversationId > 0) {
    try {
      // archived conv 不写 web turn —— 用户已 /reset，active list 不显示，落库后体感"消息丢失"。
      // IM 走另一路（archive 是 web-only 状态）—— 用户在 telegram 端仍应收到 deferred 结果。
      const conv = deps.conversation.loadConversationById(payload.conversationId);
      if (conv?.archivedAt) {
        deps.logger.info('deferred: web push skipped, conversation archived', {
          conversationId: payload.conversationId,
        });
      } else {
        const turn = extractAssistantTurn(result);
        if (turn) {
          const enrichedMeta = { ...turn.metadata, ...maybeTrackingRuleIdMeta(result) };
          deps.conversation.appendMessage(payload.conversationId, {
            role: 'assistant',
            content: turn.content,
            metadata: enrichedMeta,
          });
        }
      }
    } catch (err) {
      deps.logger.warn('deferred: appendMessage failed', { err: errorMessage(err) });
    }
  }

  if (payload.sessionRef && deps.imSendOutbound) {
    void deps
      .imSendOutbound(payload.sessionRef.channelId, payload.sessionRef, result)
      .catch((err) =>
        deps.logger.warn('deferred: imSendOutbound failed', { err: errorMessage(err) }),
      );
  }
}

// action.actionId 形如 'tracking-{ruleId}-{status}'；反解 ruleId 加入 metadata
// 给 web UI 渲染 "tracking-resolved" bubble，避免 UI 自己再去 parse actionId。
function maybeTrackingRuleIdMeta(result: IntentPluginResult): Record<string, unknown> {
  if (result.type !== 'action' || !result.actionId) return {};
  const m = result.actionId.match(/^tracking-(\d+)-/);
  return m ? { trackingRuleId: Number(m[1]) } : {};
}
