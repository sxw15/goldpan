export interface ConversationContext {
  sessionKey: string;
  conversationId: number;
  channelId: string;
  recentMessages: ConversationMessage[];
  messageWindowSize: number;
  startedAt: Date;
}

export interface ConversationMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  // P3: 暴露 message 在 buffer 流程中的状态，UI 据此渲染 buffered_wait
  // indicator / consumed 标灰。'consumed' 通常被 loadContext 过滤，仅在
  // GET /conversations/:id 全量加载时出现。
  status?: 'normal' | 'buffered_wait' | 'consumed';
  bufferedExpiresAt?: number;
}
