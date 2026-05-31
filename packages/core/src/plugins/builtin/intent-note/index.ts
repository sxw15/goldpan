import { backfillNoteEntitiesForSource } from '../../../notes/backfill';
import type { CreateNoteInput } from '../../../notes/types';
import type { IntentExecutionContext, IntentPlugin, IntentPluginResult } from '../../types';

/**
 * Built-in intent plugin for personal notes — writes the user's input verbatim
 * into the `notes` table via `NotesRepository.create` with NO LLM call and NO
 * pipeline involvement. The classifier supplies the `noteSubtype` and (when the
 * user is annotating something they just submitted) the `linkedSourceId`; this
 * plugin validates both against the conversation context to defend against LLM
 * hallucinations crossing conversation boundaries.
 */
export const intentNotePlugin: IntentPlugin = {
  name: 'intent-note',
  version: '1.0.0',
  type: 'intent',
  description: 'Built-in plugin for personal notes (no LLM, no pipeline)',
  descriptions: {
    zh: '内置插件 — 直接保存个人笔记（不走 LLM、不走 pipeline）',
  },

  intents: [
    {
      name: 'create_note',
      description: 'User wants to save a personal note without AI processing',
      descriptions: {
        zh: '用户希望直接保存个人笔记，不需要 AI 处理',
      },
      examples: [
        '今天和 Alice 聊了下，她说要做 X',
        '想法：给笔记加 @entity 自动关联会很爽',
        '记下：明天提交那个 PR',
      ],
      classificationHints: [
        '流水/事件叙述、行动备忘、想法、反思、观察 → create_note',
        '事实性知识想沉淀进知识库（非 URL）→ submit_text（escape hatch）',
        '对某主题的明确观点想关联到 entities → record_thought（escape hatch）',
        '不确定时 → 用 decision=clarify 询问而非默认归 note',
      ],
      priority: 0,
      resultTypes: ['note'],
    },
  ],

  async execute(
    _intent: string,
    input: string,
    ctx: IntentExecutionContext,
  ): Promise<IntentPluginResult> {
    // B2: linkedSourceId 已在 handleInput 中央校验 ∈ recentMessages，plugin
    // 直接信任 ctx.linkedSourceId。
    const linkedSourceId = ctx.linkedSourceId;

    // 反查 entity ids（仅当 source 已 confirmed / confirmed_empty 时）。
    // pipeline 还在跑或失败时不反查 — note 仍关联 source，但 entity 留空，
    // 等 P4 deferred resolver 在 pipeline 完成时通过 note_entities 回填。
    let linkedEntityIds: number[] | undefined;
    if (linkedSourceId !== undefined) {
      const src = ctx.repos.source.getById(linkedSourceId);
      if (src && (src.status === 'confirmed' || src.status === 'confirmed_empty')) {
        const ids = ctx.repos.knowledge.getEntityIdsForSource(linkedSourceId);
        if (ids.length > 0) linkedEntityIds = ids;
      }
    }

    // 3. 走 P1 落地的 NotesRepository.create。底层 createNote 对
    //    linkedSourceId / linkedEntityIds 已做 soft validation：
    //    classifier 误传不存在的 id 会被静默丢弃而非抛错。
    const inputForNote: CreateNoteInput = {
      content: input,
      subtype: ctx.noteSubtype ?? 'note',
      linkedSourceId,
      linkedEntityIds,
      sourceMessageId: ctx.currentUserMessageId,
    };
    const detail = ctx.repos.notes.create(inputForNote);

    // 4. A2 race 兜底：步骤 2 看到 source.status='processing' 时未反查 entity，
    //    若在 createNote 完成前 pipeline 已终态，onSourceTerminated 已 fire 过但
    //    note_sources 行尚未存在 → backfill 漏掉该 note。这里回查一次 + inline
    //    补 backfill。
    //
    //    Race window：step-2 status 读 → createNote 事务（含 notes / note_tags /
    //    note_entities / note_sources 多语句插入，重负载下 50-200ms）→ step-4
    //    status 重读。窗口比"几毫秒"宽，但 `backfillNoteEntitiesForSource` 用
    //    `onConflictDoNothing`，与并发 onSourceTerminated 兜底重复触发幂等。
    //    极少数 `note_sources` 在 step-4 之后才落库的 case 仍会漏（无 known
    //    impact —— user 看 inspector 时 note_entities 为空，可手动 link）。
    if (linkedSourceId !== undefined && linkedEntityIds === undefined) {
      const src = ctx.repos.source.getById(linkedSourceId);
      if (src && (src.status === 'confirmed' || src.status === 'confirmed_empty')) {
        try {
          backfillNoteEntitiesForSource(linkedSourceId, ctx.db);
        } catch (err) {
          ctx.logger.warn('intent-note: post-create backfill failed', {
            linkedSourceId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return { type: 'note', detail };
  },
};
