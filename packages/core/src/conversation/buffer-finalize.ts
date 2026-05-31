import type { ILogObj, Logger } from 'tslog';
import type { DrizzleDB } from '../db/connection';
import { errorMessage } from '../errors';
import type { HandleInputDeps, HandleInputResult } from '../input';
import type { FallbackIntent, IntentNoteSubtype } from '../intent/types';
import type { HandleInputRepos } from '../plugins/types';
import { writeAssistantTurnForResult } from './assistant-turn';
import type { ConversationContext } from './types';

export interface FinalizeBufferDeps {
  db: DrizzleDB;
  repos: HandleInputRepos;
  logger: Logger<ILogObj>;
  /** Injected handleInput — tests mock; production passes the real `handleInput` import. */
  handleInput: (input: string, deps: HandleInputDeps) => Promise<HandleInputResult>;
  /** Forwarded straight to handleInput. */
  callLlm: HandleInputDeps['callLlm'];
  pluginRegistry: HandleInputDeps['pluginRegistry'];
  config: HandleInputDeps['config'];
  embeddingProvider?: HandleInputDeps['embeddingProvider'];
  signal?: AbortSignal;
}

export interface FinalizeBufferResult {
  /** true → handleInput executed successfully; false → CAS won but handleInput threw. */
  executed: boolean;
  result: HandleInputResult | null;
  conversationId: number;
}

/**
 * P3 buffer 5-trigger 统一终点：CAS 标 buffered_wait → consumed，然后调
 * handleInput(forcedIntent=savedFallbackIntent) 真正执行用户的兜底意图。
 *
 * 幂等：两次调同 messageId 只有第一次真正跑 handleInput；CAS 失败时返 null。
 *
 * 调用方（见 spec §"5 触发路径"）：
 * - Path A: buffer-merge.ts findAndMergeBuffered（不合并 / finalize 时）
 * - Path B: server /conversations/buffered/:id/release endpoint
 * - Path C: handleInput 入口被动扫
 * - Path D: GET /conversations/active 与 /:id reconcile
 * - Path E: buffer-watcher cron tick
 */
export async function finalizeBuffer(
  messageId: number,
  deps: FinalizeBufferDeps,
): Promise<FinalizeBufferResult | null> {
  // 1. CAS 标 consumed + 拿 metadata.__internal.classifierDecision
  const consumed = deps.repos.conversation.consumeBuffered(messageId);
  if (!consumed) {
    deps.logger.debug('finalizeBuffer: CAS failed or message not found', { messageId });
    return null;
  }

  const decision = consumed.classifierDecision ?? {};
  // FallbackIntent enum 见 packages/core/src/intent/types.ts:32 —
  // 'submit_url' | 'query' | 'create_note'。
  const fallbackIntent = (decision.fallbackIntent as FallbackIntent | undefined) ?? 'create_note';
  const linkedSourceId = (decision.linkedSourceId as number | null | undefined) ?? undefined;
  const noteSubtype = decision.noteSubtype as IntentNoteSubtype | undefined;

  // P3 第二轮 review 修订：finalizeBuffer 必须给 handleInput 重新装载
  // conversation context —— plugin（尤其 query）依赖 context.recentMessages。
  // 直接从 consumed.conversationId 反查 sessionKey + loadContext。
  // 注：loadContext 跳过 consumed message（含刚才 CAS 标的那条），所以
  // recentMessages 不会重复包含 buffered 内容。
  const conv = deps.repos.conversation.loadConversationById(consumed.conversationId);
  let conversationCtx: ConversationContext | undefined;
  if (conv) {
    conversationCtx =
      deps.repos.conversation.loadContext(conv.sessionKey, deps.config.im.conversationWindowSize) ??
      undefined;
  }

  // 2. 调 handleInput 走 forcedIntent 路径
  try {
    const result = await deps.handleInput(consumed.content, {
      db: deps.db,
      callLlm: deps.callLlm,
      pluginRegistry: deps.pluginRegistry,
      config: deps.config,
      repos: deps.repos,
      logger: deps.logger,
      embeddingProvider: deps.embeddingProvider,
      signal: deps.signal,
      forcedIntent: fallbackIntent,
      currentUserMessageId: messageId,
      // P3：linked-* 字段透给 handleInput，input.ts execute 分支把它们注入 context。
      linkedSourceId,
      noteSubtype,
      // P3 二轮 review：把已加载的 conversation 传给 plugin 用历史上下文。
      conversation: conversationCtx,
    });

    // 3. 写 assistant turn —— P3 Task 4 把 IM adapter 的 extractAssistantTurn 上浮到
    // core/conversation/assistant-turn.ts，buffer-finalize 与 IM dispatcher 现在共用
    // 同一份 "按 result.type 拼 (content, metadata)" 逻辑。
    // wait 路径返 null（不写 turn）—— 但 finalize 的 forcedIntent 路径绕开了 wait
    // 分支，所以这里实际返 null 的概率很小；即便返了 null 也不会影响 conversationId
    // 返回值，调用方按需读 result.type 判断后续渲染。
    writeAssistantTurnForResult({
      repo: deps.repos.conversation,
      conversationId: consumed.conversationId,
      result,
    });

    return { executed: true, result, conversationId: consumed.conversationId };
  } catch (err) {
    deps.logger.error('finalizeBuffer: handleInput threw', {
      messageId,
      fallbackIntent,
      err: errorMessage(err),
    });
    // 不回滚 status —— buffered_wait 永远不再触发，悬空风险更高（spec §"错误处理"）。
    return { executed: false, result: null, conversationId: consumed.conversationId };
  }
}
