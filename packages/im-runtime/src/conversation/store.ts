import type { ConversationRepository, HandleInputResult } from '@goldpan/core';
import {
  type AssistantTurn,
  type ConversationContext,
  extractAssistantTurn,
} from '@goldpan/core/conversation';

// P3 Task 4: `extractAssistantTurn` + `AssistantTurn` 上浮到 core
// (`@goldpan/core/conversation/assistant-turn`)，本文件改为 re-export 保持
// 现有 imports（如 `import { extractAssistantTurn } from './store.js'`、
// `import { ConversationStore, extractAssistantTurn } from '../conversation/store'`）
// byte-for-byte 不破。逻辑实装在 core 单点，buffer-finalize / IM dispatcher 共用同一份。
export { type AssistantTurn, extractAssistantTurn };

export interface ConversationStoreOptions {
  repo: ConversationRepository;
  defaultWindowSize: number;
}

export class ConversationStore {
  constructor(private opts: ConversationStoreOptions) {}

  loadOrCreate(sessionKey: string, channelId: string): ConversationContext {
    const { id } = this.opts.repo.findOrCreate(sessionKey, channelId);
    const existing = this.opts.repo.loadContext(sessionKey, this.opts.defaultWindowSize);
    if (existing) return existing;
    // Defensive fallback: in practice `loadContext` should always find the row
    // we just created (or the pre-existing active conversation) because both
    // queries share the same `(sessionKey, archivedAt IS NULL)` predicate. The
    // only realistic way to land here is if another process archived the
    // conversation between our `findOrCreate` insert and the `loadContext`
    // SELECT — extraordinarily rare given the per-sessionKey FIFO lock the
    // dispatcher holds, but cheaper to handle than to crash. Keep it.
    return {
      sessionKey,
      conversationId: id,
      channelId,
      recentMessages: [],
      messageWindowSize: this.opts.defaultWindowSize,
      startedAt: new Date(),
    };
  }

  appendUserTurn(conversationId: number, content: string): { id: number } {
    return this.opts.repo.appendMessage(conversationId, { role: 'user', content });
  }

  /**
   * Persist the assistant turn paired with the just-written user turn.
   * Returns `null` when `extractAssistantTurn` decides no assistant turn
   * should be written (currently only `result.type === 'wait'`, whose P2
   * contract leaves the conversation un-paired and the user turn marked
   * `buffered_wait`; the buffer-release path writes the real assistant
   * reply later). Caller (`InboundDispatcher`) must tolerate `null`
   * to keep server `/input` and IM dispatcher UX consistent.
   */
  appendAssistantTurn(conversationId: number, result: HandleInputResult): { id: number } | null {
    const turn = extractAssistantTurn(result);
    if (turn === null) return null;
    return this.opts.repo.appendMessage(conversationId, {
      role: 'assistant',
      content: turn.content,
      metadata: turn.metadata,
    });
  }
}
