// monorepo/packages/core/src/db/repositories/types.ts
import type { InferSelectModel } from 'drizzle-orm';
import type { PipelineErrorKind } from '../../errors';
import type {
  categories,
  entities,
  entityCategories,
  eventLogs,
  knowledgePoints,
  llmCalls,
  processingTasks,
  sourceEntityPoints,
  sources,
  submissionLogs,
  taskLogs,
} from '../schema';

// ─── JSON-safe type for metadata fields ─────────────────────
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ─── Table row types ────────────────────────────────────────
export type Category = InferSelectModel<typeof categories>;
export type Entity = InferSelectModel<typeof entities>;
export type EntityCategory = InferSelectModel<typeof entityCategories>;
export type KnowledgePoint = InferSelectModel<typeof knowledgePoints>;
export type Source = InferSelectModel<typeof sources>;
export type SourceEntityPoint = InferSelectModel<typeof sourceEntityPoints>;
export type EventLog = InferSelectModel<typeof eventLogs>;
export type LlmCall = InferSelectModel<typeof llmCalls>;
export type ProcessingTask = InferSelectModel<typeof processingTasks>;
export type SubmissionLog = InferSelectModel<typeof submissionLogs>;
export type TaskLog = InferSelectModel<typeof taskLogs>;

// ─── Source types ───────────────────────────────────────────
export type SourceKind = 'external' | 'user';
export type SourceStatus = 'processing' | 'confirmed' | 'confirmed_empty' | 'failed' | 'discarded';
export type TaskStatus = 'pending' | 'processing' | 'done' | 'error';
export type InputType = 'url' | 'text' | 'opinion';
export const VALID_INPUT_TYPES: ReadonlySet<string> = new Set<InputType>([
  'url',
  'text',
  'opinion',
]);
export type PointType = 'fact' | 'opinion';
export type PointStatus = 'active' | 'discarded';
export type Judgment = 'new' | 'skipped';
export type TaskErrorKind = PipelineErrorKind;
export type EventAction =
  | 'point_created'
  | 'entity_created'
  | 'source_confirmed'
  | 'source_confirmed_empty'
  | 'source_discarded'
  | 'point_discarded'
  | 'entity_aliases_discovered';
export type PipelineStep =
  | 'collecting'
  | 'classifying'
  | 'extracting'
  | 'matching'
  | 'relating'
  | 'comparing'
  | 'verifying'
  | 'translating'
  | 'validatePipelineOutput'
  | 'storing'
  | 'content_validation';

// ─── CategoryRepository ─────────────────────────────────────
export interface CategoryRepository {
  ensureCategoryPath(path: string): number;
  getAll(): Category[];
  getById(id: number): Category | undefined;
  getByPath(path: string): Category | undefined;
  getChildren(parentId: number): Category[];
  getSubtree(pathPrefix: string): Category[];
}

// ─── SourceRepository ───────────────────────────────────────
export type CreateSourceInput =
  | {
      kind: 'external';
      normalizedUrl: string;
      originalUrl: string;
      rawContent?: string;
      metadata?: JsonObject;
    }
  | {
      kind: 'user';
      rawContent: string;
      normalizedUrl?: never;
      originalUrl?: never;
      metadata?: JsonObject;
    };

export interface SourceListFilter {
  /** 单值或多值数组（多值代表"任一命中即返回"）。空数组会抛错——构造空数组通常是上游 bug。 */
  status?: SourceStatus | readonly SourceStatus[];
  origin?: 'user' | 'tracking' | 'github_refresh';
  limit?: number;
}

/** 全量 status counts，与当前过滤无关。 */
export type SourceStatusCounts = Record<SourceStatus, number>;

export interface SourceListItem {
  id: number;
  kind: 'external' | 'user';
  originalUrl: string | null;
  normalizedUrl: string | null;
  title: string | null;
  status: SourceStatus;
  origin: string;
  createdAt: number;
  /** DISTINCT pointId，含 judgment='skipped'——库视角是"覆盖了多少"，不是"贡献了多少新 KP"。 */
  kpCount: number;
  /** DISTINCT entityId，含 judgment='skipped'。 */
  entityCount: number;
  /** 至多 3 条，按 per-entity KP 数倒序；tie 时按 entityId 升序。 */
  topEntities: { id: number; name: string }[];
  /** 去重后的所有 categoryPaths。 */
  entityCategoryPaths: string[];
  /** kind='user' 时为 rawContent 前 80 字符；kind='external' 恒为 null。 */
  preview: string | null;
}

export interface SourceWithEntities {
  source: Source;
  entities: { id: number; name: string; categoryPaths: string[] }[];
  entityCount: number;
}

export interface SourceRepository {
  create(input: CreateSourceInput): Source;
  getById(id: number): Source | undefined;
  getByIds(ids: number[]): Source[];
  findActiveByNormalizedUrl(normalizedUrl: string): Source | undefined;
  updateStatus(id: number, status: SourceStatus, options?: { emitTerminated?: boolean }): void;
  emitTerminated(id: number, status: SourceStatus): void;
  updateAfterCollecting(
    id: number,
    data: {
      title?: string;
      rawContent: string;
      collectorMetadata?: JsonObject;
    },
  ): void;
  /**
   * Merge a JSON patch into a source's `metadata` column. The current metadata
   * (if any) is parsed, shallow-merged with `patch`, and re-stringified. Missing
   * rows are a no-op; null / invalid-JSON / non-object current metadata is
   * treated as an empty object (so `patch` wins cleanly).
   */
  mergeMetadata(id: number, patch: Record<string, unknown>): void;
  getByStatus(status: SourceStatus, limit?: number): Source[];
  resetFailedSourcesToProcessing(): number;
  /** 默认按 createdAt DESC，limit 默认 100（route 层 cap 200）。聚合字段含 judgment='skipped'，见 SourceListItem。 */
  list(filter?: SourceListFilter): SourceListItem[];
  /** 表全量计数，与 list() 的 filter 无关。 */
  getStatusCounts(): SourceStatusCounts;
  /**
   * Return a source along with its distinct associated entities (with deduped
   * `categoryPaths`). Uses two SQL queries to avoid N+1. Returns null when the
   * source does not exist.
   */
  getDetailWithEntities(id: number): SourceWithEntities | null;
}

// ─── KnowledgeRepository ────────────────────────────────────
export type EntityRelationType =
  | 'organizational'
  | 'competitive'
  | 'collaborative'
  | 'technical'
  | 'causal'
  | 'general';

export interface RecentRelationRow {
  id: number;
  sourceEntityId: number;
  targetEntityId: number;
  relationType: EntityRelationType;
  createdAt: number;
  source: { id: number; name: string; categoryPaths: string[] };
  target: { id: number; name: string; categoryPaths: string[] };
}

export interface FindRecentRelationsInput {
  sinceMs: number;
  limit: number;
}

export interface CreateEntityInput {
  name: string;
  description?: string;
  /**
   * Optional translation of `description` written verbatim into the
   * `description_translated` column. NULL when the translating step is off or
   * the LLM had no translation for this entity. Storing falls back to
   * `description` at read time.
   */
  descriptionTranslated?: string | null;
  aliases?: string[];
  keywords?: string[];
}

/** Optional translation override forwarded to `createPoint`. */
export interface CreatePointOptions {
  /** Translation of `content` into the configured language; NULL = none. */
  contentTranslated?: string | null;
}

export interface KnowledgeRepository {
  createEntity(input: CreateEntityInput): Entity;
  getEntityById(id: number): Entity | undefined;
  getEntityRegistry(): Array<Entity & { categoryPaths: string[]; activePointCount: number }>;
  findEntitiesByNames(names: string[]): Array<{ id: number; name: string }>;
  appendAliases(entityId: number, newAliases: string[]): void;
  linkEntityToCategory(entityId: number, categoryId: number): void;
  createPoint(content: string, type: PointType, options?: CreatePointOptions): KnowledgePoint;
  upsertTags(names: string[]): Array<{ id: number; name: string }>;
  linkPointTags(pointId: number, tagIds: number[]): void;
  getTagsForPoints(pointIds: number[]): Map<number, string[]>;
  getPointById(id: number): KnowledgePoint | undefined;
  getActiveFactPointsForEntity(entityId: number): KnowledgePoint[];
  /** Batched variant: one query for many entities; missing entities omitted from the map. */
  getActiveFactPointsForEntities(entityIds: number[]): Map<number, KnowledgePoint[]>;
  getActivePointsForEntity(entityId: number): KnowledgePoint[];
  createSourceEntityPoint(
    sourceId: number,
    entityId: number,
    pointId: number,
    judgment: Judgment,
  ): void;
  discardPoint(pointId: number): void;
  findOrphanPoints(): KnowledgePoint[];
  getEntityIdsForSource(sourceId: number): number[];
  entityHasActivePoints(entityId: number): boolean;
  getPointsByIds(ids: number[]): KnowledgePoint[];
  getEntitiesByIds(ids: number[]): Array<Entity & { categoryPaths: string[] }>;
  deleteSourceEntityPointsBySource(sourceId: number): void;
  getSourcesForEntity(entityId: number): Source[];
  getCategoryPathsForEntity(entityId: number): string[];
  getRelationsForEntity(entityId: number): EntityRelation[];
  getRelationsBetweenEntities(entityIds: number[]): EntityRelation[];
  findRecentRelations(input: FindRecentRelationsInput): RecentRelationRow[];
}

// ─── EntityRelation ─────────────────────────────────────────
export interface EntityRelation {
  id: number;
  sourceEntityId: number;
  targetEntityId: number;
  sourceEntityName: string;
  targetEntityName: string;
  relationType: string;
  description: string;
  /** Translation of `description` (NULL when translating step is off / had no result). */
  descriptionTranslated: string | null;
  sourceId: number | null;
  createdAt: number;
}

// ─── TaskRepository ─────────────────────────────────────────
export interface CreateTaskInput {
  sourceId: number;
  type: 'pipeline';
  inputType?: InputType;
}

export type TaskStatusCounts = Record<TaskStatus, number>;

export interface TaskRepository {
  create(input: CreateTaskInput): ProcessingTask;
  getById(id: number): ProcessingTask | undefined;
  hasProcessingTask(): boolean;
  claimNextPending(): ProcessingTask | undefined;
  updatePipelineStep(id: number, step: PipelineStep): void;
  updateInputType(id: number, inputType: InputType): void;
  markDone(id: number, resultJson: string): void;
  markError(
    id: number,
    pipelineStep: PipelineStep | null,
    errorMessage: string,
    errorKind: TaskErrorKind,
  ): void;
  resetForRetry(id: number): void;
  resetAllProcessing(): number;
  getRecent(limit?: number, statusFilter?: readonly TaskStatus[]): ProcessingTask[];
  getCountsByStatus(): TaskStatusCounts;
}

// ─── EventLogRepository ─────────────────────────────────────
export interface CreateEventLogInput {
  sourceId: number;
  entityId?: number;
  pointId?: number;
  action: EventAction;
  summary?: string;
}

export interface EventLogRepository {
  create(input: CreateEventLogInput): EventLog;
  getBySourceId(sourceId: number): EventLog[];
  getByAction(action: EventAction, limit?: number): EventLog[];
  getRecent(limit?: number): EventLog[];
}

// ─── SubmissionLogRepository ────────────────────────────────
export type CreateSubmissionLogInput =
  | {
      rawInput: string;
      result: 'accepted';
      reason?: never;
      taskId: number;
      sourceId: number;
    }
  | {
      rawInput: string;
      result: 'duplicate' | 'rejected';
      reason: string;
      taskId?: number;
      sourceId?: number;
    };

export interface SubmissionLogRepository {
  create(input: CreateSubmissionLogInput): SubmissionLog;
  getByTaskId(taskId: number): SubmissionLog[];
  getRecent(limit?: number): SubmissionLog[];
}

// ─── LlmCallRepository ─────────────────────────────────────
export type LlmStep =
  | 'classifier'
  | 'extractor'
  | 'matcher'
  | 'comparator'
  | 'verifier'
  | 'relator'
  | 'translator'
  | 'intent_classifier'
  | 'query_understand'
  | 'query'
  | 'tracking_action_parser'
  | 'github_action_parser'
  | 'digest_summary'
  | 'digest_action_parser';

export type LlmCallOutcome = 'success' | 'failed';

/** Recorded on failed LLM rows; aligns with `PipelineError` / task `errorKind` values. */
export type LlmFailureKind =
  | 'schema_validation'
  | 'content_policy'
  | 'rate_limit'
  | 'timeout'
  | 'unknown';

export type CreateLlmCallInput = {
  step: LlmStep;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  requestBody: string | null;
  responseBody: string | null;
  requestSchema: string | null;
  promptHash: string;
  sourceId: number | null;
  outcome: LlmCallOutcome;
  failureKind: LlmFailureKind | null;
  failureMessage: string | null;
  attemptNumber: number;
};

export type LlmCallMeta = Omit<LlmCall, 'requestBody' | 'responseBody' | 'requestSchema'>;

export interface LlmCallRepository {
  /** Record an LLM call. Returns the created record. */
  create(input: CreateLlmCallInput): LlmCall;
  /** Get a single LLM call by ID (full record including bodies). */
  getById(id: number): LlmCall | undefined;
  /** Get LLM call metadata (without bodies) for a given source ID, ordered by timestamp ASC. */
  getMetadataBySourceId(sourceId: number): LlmCallMeta[];
}

// ─── MetadataRepository ─────────────────────────────────────
export interface MetadataRepository {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

// ─── TaskLogRepository ─────────────────────────────────────
export type TaskLogEvent = 'start' | 'end' | 'error' | 'skip';

export type CreateTaskLogInput = {
  taskId: number;
  step: PipelineStep;
  event: TaskLogEvent;
  message?: string;
  inputSummary?: string;
  outputSummary?: string;
};

export interface TaskLogRepository {
  create(input: CreateTaskLogInput): TaskLog;
  getByTaskId(taskId: number): TaskLog[];
  deleteByTaskId(taskId: number): void;
}

// ─── ConversationRepository ─────────────────────────────────
import type { ConversationContext, ConversationMessage } from '../../conversation/types';

export interface ConversationMessageInput {
  role: 'user' | 'assistant';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationMessageWithSession extends Omit<ConversationMessage, 'createdAt'> {
  conversationId: number;
  sessionKey: string;
  /** epoch ms; null 表示未归档（直接对应 conversations.archived_at INTEGER 列）。 */
  conversationArchivedAt: number | null;
  /** epoch ms — HTTP 边界统一 number，便于 main.ts JSON 序列化直传 SDK。 */
  createdAt: number;
}

export type ConversationArchiveReason = 'user_reset' | 'auto_stale' | 'admin';

export interface ConversationMessageRecord {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  metadata?: Record<string, unknown>;
  /** epoch ms — 用于 /conversations/:id 的 messages 序列化。 */
  createdAt: number;
  /**
   * P3 buffer mechanism: 让 web UI 在 GET /conversations/:id 拉历史时
   * 仍能识别 buffered_wait / consumed 消息并渲染 BufferedWaitIndicator /
   * consumed badge。`normal` 是 default，UI 可视为"普通消息"。
   */
  status?: 'normal' | 'buffered_wait' | 'consumed';
  /** P3: epoch ms — buffered_wait 状态下的过期时间，UI 倒计时用。 */
  bufferedExpiresAt?: number;
}

export interface ConversationListItem {
  id: number;
  sessionKey: string;
  channelId: string;
  /** null = 无 user message 时的 fallback 信号；web 层 i18n 回退 "对话 #{id}" */
  title: string | null;
  /** 以下时间字段均为 epoch ms — 经 main.ts JSON 直传 SDK ConversationSummary（number）。 */
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
  archivedAt: number | null;
  archivedReason: string | null;
  messageCount: number;
}

export interface BufferedMessageCandidate {
  id: number;
  content: string;
  conversationId: number;
  bufferedExpiresAt: number;
  classifierDecision: Record<string, unknown> | null;
}

export interface ExpiredBufferedMessage {
  id: number;
  conversationId: number;
  sessionKey: string;
  content: string;
  classifierDecision: Record<string, unknown> | null;
}

export interface ConversationSessionListQuery {
  sessionKey: string;
  limit: number;
  offset: number;
  /** default false: 只返 archived */
  includeActive?: boolean;
}

export interface ConversationRepository {
  findOrCreate(sessionKey: string, channelId: string): { id: number; created: boolean };
  /**
   * Load conversation context for classifier. Returns the latest `windowSize`
   * messages with status='normal' or 'buffered_wait'. **P3 update**: skips
   * `consumed` messages — they've been finalized into a follow-up turn and
   * surfacing them again would echo the buffered intent twice.
   */
  loadContext(sessionKey: string, windowSize: number): ConversationContext | null;
  loadConversationById(conversationId: number): {
    id: number;
    sessionKey: string;
    channelId: string;
    archivedAt: number | null;
    messages: ConversationMessageRecord[];
  } | null;
  appendMessage(conversationId: number, msg: ConversationMessageInput): { id: number };
  /**
   * P2: handleInput wait decision 调用。把 message 标 buffered_wait + 写
   * metadata.__internal.classifierDecision。CAS：仅当当前 status='normal'
   * 时才更新（防止多次触发把 consumed 倒回 buffered_wait）。
   *
   * 返回 true 表示成功标记；false 表示 CAS 失败（status 已变）。
   *
   * P3: 可选 `userMeta.waitReasonKey` 同步写到顶层 `metadata.waitReasonKey`，
   * 让 UI 经 stripInternalKeys 后仍可见（__internal 被剥后用户看不到）。
   */
  markBufferedWait(
    messageId: number,
    expiresAt: number,
    classifierDecision: Record<string, unknown>,
    /** P3: user-visible 顶层 metadata 字段，stripInternalKeys 后 UI 仍能访问 */
    userMeta?: { waitReasonKey?: string },
  ): boolean;

  /**
   * P3: 找该 sessionKey 当前 active buffered_wait 消息（status='buffered_wait'
   * 且 expires_at > now）。Path A 用 —— adapter 入口合并 user input 前查这个。
   */
  findActiveBufferedBySession(sessionKey: string): {
    id: number;
    content: string;
    conversationId: number;
    bufferedExpiresAt: number;
    classifierDecision: Record<string, unknown> | null;
  } | null;

  /**
   * B5 修复：返该 sessionKey **所有** active buffered_wait 消息（按 createdAt
   * 升序）。Path A 在并发场景（两条 POST 并行写入两条 buffered）下需要全部
   * consume + 合并，而不是只保留最新一条 → 旧条孤立等 Path E。
   */
  findAllActiveBufferedBySession(sessionKey: string): Array<{
    id: number;
    content: string;
    conversationId: number;
    bufferedExpiresAt: number;
  }>;

  /**
   * P3: 找该 sessionKey 最新 pending buffered_wait 消息，不按 expires_at 过滤。
   * /release 和 /cancel 用 —— 用户在倒计时结束后、Path E cron 处理前仍应能
   * 立即执行或取消这条 pending buffer。
   */
  findPendingBufferedBySession(sessionKey: string): BufferedMessageCandidate | null;

  /**
   * P3: 找全局 expired buffered_wait 消息（status='buffered_wait' 且
   * expires_at < now - graceMs）。Path E bufferWatcher cron 用。
   */
  findExpiredBuffered(graceMs: number, limit: number): ExpiredBufferedMessage[];

  /**
   * P3: session-scoped expired 查询。Path C / Path D 用；scope 必须下推到
   * SQL 后再 limit，否则其它 session 的旧 buffer 会挤占 batch。
   */
  findExpiredBufferedBySession(
    sessionKey: string,
    graceMs: number,
    limit: number,
  ): ExpiredBufferedMessage[];

  /**
   * P3: conversation-scoped expired 查询。Path D /conversations/:id 用；scope
   * 必须下推到 SQL 后再 limit。
   */
  findExpiredBufferedByConversation(
    conversationId: number,
    graceMs: number,
    limit: number,
  ): ExpiredBufferedMessage[];

  /**
   * P3: CAS 标 buffered_wait → consumed。原子 `UPDATE ... RETURNING`，
   * 并发 double-call 只有一个返回 1 行；其它返回 0 行。
   *
   * @returns 标成功时返回原 message metadata 中的 classifierDecision + content +
   *   conversationId；CAS 失败时返 null
   */
  consumeBuffered(messageId: number): {
    content: string;
    conversationId: number;
    classifierDecision: Record<string, unknown> | null;
  } | null;

  // NOTE (P3 第二轮 review 修订): 原计划加 `consumeAllBufferedInConversation`
  // 接口方法，实际 archive 必须在事务内 inline 写（method 调自身 `this.db`
  // 不在 tx 上下文），所以方法没有真实 caller。**已删除** — Task 2 archive 直接
  // 在 `tx.transaction` 内写 second UPDATE 即可。

  archive(
    sessionKey: string,
    reason: ConversationArchiveReason,
  ): { id: number; archivedAt: number } | null;
  getMessageById(id: number): ConversationMessageWithSession | null;
  purgeArchived(olderThan: Date): number;

  findActiveBySessionKey(sessionKey: string): number | null;
  listBySessionKey(query: ConversationSessionListQuery): {
    items: ConversationListItem[];
    total: number;
  };
  /** Hard delete by id; FK cascade 带走 conversation_messages。幂等：不存在也返 void。 */
  deleteById(id: number): void;
  /**
   * Un-archive: archive same-sessionKey current active (if any) + set target.archivedAt=null;
   * 事务。target 不存在抛 `ConversationNotFoundError`；已 active → no-op。
   */
  unarchive(id: number): void;
}

// ─── SourceViewRepository ─────────────────────────────────────────
// (rename history: P0-P5 这块叫 NoteRepository / NoteDetail；2026-05-19
// P6 rename cleanup 改成 SourceView* 以释放 Note* 名字给真正的 user notes。)
export interface SourceViewListItem {
  id: number;
  kind: 'external' | 'user';
  title: string | null;
  originalUrl: string | null;
  createdAt: number;
  categoryIds: number[];
}

export interface SourceViewEntityGroup {
  entityId: number;
  entityName: string;
  points: Array<{
    id: number;
    content: string;
    /** Translation of `content`; NULL when translating step was off / missed. */
    contentTranslated: string | null;
    type: string;
  }>;
}

// 注意：core 这一层 SourceViewDetail 只有 3 字段 (source + entities + categoryPaths)；
// `tags` 是 server route handler (notes.ts:57-58) 通过 getSourceViewTags 单独拿后
// spread 进 HTTP response 的 — 所以 sdk shape (web-sdk/types.ts) 比 core 多 `tags` 字段。
export interface SourceViewDetail {
  source: Source;
  entities: SourceViewEntityGroup[];
  categoryPaths: string[];
}

// noteCount 改名为 sourceCount — 与 SourceView 类型名对齐 (round 2 review R2-C1)。
// pointCount 保持，因为它确实是 source_entity_points 表的 count。
export interface SourceViewStats {
  sourceCount: number;
  pointCount: number;
}

export interface SourceViewRepository {
  listSourceViewWithCategories(): SourceViewListItem[];
  getSourceViewDetail(sourceId: number): SourceViewDetail | undefined;
  getSourceViewTags(sourceId: number): string[];
  getSourceViewStats(): SourceViewStats;
  getRecentSourceViews(limit: number): SourceViewListItem[];
}

// ─── RuntimeConfigOverrideRepository ────────────────────────
export interface RuntimeConfigOverrideRepository {
  /** Get all overrides as a Map. Used by ConfigStore.refresh / merge. */
  list(): Map<string, string>;
  /** Upsert a single key. */
  upsert(key: string, value: string): void;
  /** Delete a single key. No-op if absent. */
  remove(key: string): void;
  /** Apply patch in a transaction. null value = remove. */
  applyPatch(patch: ReadonlyMap<string, string | null>): void;
}
