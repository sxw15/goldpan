import type { SourceStatus as CoreSourceStatus } from '@goldpan/core/db/repositories';
import { t } from '@goldpan/core/i18n';
import type {
  IntentExecutionContext,
  IntentPluginResult,
  ServiceCallLlmFn,
} from '@goldpan/core/plugins';
import { handleManageTracking } from './intent-handler.js';
import type { PendingResolutionPayload, TrackingService } from './types.js';

/**
 * Local copy of the source.status literal union, mirrored from
 * `@goldpan/core/db/repositories/types.ts`.
 *
 * Why local: when imported transitively through `@goldpan/core/db/repositories/index.d.ts`,
 * TypeScript's narrowing analysis collapses the union (likely due to
 * drizzle-orm's `InferSelectModel` chain producing `any` at this plugin's
 * resolution context). Declaring the union locally restores narrowing /
 * exhaustiveness in the source.status switch below.
 *
 * The compile-time assert pair `LocalSourceStatus extends CoreSourceStatus`
 * and the reverse fail to compile if upstream `SourceStatus` adds / drops
 * a member, forcing this file to be updated.
 */
type LocalSourceStatus = 'processing' | 'confirmed' | 'confirmed_empty' | 'failed' | 'discarded';

// Bidirectional equality assertion — adding `'queued'` upstream (or dropping
// `'discarded'`) breaks one of these and forces the switch to be revised.
true satisfies [LocalSourceStatus] extends [CoreSourceStatus]
  ? [CoreSourceStatus] extends [LocalSourceStatus]
    ? true
    : false
  : false;

/**
 * Map LocalSourceStatus → human label used in the failed/discarded user-facing
 * message. Kept inline rather than going through i18n because tracking
 * plugin's `messages.ts` is intentionally focused on management-CRUD copy;
 * the P2 create_tracking flow has only two friendly-fail strings.
 */
function statusLabel(status: 'failed' | 'discarded', lang: 'zh' | 'en'): string {
  if (lang === 'zh') return status === 'failed' ? '失败' : '丢弃';
  return status === 'failed' ? 'failed' : 'discarded';
}

/**
 * `create_tracking` intent handler. Two paths:
 *
 *  **Path A** (linkedSourceId valid + in recent messages) — branch on
 *    `sources.status`:
 *    - confirmed / confirmed_empty + 1 entity → immediately create rule
 *      linked to that entity, return `{type:'action'}`.
 *    - confirmed / confirmed_empty + N entities → create pending rule with
 *      `awaiting_clarify`, return keyed `{type:'clarify'}` chips.
 *    - confirmed / confirmed_empty + 0 entities → return `{type:'action'}`
 *      asking the user for keywords (no rule written).
 *    - processing → create pending rule with `pending_pipeline`, return
 *      `{type:'tracking_pending', reasonKey: 'waiting_pipeline'}`. P4
 *      deferred resolver flips it to `resolved` when the source terminates.
 *    - failed / discarded → write `failed_source_pipeline` row (history) but
 *      return `{type:'action'}` with a friendly error message rather than
 *      `tracking_pending` (spec N3 — never hang on a source that already
 *      gave up).
 *
 *  **Path B** (no linkedSourceId or it's not in recent messages) — delegate
 *    to `handleManageTracking` with `forceAction:'create'`, which runs the
 *    existing LLM entity extraction prompt and reuses the management-CRUD
 *    `createInterest` path. No duplicate prompt design.
 *
 * The exhaustive `switch` on `src.status` has a `_exhaustive: never` final
 * branch — adding a new SourceStatus value to `db/repositories/types.ts`
 * without updating this switch fails to compile, forcing review.
 */
export async function handleCreateTracking(
  input: string,
  service: TrackingService,
  ctx: IntentExecutionContext,
  callLlm: ServiceCallLlmFn,
  signal?: AbortSignal,
): Promise<IntentPluginResult> {
  // B2: linkedSourceId 已在 handleInput 中央校验 ∈ recentMessages，plugin
  // 直接信任 ctx.linkedSourceId（不在 recentMessages 的情况已被清成 undefined
  // → 自动走 path B）。
  const linkedSourceId = ctx.linkedSourceId;

  // ─── 路径 B：无 linkedSourceId，委托 handleManageTracking ────────
  if (linkedSourceId === undefined) {
    return runPathB(input, service, callLlm, signal);
  }

  // ─── 路径 A：4 分支 source.status switch ────────────────────────
  const src = ctx.repos.source.getById(linkedSourceId);
  if (!src) {
    // 走 path B 而不是直接 fail — 用户依然可能想新建追踪，只是 source id
    // 已被删/迁移。让 LLM 从文本里抽。
    ctx.logger.warn('create_tracking: linkedSourceId points to missing source, falling back', {
      linkedSourceId,
    });
    return runPathB(input, service, callLlm, signal);
  }

  // truncate 用户原文做 placeholder name —— 60 char 是 TrackingService.
  // createInterest 用的 200 char 限制的安全余量；防御性截断同时保证用户
  // 在 list 视图能识别这条 pending 行。
  const placeholderName = input.trim().slice(0, 60) || `Pending (source #${linkedSourceId})`;

  // Source.status is drizzle-inferred as `string` (text column with default),
  // but at the repo boundary it always matches SourceStatus — the pipeline
  // is the only writer and uses the typed enum. Narrow once so the switch
  // exhaustiveness check works.
  //
  // NB: deliberately NOT named `status` — `status` collides with the global
  // DOM `status` declaration (lib.dom.d.ts), which would silently widen the
  // local back to `string` and defeat the exhaustive `never` assert below.
  const srcStatus: LocalSourceStatus = src.status as LocalSourceStatus;

  switch (srcStatus) {
    case 'confirmed':
    case 'confirmed_empty': {
      const entityIds = ctx.repos.knowledge.getEntityIdsForSource(linkedSourceId);

      if (entityIds.length === 0) {
        // 0 entity —— pipeline 已落，但没抽出任何 entity。不落 pending（再
        // 等 P4 也不会回填），直接提示用户用文字补关键词。
        return {
          type: 'action',
          message:
            ctx.language === 'zh'
              ? '该来源未抽出实体，请直接告诉我要追踪什么（关键词 / 主题）'
              : 'No entities were extracted from this source. Please tell me what to track (keywords / topic).',
        };
      }

      if (entityIds.length === 1) {
        // 1 entity → 立即 resolve + enabled=true
        // length check above guarantees entityIds[0] is defined; fall back to
        // an impossible 0 if a future refactor breaks the invariant (which
        // would then surface as a getEntitiesByIds([0]) miss → undefined
        // entity → placeholderName).
        const firstId = entityIds[0] ?? 0;
        const entity = ctx.repos.knowledge.getEntitiesByIds([firstId])[0];
        const entityName = entity?.name ?? placeholderName;
        const rule = service.createInterest({
          name: entityName,
          searchQueries: [entityName],
          linkedEntityIds: entityIds,
          enabled: true,
        });
        return {
          type: 'action',
          message:
            ctx.language === 'zh'
              ? `已建立追踪「${rule.name}」（规则 #${rule.id}），下个调度周期开始执行。`
              : `Tracking "${rule.name}" (rule #${rule.id}) created; runs on the next scheduler cycle.`,
        };
      }

      // N entity → awaiting_clarify pending 行，UI 端拿 trackingRuleId 后
      // 会问用户选哪一个；P4 resolver 收到 clarify 选择后写 entity link 并
      // flip 到 resolved + enabled。
      const rule = service.createInterestWithResolution({
        name: placeholderName,
        searchQueries: [],
        linkedSourceId,
        enabled: false,
        resolutionStatus: 'awaiting_clarify',
        pendingResolution: {
          sourceId: linkedSourceId,
          candidateEntityIds: entityIds,
          // P4: snapshot 让 deferredResolver / clarify-timeout 找回 push 目标。
          // 兜底 0 在 CLI 场景（无 conversation），resolver 看到 0 时跳过 push。
          conversationId: ctx.conversation?.conversationId ?? 0,
          ...(ctx.sessionRef && { sessionRef: ctx.sessionRef }),
        } satisfies PendingResolutionPayload,
      });
      const candidates: Array<{ id: number; name: string }> =
        ctx.repos.knowledge.getEntitiesByIds(entityIds);
      return {
        type: 'clarify',
        questionKey: 'tracking_resolve_entity',
        question: t('tracking.awaiting_clarify_assistant_text'),
        structuredOptions: candidates.map((e) => ({
          intentKey: 'resolve_tracking_entity',
          payload: JSON.stringify({ trackingRuleId: rule.id, entityId: e.id, entityName: e.name }),
        })),
      };
    }

    case 'processing': {
      // source 还在 pipeline —— 落 pending 行，等 P4 resolver 在
      // sourceRepo.onTerminated 回调里抓回来。这里要把 sourceId 塞到
      // pending_resolution JSON，匹配 idx_tracking_pending_source 索引
      // (db.ts ~line 134) 让 resolver 反查不走表扫描。
      const rule = service.createInterestWithResolution({
        name: placeholderName,
        searchQueries: [],
        linkedSourceId,
        enabled: false,
        resolutionStatus: 'pending_pipeline',
        pendingResolution: {
          sourceId: linkedSourceId,
          placeholderName,
          conversationId: ctx.conversation?.conversationId ?? 0,
          ...(ctx.sessionRef && { sessionRef: ctx.sessionRef }),
        } satisfies PendingResolutionPayload,
      });
      return {
        type: 'tracking_pending',
        trackingRuleId: rule.id,
        reasonKey: 'waiting_pipeline',
      };
    }

    case 'failed':
    case 'discarded': {
      // Spec N3 防御：不挂 pending —— resolver 不会重跑这条 source，挂
      // pending 等于让规则永久卡住。仍写一行 `failed_source_pipeline`
      // 状态的行作为审计 trail，但 enabled=false 让 scheduler 跳过。
      // 给用户返回 action（不是 error）—— 用户的请求合法，是底层 source
      // 自己跑死了。
      service.createInterestWithResolution({
        name: placeholderName,
        searchQueries: [],
        linkedSourceId,
        enabled: false,
        resolutionStatus: 'failed_source_pipeline',
      });
      const label = statusLabel(srcStatus, ctx.language === 'zh' ? 'zh' : 'en');
      return {
        type: 'action',
        message:
          ctx.language === 'zh'
            ? `来源 #${linkedSourceId} 已${label}，无法基于它建立追踪。请直接告诉我要追踪什么（关键词 / 主题）。`
            : `Source #${linkedSourceId} is ${label}, cannot set up tracking from it. Please tell me what to track (keywords / topic).`,
      };
    }

    default: {
      // Compile-time exhaustiveness guard: adding a new SourceStatus member
      // without extending this switch fails to compile here. The throw is
      // unreachable at runtime; the `never` annotation is what matters.
      const _exhaustive: never = srcStatus;
      throw new Error(`create_tracking: unhandled source.status: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Path-B fallback — pure-text tracking creation. Forces `action='create'`
 * after the LLM extracts name + searchQueries from `input`, then maps the
 * `IntentHandlerResult` shape (legacy clarify free-text) onto the
 * `IntentPluginResult` shape (P2 keyed clarify).
 */
async function runPathB(
  input: string,
  service: TrackingService,
  callLlm: ServiceCallLlmFn,
  signal?: AbortSignal,
): Promise<IntentPluginResult> {
  const handled = await handleManageTracking(input, service, callLlm, signal, {
    forceAction: 'create',
  });
  switch (handled.type) {
    case 'action':
      return { type: 'action', message: handled.message ?? '' };
    case 'content':
      return { type: 'content', text: handled.text ?? '', format: handled.format };
    case 'clarify':
      return {
        type: 'clarify',
        // Keep BOTH legacy and keyed shape per Task 4 additive rule — UI
        // prefers keyed, falls back to free-text question for legacy
        // plugins still on the old shape.
        question: handled.question,
        options: handled.options,
        questionKey: 'incomplete_action',
        structuredOptions: [
          { intentKey: 'create_tracking', payload: input },
          { intentKey: 'query', payload: input },
        ],
      };
  }
}
