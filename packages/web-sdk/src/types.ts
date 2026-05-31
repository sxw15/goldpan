// packages/web-sdk/src/types.ts
//
// Self-contained API types for @goldpan/web-sdk.
// These mirror the server's JSON response shapes (Phase 1 endpoints).
// NO imports from @goldpan/core — types are independently maintained.

// ---------------------------------------------------------------------------
// Generic
// ---------------------------------------------------------------------------

export interface PaginatedList<T> {
  data: T[];
  total: number;
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export interface GoldpanClientOptions {
  /** Server base URL, e.g. 'http://localhost:3001' or '/api' */
  baseUrl: string;
  /** Bearer token for Authorization header (server-to-server / SSR) */
  token?: string;
  /**
   * Fetch credentials mode. Set to 'include' for browser cookie-based auth.
   * Defaults to 'same-origin'.
   */
  credentials?: 'include' | 'omit' | 'same-origin';
  /**
   * Called on 401 responses from protected endpoints (expired or missing
   * session). NOT invoked for `login()` — a 401 there means the password is
   * wrong, which is surfaced via `GoldpanApiError` instead.
   */
  onUnauthorized?: () => void;
  /**
   * Retry on transient network failures (fetch throwing TypeError such as
   * `ECONNREFUSED` while a server is mid-restart). Only network failures
   * retry — HTTP status errors are returned immediately so the caller can
   * decide. Default: no retries (fail fast).
   *
   * Use case: SSR clients during a `pnpm dev` server restart, where the
   * web process has finished cold-compiling a page faster than the server
   * process has finished `bootstrap → composeIMRuntime → server.listen()`.
   * A small retry budget here recovers the SSR transparently instead of
   * landing the user on the `error.tsx` boundary.
   */
  retryNetworkErrors?: {
    /** Total attempts including the first one. e.g. 3 = 1 try + 2 retries. */
    attempts: number;
    /** Base backoff in ms — multiplied by attempt index for exponential. */
    baseDelayMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface SystemStatus {
  authenticated: boolean;
  authRequired: boolean;
  language: string;
  features: {
    embedding: boolean;
    relations: boolean;
    debug: boolean;
  };
  config: {
    maxTextInputLength: number;
  };
}

/**
 * Server response to POST /auth/login.
 *
 * - When the server has **no** `authPassword` configured, the server returns
 *   `{ authenticated: true }` with no token. All fields are optional.
 * - When authentication succeeds with a password configured, `token` and
 *   `expiresAt` are returned.
 */
export interface LoginResult {
  token?: string;
  expiresAt?: string;
  authenticated?: boolean;
}

// ---------------------------------------------------------------------------
// Input (POST /input — discriminated union by `type`)
// ---------------------------------------------------------------------------

/**
 * Request shape for `client.input()` / POST /input.
 *
 * `forcedIntent` + `payload` 在 API surface 必须成对存在（P4 §22）：chip click
 * 把分类器 clarify 候选的 `intentKey` + `payload` 一起送回 server 跳过 LLM
 * classification，plugin 拿到 `IntentExecutionContext.payload` 解析 chip 上下文。
 * free-text 路径 (普通用户输入) 两者都 undefined。
 */
export interface InputParams {
  input: string;
  conversationId?: number;
  sessionKey?: string;
  /** P4: skip classifier and force this intent (clarify chip path / IM bound-intent). */
  forcedIntent?: string;
  /** P4: opaque payload paired with forcedIntent; plugins decide shape. */
  payload?: string;
}

export type InputResult =
  | InputSubmitResult
  | InputQueryResult
  | InputContentResult
  | InputActionResult
  | InputClarifyResult
  | InputWaitResult
  | InputNoteResult
  | InputTrackingPendingResult;

// ─── P2 keyed clarify / wait / note 枚举 ─────────────────────────────────────
//
// 与 packages/core/src/intent/types.ts 同名枚举一一对应；web-sdk「自包含类型」
// 原则要求在这里独立维护（不 import @goldpan/core）。drift 由两侧手工同步守护，
// 跟 MANAGED_ENV_KEYS / DUAL_PROCESS_RESTART_KEYS 的策略一致。

/** UI 路由 clarify 提示的语义 key。Server LLM 输出的就是这些字面量，
 * UI 端按 key 走 i18n 翻译，避免 LLM 输出语言与 UI locale 不一致。 */
export type ClarifyQuestionKey =
  | 'ambiguous_intent'
  | 'unclear_target'
  | 'incomplete_action'
  | 'tracking_resolve_entity';

/** Clarify 候选选项对应的 intent 白名单 — UI 不接 free-text，按 key i18n。 */
export type ClarifyOptionIntentKey =
  | 'create_note'
  | 'submit_url'
  | 'query'
  | 'create_tracking'
  | 'submit_text'
  | 'record_thought'
  | 'resolve_tracking_entity';

/** Wait 决策的 fallback intent 白名单 — 只能是无 deferred 依赖的 intent。 */
export type WaitFallbackIntent = 'submit_url' | 'query' | 'create_note';

/** Wait 触发原因的语义 key — UI 按 key i18n。 */
export type WaitReasonKey =
  | 'incomplete_referent'
  | 'incomplete_command'
  | 'awaiting_url'
  | 'awaiting_clarification';

/** Tracking pending 触发原因。 */
export type TrackingPendingReasonKey = 'waiting_pipeline' | 'multi_entity_clarify';

/**
 * Note subtype — 与 NOTE_SUBTYPES（core/src/notes/types.ts）保持一致。
 * Source of truth for both the runtime tuple and the union type — consumers
 * that need to iterate (e.g. chip rows, filter buttons) import the tuple
 * instead of re-declaring `['memo', 'note']` next to the type.
 * 只剩两类：`memo` 触发提醒，`note` 是默认桶。
 */
export const NOTE_SUBTYPES = ['memo', 'note'] as const;
export type InputNoteSubtype = (typeof NOTE_SUBTYPES)[number];

/** Minimum saved note content length required before promoting a note to source. */
export const PROMOTE_NOTE_MIN_CONTENT_LENGTH = 600;

/** Note 与 source 之间的关系类型 — 与 NOTE_SOURCE_RELATIONS 保持一致。 */
export type InputNoteSourceRelation = 'reference' | 'derived_from';

/**
 * Discriminated union of the three submit-shaped responses from POST /input.
 * Narrow on `status` to access status-specific fields without optional chaining.
 */
export type InputSubmitResult = InputSubmitAccepted | InputSubmitDuplicate | InputSubmitRejected;

export interface InputSubmitAccepted {
  type: 'submit';
  status: 'accepted';
  taskId: number;
  warnings: string[];
  /** When the intent-submit plugin classified the input as a subjective
   * opinion (`record_thought`), the web client renders a NoteBubbleCard
   * instead of TaskBubbleCard. Only present on accepted opinion submissions. */
  inputMode?: 'fact' | 'opinion';
  /** Present when client supplied sessionKey / conversationId. */
  conversationId?: number;
}

export interface InputSubmitDuplicate {
  type: 'submit';
  status: 'duplicate';
  message: string;
  /** Earliest pipeline task that already processed this URL. May be `null` if
   * the original task was deleted but the source row remains. */
  existingTaskId: number | null;
  /** Source id of the previously-submitted URL. Useful for jumping to
   * `/library?focus=<id>&kind=source`. */
  existingSourceId: number;
  /** Original-form URL of the existing source — what the user originally
   * submitted, not the normalized form. Surfaced in the duplicate bubble so
   * users can confirm the match. */
  existingUrl: string;
  /** Present when client supplied sessionKey / conversationId. */
  conversationId?: number;
}

export interface InputSubmitRejected {
  type: 'submit';
  status: 'rejected';
  code: string;
  reason: string;
  /** Present when client supplied sessionKey / conversationId. */
  conversationId?: number;
}

export interface CitedEntity {
  id: number;
  name: string;
  categoryPaths: string[];
}

export interface InputQueryResult {
  type: 'query';
  query: string;
  answer: string;
  confidence: 'high' | 'medium' | 'low' | 'no_data';
  citedEntityIds: number[];
  citedPointIds: number[];
  citedEntities?: CitedEntity[];
  /** Present when client supplied sessionKey / conversationId. */
  conversationId?: number;
}

export interface InputContentResult {
  type: 'content';
  text: string;
  format?: 'text' | 'markdown';
  title?: string;
  /** Present when client supplied sessionKey / conversationId. */
  conversationId?: number;
}

export interface InputActionResult {
  type: 'action';
  message: string;
  actionId?: string;
  /** Present when client supplied sessionKey / conversationId. */
  conversationId?: number;
}

/**
 * Clarify 响应同时承载两套字段：
 *
 * - **Legacy**（`question` / `options`）：兼容老 UI / 外部 plugin（tracking /
 *   github-intent / digest 等）输出 free-text 提示。P2 不强制全 plugin 迁移；
 *   P6 cleanup 时删。
 * - **P2 keyed**（`questionKey` / `structuredOptions`）：classifier 路径产物，
 *   UI 应优先消费这两个字段走 i18n，避免 LLM 输出语言与 UI locale 不一致。
 *
 * Server 端两套字段同时序列化（见 apps/server/src/main.ts switch 'clarify'），
 * 消费方根据 `questionKey` 是否存在决定走 keyed 还是 legacy 渲染。`question`
 * 在 server 同时序列化时也是可选 — 老 plugin 可能只回 keyed，新 classifier
 * 路径同时回两份；为允许两种情形把 legacy 字段都标可选。
 */
export interface InputClarifyResult {
  type: 'clarify';
  // Legacy fields — P6 cleanup 时删
  question?: string;
  options?: string[];
  // P2 keyed fields — UI 优先消费
  questionKey?: ClarifyQuestionKey;
  structuredOptions?: Array<{
    intentKey: ClarifyOptionIntentKey;
    /** classifier 透传的实体名 / URL 等附加上下文，UI 可拼回提示语。 */
    payload?: string;
  }>;
  /** Present when client supplied sessionKey / conversationId. */
  conversationId?: number;
}

/**
 * Wait 响应：当 LLM classifier 判断 user turn 不完整（"明天那个..."）或在等待
 * 后续 URL / 澄清时，server 会把 user message buffer 住等下一轮再合并 intent
 * 分类。caller 用 `bufferedMessageId` 关联到 buffer 行；超过 `expiresAt`
 * 后路径自动降级为 `fallbackIntent` 立即执行。
 *
 * 与 `error` 不同：wait 是预期路径，UI 不应弹错误，而是展示「正在等下一句」
 * 提示。`waitReasonKey` 给 UI 选择不同 copy（incomplete_command vs awaiting_url）。
 */
export interface InputWaitResult {
  type: 'wait';
  /** conversation_messages.id of the just-buffered user turn. */
  bufferedMessageId: number;
  /** Absolute expiry timestamp in epoch ms (now + maxWaitMs). */
  expiresAt: number;
  fallbackIntent: WaitFallbackIntent;
  maxWaitMs: number;
  waitReasonKey: WaitReasonKey;
  /** Present when client supplied sessionKey / conversationId. */
  conversationId?: number;
}

/**
 * Note 响应：intent-note plugin 创建笔记后回的扁平 note 对象（注意不是
 * 完整 NoteDetail —— server 在 main.ts switch 'note' 里只透传 7 个字段，
 * 不带 contentTranslated / pinned / archived / sourceMessageId / updatedAt /
 * language 等管理字段；UI 后续 detail 页通过 `getNote(id)` 单独拉）。
 *
 * 把这一层独立成 InputNoteResult.note 而不是直接复用 NoteDetail 是因为
 * 这是 server `/input` 路由实际序列化的子集；用全 NoteDetail 会让消费方
 * 误以为可以访问 server 没回的字段。
 */
export interface InputNoteResult {
  type: 'note';
  note: {
    id: number;
    content: string;
    subtype: InputNoteSubtype;
    tags: string[];
    linkedEntities: Array<{ id: number; name: string }>;
    linkedSources: Array<{
      id: number;
      relation: InputNoteSourceRelation;
      title: string | null;
      originalUrl: string | null;
      rawContentPreview?: string | null;
    }>;
    createdAt: number;
  };
  /** Present when client supplied sessionKey / conversationId. */
  conversationId?: number;
}

/**
 * Tracking pending 响应：当用户输入要求新建 tracking rule 但 pipeline 还没
 * 完成 / 多 entity 待 clarify 时，server 先建 rule 占位，回 `trackingRuleId`
 * 让 UI 可以跳转到详情页等结果。`reasonKey` 给 UI 选择不同 copy。
 */
export interface InputTrackingPendingResult {
  type: 'tracking_pending';
  trackingRuleId: number;
  reasonKey: TrackingPendingReasonKey;
  /** Present when client supplied sessionKey / conversationId. */
  conversationId?: number;
}

// ---------------------------------------------------------------------------
// Submit (POST /submit — discriminated union by `status`)
// ---------------------------------------------------------------------------

export type SubmitResult = SubmitAccepted | SubmitDuplicate | SubmitRejected;

export interface SubmitAccepted {
  status: 'accepted';
  taskId: number;
  warnings: string[];
}

export interface SubmitDuplicate {
  status: 'duplicate';
  message: string;
  existingSourceId: number;
  existingTaskId: number | null;
  existingUrl: string;
}

export interface SubmitRejected {
  status: 'rejected';
  code: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Query (POST /query)
// ---------------------------------------------------------------------------

export interface QueryResult {
  type: 'query';
  answer: string;
  confidence: 'high' | 'medium' | 'low' | 'no_data';
  citedEntityIds: number[];
  citedPointIds: number[];
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'processing' | 'done' | 'error';

export type TaskStatusCounts = Record<TaskStatus, number>;

export interface TaskListParams {
  limit?: number;
  /** Server-side filter; omitted = all statuses. Sent as comma-joined querystring. */
  status?: readonly TaskStatus[];
}

export interface TaskListResponse {
  data: Task[];
  total: number;
  /** Counts per status across the whole table — independent of `status` filter. */
  counts: TaskStatusCounts;
}

// Note: Pagination (page/offset) is not yet supported by the server's GET /tasks endpoint.
// When server-side pagination is implemented, add `page?: number` here and update
// GoldpanClient.getTasks() to pass it as a query parameter.

export interface TaskSource {
  originalUrl: string | null;
  normalizedUrl: string | null;
  title?: string | null;
  rawContentPreview?: string | null;
  status: string;
  kind: 'external' | 'user';
  origin: string;
}

/** Task list item (GET /tasks) */
export interface Task {
  id: number;
  sourceId: number;
  status: TaskStatus;
  createdAt: number;
  pipelineStep: string | null;
  inputType: string | null;
  result: Record<string, unknown> | null;
  errorKind: string | null;
  /**
   * Wall-clock seconds across all task_logs; null when no logs exist yet.
   * Reflects only the **latest attempt** — task_logs are reset on retry while
   * llm_calls below are not, so durationS / llmCount have different windows
   * (see CHANGELOG: "Task aggregate fields"). Display them in distinct
   * columns rather than implying a per-attempt rate.
   */
  durationS: number | null;
  /** Total llm_calls observed for this task's source — **cumulative across
   * all retries**, since llm_calls survive `resetForRetry`. Pair with
   * `retryCount` to surface "5 calls (2 retries)" rather than implying the
   * count belongs to the latest attempt only. */
  llmCount: number;
  /** Subset of llmCount where attempt_number > 1. */
  retryCount: number;
  source: TaskSource | null;
}

/** Task detail (GET /tasks/:id — discriminated union by `status`) */
export type TaskDetail = TaskPending | TaskProcessing | TaskDone | TaskError;

interface TaskDetailBase {
  taskId: string;
  sourceId: number;
  sourceUrl: string | null;
  createdAt: number;
  sourceStatus: string | null;
  logs: TaskLog[];
}

export interface TaskPending extends TaskDetailBase {
  status: 'pending';
}

export interface TaskProcessing extends TaskDetailBase {
  status: 'processing';
  pipelineStep: string | null;
}

export interface TaskDone extends TaskDetailBase {
  status: 'done';
  result: Record<string, unknown>;
}

export interface TaskError extends TaskDetailBase {
  status: 'error';
  error: {
    step: string;
    kind: string;
    message: string;
    retryable: boolean;
  };
}

/**
 * Canonical task error kinds — mirror of core `PIPELINE_ERROR_KINDS`
 * (`packages/core/src/errors.ts`). Re-declared here (not imported) per web-sdk's
 * self-contained-types rule; `packages/web-sdk/tests/task-error-kinds-sync.test.ts`
 * asserts array parity with core so this mirror can't silently drift (the web's
 * `error_kind_*` i18n coverage is guarded separately by
 * `apps/web/src/lib/task-error.test.ts`). The web still localizes unrecognized
 * kinds as `unknown` at runtime (forward-compat) — the list + tests just make
 * divergence loud at build time. Same guard pattern as MANAGED_ENV_KEYS.
 */
export const TASK_ERROR_KINDS = [
  'schema_validation',
  'content_policy',
  'content_length',
  'rate_limit',
  'timeout',
  'not_found',
  'unknown',
] as const;

export type TaskErrorKind = (typeof TASK_ERROR_KINDS)[number];

export interface TaskLog {
  id: number;
  taskId: number;
  step: string;
  event: string;
  message: string | null;
  inputSummary: string | null;
  outputSummary: string | null;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export interface Category {
  id: number;
  name: string;
  path: string;
  parentId: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Alias for spec compatibility — flat list, callers build tree if needed */
export type CategoryTree = PaginatedList<Category>;

export interface EntityListParams {
  category?: number;
}

/** Entity list item (GET /entities) */
export interface Entity {
  id: number;
  name: string;
  categoryPaths: string[];
  activePointCount: number;
  createdAt: number;
}

/**
 * Response shape for `GET /entities?name=...&name=...` — keyed by lowercased
 * entity name → entity id. Used by P7.3 mention parsing to resolve @name tokens.
 * Distinct from `PaginatedList<Entity>` (list mode response shape) so the
 * two call sites can't be mixed by accident.
 */
export interface EntityNameLookupResult {
  data: Record<string, number>;
}

export type SourceStatus = 'processing' | 'confirmed' | 'confirmed_empty' | 'failed' | 'discarded';

/** Source list item (GET /sources) */
export interface SourceListItem {
  id: number;
  kind: 'external' | 'user';
  originalUrl: string | null;
  normalizedUrl: string | null;
  title: string | null;
  status: SourceStatus;
  origin: string;
  createdAt: number;
  /** DISTINCT pointId, includes judgment='skipped' rows (Library "covers how many KPs" semantics). */
  kpCount: number;
  /** DISTINCT entityId, includes judgment='skipped'. */
  entityCount: number;
  /** Up to 3, sorted by per-entity kpCount DESC; ties broken by entityId ASC. */
  topEntities: { id: number; name: string }[];
  /** Deduped category paths from all linked entities. */
  entityCategoryPaths: string[];
  /** First 80 chars of rawContent when kind='user'; always null when kind='external'. */
  preview: string | null;
}

export type SourceStatusCounts = Record<SourceStatus, number>;

export interface SourceListResponse extends PaginatedList<SourceListItem> {
  /** Table-wide counts, unaffected by filter. */
  counts: SourceStatusCounts;
}

export interface SourceListParams {
  /** Single value or array; arrays sent as comma-joined querystring. */
  status?: SourceStatus | readonly SourceStatus[];
  origin?: 'user' | 'tracking' | 'github_refresh';
  limit?: number;
}

/** Source detail (GET /sources/:id) */
export interface SourceDetail {
  source: {
    id: number;
    kind: 'external' | 'user';
    originalUrl: string | null;
    normalizedUrl: string | null;
    title: string | null;
    status: SourceStatus;
    origin: string;
    createdAt: number;
    updatedAt: number;
  };
  entities: { id: number; name: string; categoryPaths: string[] }[];
  entityCount: number;
}

/** Entity detail (GET /entities/:id) */
export interface EntityDetail {
  entity: {
    id: number;
    name: string;
    description: string | null;
    /**
     * Translation of `description` into the configured pipeline language,
     * produced when `GOLDPAN_TRANSLATE_PIPELINE_OUTPUT=true`. NULL means the
     * translating step was off / had no translation — UI falls back to
     * `description`.
     */
    descriptionTranslated: string | null;
    aliases: string[];
    keywords: string[];
    categoryPaths: string[];
  };
  points: KnowledgePoint[];
  sources: EntitySource[];
  relations: EntityRelation[];
  /** Present and non-null when any associated source was collected by `collector-github`. */
  githubRepo?: GithubRepoSummary | null;
}

export interface KnowledgePoint {
  id: number;
  content: string;
  /** Translation of `content`; NULL = no translation, UI falls back to `content`. */
  contentTranslated: string | null;
  type: string;
  status: string;
  createdAt: number;
}

export interface EntitySource {
  id: number;
  originalUrl: string | null;
  status: string;
}

export interface EntityRelation {
  id: number;
  sourceEntityId: number;
  targetEntityId: number;
  sourceEntityName: string;
  targetEntityName: string;
  relationType: string;
  description: string;
  /** Translation of `description`; NULL = no translation, UI falls back to `description`. */
  descriptionTranslated: string | null;
}

// ---------------------------------------------------------------------------
// SourceView Library (legacy 错误命名: 历史叫 NoteListParams / NoteDetail；
// 2026-05-19 P6 改成 SourceView* 以释放 Note* 给真正的 user notes)
// ---------------------------------------------------------------------------

export interface SourceViewListParams {
  category?: number;
}

export interface SourceViewListItem {
  id: number;
  kind: 'external' | 'user';
  title: string | null;
  originalUrl: string | null;
  createdAt: number;
  categoryIds: number[];
}

// R2-C1: noteCount 字段名 misleading，改为 sourceCount 与 SourceView 类型对齐
export interface SourceViewStats {
  sourceCount: number;
  pointCount: number;
}

export interface SourceViewListResult {
  data: SourceViewListItem[];
  total: number;
  categories: Category[];
  stats: SourceViewStats;
}

export interface SourceViewEntityGroup {
  entityId: number;
  entityName: string;
  points: Array<{
    id: number;
    content: string;
    /** Translation of `content`; NULL means no translation, UI falls back to `content`. */
    contentTranslated: string | null;
    type: string;
  }>;
}

export interface SourceViewMeta {
  id: number;
  kind: string;
  normalizedUrl: string | null;
  originalUrl: string | null;
  title: string | null;
  rawContent: string | null;
  metadata: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  origin: string;
  trackingRuleId: number | null;
}

// sdk SourceViewDetail 比 core 多 `tags` 字段 —— server route (notes.ts:57-58)
// 通过 getSourceViewTags 单独 attach 进 response。保留 sdk 一侧的 tags。
export interface SourceViewDetail {
  source: SourceViewMeta;
  entities: SourceViewEntityGroup[];
  categoryPaths: string[];
  tags: string[];
}

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

export interface DebugTask {
  id: number;
  sourceId: number;
  status: string;
  pipelineStep: string | null;
  inputType: string | null;
  errorMessage: string | null;
  errorKind: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LlmCallMeta {
  id: number;
  step: string;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  promptHash: string;
  sourceId: number | null;
  outcome: string;
  failureKind: string | null;
  failureMessage: string | null;
  attemptNumber: number;
  timestamp: number;
}

export interface EventLog {
  id: number;
  sourceId: number;
  entityId: number | null;
  pointId: number | null;
  action: string;
  timestamp: number;
  summary: string | null;
}

export interface SubmissionLog {
  id: number;
  rawInput: string;
  result: string;
  reason: string | null;
  taskId: number | null;
  sourceId: number | null;
  createdAt: number;
}

export interface DebugTaskSource {
  id: number;
  kind: 'external' | 'user';
  title: string | null;
  originalUrl: string | null;
  normalizedUrl: string | null;
  status: string;
  origin: string;
  rawContentPreview: string | null;
}

export interface DebugTaskDetail {
  task: DebugTask;
  source: DebugTaskSource | null;
  logs: TaskLog[];
  llmCalls: LlmCallMeta[];
  eventLogs: EventLog[];
  submissionLogs: SubmissionLog[];
}

export interface LlmCallDetail {
  requestBody: string | null;
  responseBody: string | null;
  requestSchema: string | null;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * Wire shape for one IM runtime channel inside a `/health` response. Mirrors
 * `apps/server/src/health.ts:HealthChannelView`. Kept self-contained in this
 * file so SDK consumers don't have to install `@goldpan/im-runtime` for type
 * resolution. Drift safety lives in `health.test.ts` on the server side
 * (which structurally pins this against the runtime's `ChannelDescriptor`).
 *
 * Note on `lastErrorAt`: the server-side type is `Date`, but it travels over
 * JSON as an ISO-8601 string. The SDK reflects the wire form callers actually
 * receive after `await response.json()`.
 */
export interface HealthChannelView {
  channelId: string;
  state: 'starting' | 'running' | 'shutting_down' | 'stopped' | 'error';
  account?: { id: string; displayName?: string };
  inFlightCount: number;
  lastErrorAt?: string;
  lastErrorMessage?: string;
}

/**
 * Wire shape for `GET /health`. Discriminated by `status`:
 *
 * - `ok` / `degraded` — normal-mode response. `worker.running` plus the
 *   channels array tell ops whether the worker loop is alive and IM channels
 *   are healthy. `pendingRestartKeys` lists restart-required keys committed
 *   since boot whose effective value still differs from the boot baseline,
 *   so external monitors and the settings UI can keep nagging. `dualProcessConfigHash`
 *   is a 16-hex SHA-256 fingerprint of `HASH_FINGERPRINT_KEYS` for cross-process
 *   drift detection (see `@goldpan/web-sdk/health-hash`). `degraded` responses
 *   also carry the error envelope fields (`type`/`code`/`message`).
 * - `wizard` — server is in onboarding/wizard mode. Only `reason` is populated;
 *   the worker is not running so monitoring fields are intentionally omitted.
 *
 * Discriminated union shape lets TS narrow correctly: callers writing
 * `if (h.status === 'wizard')` get just `reason`; the `ok`/`degraded` branch
 * gets the full ops payload without optional `?` everywhere.
 */
export type HealthStatus =
  | {
      status: 'ok' | 'degraded';
      worker: { running: boolean };
      channels: HealthChannelView[];
      pendingRestartKeys: string[];
      dualProcessConfigHash: string;
      type?: 'error';
      code?: 'worker_not_running';
      message?: string;
    }
  | { status: 'wizard'; reason: string };

// ---------------------------------------------------------------------------
// GitHub (Phase 1 refresh)
// ---------------------------------------------------------------------------

export type GithubRefreshResult =
  | { status: 'started'; sourceId: number; taskId: number }
  | { status: 'in_progress'; sourceId: number; taskId: number; startedAt: number }
  | { status: 'too_recent'; retryAfterSeconds: number; lastRefreshedAt: number }
  | { status: 'rate_limited'; resetsAt: number }
  | { status: 'not_found' }
  | { status: 'archived'; archivedAt: number | null };

export interface GithubRepoState {
  normalizedUrl: string;
  refreshCount: number;
  lastRefreshedAt: number | null;
  lastCommitSha: string | null;
  lastReleaseTag: string | null;
  archived: boolean;
}

export interface GithubRepoSummary {
  owner: string;
  repo: string;
  normalizedUrl: string;
  archived: boolean;
  lastRefreshedAt: number | null;
}

// ---------------------------------------------------------------------------
// Tracking / Interest
// ---------------------------------------------------------------------------
//
// NOTE: `Interest` mirrors `plugins/tracking/src/types.ts` by duck-typing —
// the SDK MUST NOT import from `@goldpan/core` or plugin code, so the two
// TS definitions are independent. The three-side drift contract (plugin TS /
// server route JSON / SDK TS) is asserted at test time against
// `packages/web-sdk/tests/fixtures/interest.fixture.ts`.

export interface Interest {
  id: number;
  name: string;
  description: string | null;
  searchQueries: string[];
  toolProvider: string | null;
  intervalMinutes: number;
  enabled: boolean;
  status: 'idle' | 'executing';
  lastRunAt: number | null;
  nextRunAt: number | null;
  linkedEntityIds: number[];
  createdAt: number;
  updatedAt: number;
}

export interface InterestListItem extends Interest {
  linkedEntityCount: number;
  /** Lifetime sum of `items_found` across all executions of this interest. */
  totalHits: number;
  /** `items_found` summed over executions started in the last 24h (UTC). */
  newHits24h: number;
  /** Lifetime sum of `items_submitted` (the "ingested into knowledge" count). */
  ingestedTotal: number;
  /**
   * Hit count per UTC day, oldest → newest. Always 14 elements; days with
   * no executions are zero-filled. Front-end relies on the fixed length
   * for sparkline rendering — see `plugins/tracking/src/types.ts`
   * `InterestStats` for the contract.
   */
  sparkline: number[];
}

export interface InterestExecution {
  id: number;
  /**
   * Owning interest id. Required so consumers of `/tracking/executions/:id`
   * can resolve which interest produced the execution without a second
   * round-trip. Historically this was `ruleId`; the rename to `interestId`
   * matches the V1→V2 `rule → interest` rename elsewhere in the plugin.
   */
  interestId: number;
  status: 'running' | 'done' | 'error';
  itemsFound: number;
  itemsSubmitted: number;
  startedAt: number;
  finishedAt: number | null;
  errorMessage: string | null;
}

/**
 * Single execution-item (a search-result URL). Served via
 * GET /tracking/executions/:id → `{data.items}`. Note the server strips
 * `sourceId` from each item before responding; if a field surfaces here
 * the server route is out of sync and the three-side contract test will
 * fail (server tracking.test.ts key-set check).
 */
export interface InterestItem {
  id: number;
  url: string;
  title: string | null;
  snippet: string | null;
  publishedAt: number | null;
  status: 'found' | 'submitted' | 'duplicate' | 'failed';
}

export interface InterestExecutionDetail extends InterestExecution {
  items: InterestItem[];
}

export interface InterestExecutionListParams {
  page?: number;
  perPage?: number;
}

export interface InterestExecutionListResult {
  data: InterestExecution[];
  total: number;
  page: number;
  perPage: number;
}

export interface InterestLinkedEntity {
  id: number;
  name: string;
  categoryPaths: string[];
}

export interface InterestDetail {
  interest: Interest;
  linkedEntities: InterestLinkedEntity[];
  recentExecutions: InterestExecution[];
}

export interface CreateInterestInput {
  name: string;
  description?: string;
  searchQueries: string[];
  intervalMinutes?: number;
  linkedEntityIds?: number[];
  toolProvider?: string;
  enabled?: boolean;
}

export type UpdateInterestInput = Partial<Omit<CreateInterestInput, 'enabled'>>;

/**
 * Result of `GET /tracking/search-tool-status`. `configured` is `true` iff
 * the plugin registry has at least one tool plugin that exposes a `search`
 * tool — i.e. a search-API plugin (tavily / serper / google) finished its
 * initialize() with a non-empty `tools` array. `providers` lists those
 * plugin names so the caller can show them or pick a default.
 */
export interface SearchToolStatus {
  configured: boolean;
  providers: string[];
}

/**
 * Result of `POST /tracking/rules/:id/resolve`. UI clarify-chip click promotes
 * an `awaiting_clarify` tracking rule to `resolved` by binding the user-picked
 * entity. `entityName` is echoed by the server so the bubble copy doesn't
 * need an extra round-trip to render the entity label.
 *
 * Failure cases (404 rule_not_found / 409 invalid_status / 409 race_conflict /
 * 400 invalid_entity_id) come back as `GoldpanApiError` from `request()`; the
 * 200-OK envelope is always `resolved: true`.
 */
export interface ResolveTrackingResult {
  resolved: boolean;
  ruleId: number;
  entityId: number;
  entityName: string;
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

export type DigestPeriod = 'daily' | 'weekly';
export type DigestChannelSlot =
  | 'tracking_findings'
  | 'captures'
  | 'thoughts'
  | 'new_entities'
  | 'stats'
  | 'ai_summary';

/**
 * 时间窗口锚定方式 — calendar 对齐本地零点(daily=昨天 00:00..23:59、
 * weekly=过去 7 个完整日历日);rolling 以 snapshot 生成时刻为锚点
 * (daily=now-24h..now、weekly=now-7d..now)。
 */
export type DigestWindowMode = 'calendar' | 'rolling';

export interface DigestPreset {
  id: number;
  channel: string;
  name: string;
  period: DigestPeriod;
  pushDay: number | null;
  /** HH:MM 24h。preset 默认推送时间;IM 订阅创建时未显式指定 pushTime 时回退到它。 */
  pushTime: string;
  /** 时间窗口锚定方式 — 见 {@link DigestWindowMode}。 */
  windowMode: DigestWindowMode;
  slots: DigestChannelSlot[];
  skipEmpty: boolean;
  includeAiSummary: boolean;
  isDefault: boolean;
}

/** 渲染层用的 DigestPreset 子集;null ≡ 无 preset,fall back to all-slots default。
 * period 决定 section title 用「今日」/「本周」prefix —— 不带的话 section 无法
 * 与顶部 hero 副标题保持同步,会出现「过去 24 小时」+「本周追踪结果」的矛盾。 */
export type DigestRenderPreset = Pick<
  DigestPreset,
  'slots' | 'skipEmpty' | 'includeAiSummary' | 'period'
>;

export type DigestSnapshotStatus = 'cached' | 'generated' | 'missing' | 'pending';

/** snapshot 非 null 的 status branch。 */
export type DigestResolvedStatus = Exclude<DigestSnapshotStatus, 'missing'>;

export type DigestRelationType =
  | 'organizational'
  | 'competitive'
  | 'collaborative'
  | 'technical'
  | 'causal'
  | 'general';

export interface DigestSnapshotModules {
  tracking_findings: {
    type: 'tracking_findings';
    items: Array<{
      id: number;
      ruleId: number | null;
      title: string;
      url: string;
      createdAt: number;
    }>;
    hasMore: boolean;
    hiddenCount: number;
  };
  captures: {
    type: 'captures';
    items: Array<{ id: number; title: string; url: string; createdAt: number }>;
    hasMore: boolean;
    hiddenCount: number;
  };
  thoughts: {
    type: 'thoughts';
    items: Array<{ id: number; text: string; createdAt: number }>;
    hasMore: boolean;
    hiddenCount: number;
  };
  new_entities: {
    type: 'new_entities';
    items: Array<{ id: number; name: string; description: string | null; createdAt: number }>;
    hasMore: boolean;
    hiddenCount: number;
  };
  stats: {
    type: 'stats';
    captures: number;
    findings: number;
    thoughts: number;
    entities: number;
  };
}

export interface DigestDataSnapshot {
  digestId: { channel: string; date: string; presetId: number | null };
  period: DigestPeriod;
  generatedAt: number;
  modules: DigestSnapshotModules;
  aiSummary: { status: 'pending' | 'complete' | 'fallback'; text: string };
}

/** missing 分支 snapshot=null;其余分支 snapshot 非空 — 通过 status 判别。 */
export type DigestSnapshotResponse =
  | { snapshot: null; generatedAt: null; status: 'missing' }
  | { snapshot: DigestDataSnapshot; generatedAt: number; status: DigestResolvedStatus };

/**
 * Share 永远 resolved (missing → 410 upstream),preset null → channel-level
 * snapshot,consumer 退化到默认 render。
 */
export interface DigestShareResponse {
  snapshot: DigestDataSnapshot;
  generatedAt: number;
  status: DigestResolvedStatus;
  channel: string;
  date: string;
  presetId: number | null;
  preset: DigestRenderPreset | null;
}

export interface DigestConnection {
  id: number;
  createdAt: number;
  relationType: DigestRelationType;
  source: { id: number; name: string; categoryPaths: string[] };
  target: { id: number; name: string; categoryPaths: string[] };
}

export interface DigestConnectionsParams {
  since: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Conversations (web-side persistence)
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  id: number;
  sessionKey: string;
  channelId: string;
  /** null 表示后端派生不到（空对话或仅有 assistant message）；前端用 i18n 回退 "对话 #{id}"。 */
  title: string | null;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
  archivedAt: number | null;
  archivedReason: string | null;
  messageCount: number;
}

export interface ConversationMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  /** P3 buffer mechanism state — surfaces buffered_wait / consumed lifecycle
   * to the UI so it can render BufferedWaitIndicator (countdown / "立即执行"
   * / "取消" controls). Absent / `'normal'` for non-buffered messages. */
  status?: 'normal' | 'buffered_wait' | 'consumed';
  /** Epoch ms when the buffered window expires — UI uses this to drive the
   * countdown. Only meaningful when `status === 'buffered_wait'`. */
  bufferedExpiresAt?: number;
}

// ─── P3 Buffer release / cancel result types ────────────────────────────────
//
// 与 server 端 POST /conversations/buffered/:id/{release,cancel} 的响应一一对应。
// CAS（compare-and-swap）失败时，server 仍返回 200 OK 但 executed=false /
// cancelled=false + reason —— 因为 "already_finalized" 是业务态而非 HTTP 错误。

export interface ReleaseBufferedResult {
  /** true: CAS 成功，buffered message 已被 finalize 并执行原 intent；
   * false: 该 message 已经被 finalize（CAS 失败），看 `reason`。 */
  executed: boolean;
  /** 仅在 executed=false 时出现。当前枚举只有 `'already_finalized'` —— 即
   * 该 message 已经被另一条 release / cancel / 倒计时归零的路径消费。 */
  reason?: 'already_finalized';
  /** 当 executed=true 时返回 finalize 的 InputResult（与 POST /input 的
   * 响应同构）。UI 用它渲染最终结果 bubble。 */
  result?: InputResult;
  conversationId?: number;
}

export interface CancelBufferedResult {
  /** true: CAS 成功，buffered message 已被标记为 cancelled；
   * false: 该 message 已经被 finalize（CAS 失败），看 `reason`。 */
  cancelled: boolean;
  reason?: 'already_finalized';
  conversationId?: number;
}

export interface ConversationDetail {
  id: number;
  sessionKey: string;
  channelId: string;
  archivedAt: number | null;
  messages: ConversationMessage[];
}

export interface ConversationListParams {
  channelId: string;
  limit?: number;
  offset?: number;
  includeActive?: boolean;
}

// ---------------------------------------------------------------------------
// Settings (env-file editing)
// ---------------------------------------------------------------------------

/**
 * One row of `GET /settings/env-state`.
 *
 * - `configured`: live `process.env` carries a non-empty value for this key.
 * - `source`: discriminated three-state literal driven by the server's
 *   `ConfigStore` snapshot:
 *     - `'env'` — value comes from the boot-env baseline (.env file or
 *       external injection captured at process start).
 *     - `'override'` — value comes from a DB-persisted runtime override
 *       (a previous `POST /settings/env` or wizard commit). Overrides
 *       supersede env baselines and apply without a restart.
 *     - `'default'` — no env baseline and no override; the loaded config
 *       fell back to the schema default or the key is unset entirely.
 * - `baselineDiffers`: only meaningful when `source === 'override'`. True
 *   when bootEnv ALSO defines a non-empty value for this key but it
 *   differs from the live override — UI should hint that the .env baseline
 *   disagrees and would re-shadow if the user removes the override.
 * - `mask`: display string. Secret keys (KEY/TOKEN/SECRET/PASSWORD suffix)
 *   come back as `••••<last4>` (or full bullets when shorter than 12 chars);
 *   URL-shaped non-secret keys have embedded `user:pass@` stripped; plain
 *   non-secrets return their full value so the UI can render the current
 *   selection.
 */
export interface EnvKeyState {
  key: string;
  configured: boolean;
  source: 'env' | 'override' | 'default';
  baselineDiffers?: boolean;
  mask: string;
}

export interface EnvStateResponse {
  items: EnvKeyState[];
}

export type PluginType = 'collector' | 'intent' | 'tool' | 'llm-provider';
export type PluginConfigGroupId = 'collect' | 'notify' | 'digest' | 'search' | 'llm';

export interface PluginInfo {
  name: string;
  displayName: string;
  version: string;
  description: string;
  type: PluginType;
  status: 'loaded' | 'failed' | 'skipped_conflict';
  error?: string;
  envKeys: { key: string; configured: boolean }[];
  configGroup?: PluginConfigGroupId;
}

export interface PluginsSnapshot {
  plugins: PluginInfo[];
  registryInstallSupported: false;
}

/**
 * Whitelist of env keys settings UI is allowed to write. Must be kept in sync
 * with `monorepo/packages/core/src/onboarding/env-file.ts` MANAGED_ENV_KEYS;
 * `packages/web-sdk/tests/managed-env-keys-sync.test.ts` enforces this at
 * lint time. We re-declare here instead of importing because web-sdk has a
 * "self-contained types" rule (no `@goldpan/core` import) so it stays usable
 * from apps that don't depend on core.
 */
export const MANAGED_ENV_KEYS = [
  'GOLDPAN_LANGUAGE',
  'GOLDPAN_TRANSLATE_PIPELINE_OUTPUT',
  'GOLDPAN_LLM_TRANSLATOR',
  'GOLDPAN_LLM_TRANSLATOR_TIMEOUT',
  'GOLDPAN_TIMEZONE',
  'GOLDPAN_WEB_ENABLED',
  'GOLDPAN_AUTH_PASSWORD',
  'GOLDPAN_SSRF_VALIDATION_ENABLED',
  'GOLDPAN_LLM_CLASSIFIER',
  'GOLDPAN_LLM_EXTRACTOR',
  'GOLDPAN_LLM_MATCHER',
  'GOLDPAN_LLM_COMPARATOR',
  'GOLDPAN_LLM_VERIFIER',
  'GOLDPAN_LLM_VERIFIER_ENABLED',
  'GOLDPAN_LLM_INTENT',
  'GOLDPAN_LLM_QUERY',
  'GOLDPAN_LLM_RELATOR',
  'GOLDPAN_RELATION_ENABLED',
  'GOLDPAN_LLM_DIGEST_SUMMARY',
  'GOLDPAN_LLM_DIGEST_ACTION',
  'GOLDPAN_LLM_TIMEOUT',
  'GOLDPAN_LLM_CLASSIFIER_TIMEOUT',
  'GOLDPAN_LLM_EXTRACTOR_TIMEOUT',
  'GOLDPAN_LLM_MATCHER_TIMEOUT',
  'GOLDPAN_LLM_COMPARATOR_TIMEOUT',
  'GOLDPAN_LLM_VERIFIER_TIMEOUT',
  'GOLDPAN_LLM_RELATOR_TIMEOUT',
  'GOLDPAN_LLM_INTENT_TIMEOUT',
  'GOLDPAN_LLM_QUERY_TIMEOUT',
  'GOLDPAN_LLM_DIGEST_SUMMARY_TIMEOUT',
  'GOLDPAN_LLM_DIGEST_ACTION_TIMEOUT',
  'GOLDPAN_DIGEST_ENABLED',
  'GOLDPAN_DIGEST_DAILY_TIME',
  'GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE',
  'GOLDPAN_TRACKING_SCHEDULER_ENABLED',
  'GOLDPAN_TRACKING_POLL_INTERVAL',
  'GOLDPAN_TRACKING_DAILY_SEARCH_LIMIT',
  'GOLDPAN_TRACKING_MIN_RULE_INTERVAL',
  'GOLDPAN_TRACKING_MAX_RESULTS_PER_SEARCH',
  'GOLDPAN_EMBEDDING_ENABLED',
  'GOLDPAN_EMBEDDING_MODEL',
  'GOLDPAN_EMBEDDING_DIMENSIONS',
  'GOLDPAN_EMBEDDING_BATCH_SIZE',
  'GOLDPAN_IM_TELEGRAM_BOT_TOKEN',
  'GOLDPAN_IM_TELEGRAM_ALLOWED_CHAT_IDS',
  'GOLDPAN_IM_TELEGRAM_ENABLED',
  'GOLDPAN_IM_FEISHU_APP_ID',
  'GOLDPAN_IM_FEISHU_APP_SECRET',
  'GOLDPAN_IM_FEISHU_ENCRYPT_KEY',
  'GOLDPAN_IM_FEISHU_DOMAIN',
  'GOLDPAN_IM_FEISHU_ENABLED',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_BASE_URL',
  'OPENAI_BASE_URL',
  'OLLAMA_BASE_URL',
  'GOLDPAN_OLLAMA_ENABLED',
  'OPENROUTER_BASE_URL',
  'TAVILY_API_KEY',
  'SERPER_API_KEY',
  'EXA_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'SEARXNG_BASE_URL',
  'GOLDPAN_GOOGLE_SEARCH_ENABLED',
  'GOLDPAN_GOOGLE_SEARCH_HOURLY_LIMIT',
  'GOLDPAN_GOOGLE_SEARCH_DELAY_MIN_MS',
  'GOLDPAN_GOOGLE_SEARCH_DELAY_MAX_MS',
  'GOLDPAN_COLLECT_TIMEOUT',
  'GOLDPAN_BROWSER_STRATEGY',
  'GOLDPAN_BROWSER_EXECUTABLE_PATH',
  'GOLDPAN_MEDIA_COLLECT_TIMEOUT',
  'GOLDPAN_YT_DLP_AUTO_UPDATE',
  'GOLDPAN_YT_DLP_BINARY_PATH',
  'GOLDPAN_YT_DLP_COOKIES_PATH',
  'GOLDPAN_GITHUB_TOKEN',
  // Content-length limits (hot-reloadable; surfaced in Settings → 采集 · 内容长度).
  // Order MUST match core's MANAGED_ENV_KEYS (managed-env-keys-sync.test.ts).
  'GOLDPAN_MAX_CONTENT_LENGTH',
  'GOLDPAN_MIN_CONTENT_LENGTH',
  'GOLDPAN_MAX_TEXT_INPUT_LENGTH',
] as const;

/**
 * Settings UI accepts these literal env keys with full TypeScript autocomplete.
 * Plugin-declared envKeys (registered at runtime via `PluginRegistry`) also
 * pass through here: the `(string & {})` branch lets TS accept any extra
 * string identifier without collapsing the union into a plain `string`
 * (which would kill autocomplete for the literal half).
 *
 * Runtime enforcement still lives server-side in
 * `core/src/onboarding/env-file.ts` `isManagedEnvKey`, which checks the
 * literal whitelist + plugin-supplied envKeys + dynamic per-patch allowlist.
 * So a typo here yields a runtime 400 from `commitEnv`, not a silent write.
 */
export type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number] | (string & {});

/**
 * Subset of MANAGED_ENV_KEYS that also affects the web (Next.js) process. UI
 * uses this list to decide whether to add a "restart web too" warning to the
 * pending-restart dialog after a commit.
 *
 * Re-declared here to keep web-sdk self-contained (no `@goldpan/core` import).
 * Drift is caught at lint time by `tests/dual-process-restart-keys-sync.test.ts`,
 * matching the MANAGED_ENV_KEYS sync pattern.
 */
export const DUAL_PROCESS_RESTART_KEYS = ['GOLDPAN_LANGUAGE'] as const;

export type DualProcessRestartKey = (typeof DUAL_PROCESS_RESTART_KEYS)[number];

/**
 * Result of `POST /settings/env`. Discriminated union mirrors the server's
 * `configStore.commit` result envelope:
 *
 * - `ok`: validation passed, override persisted into the DB and applied to
 *   `process.env` (no `.env` write — runtime overrides supersede dotenv).
 *   `pendingRestartKeys` lists keys whose new value cannot take effect
 *   until BOTH server and web processes restart — the server captures
 *   `authPassword` / `language` / `webEnabled` at boot for request-scoped
 *   reads, and the separate `apps/web` Node process never observes the
 *   server's runtime override. PR1 surfaces a fixed shortlist
 *   (`STATIC_RESTART_REQUIRED_KEYS` in `@goldpan/core/config`); PR2 will
 *   extend it with plugin-declared `restartRequired` metadata.
 * - `errors`: validation failed. Possible sources, all surfaced under the
 *   same shape so the UI doesn't have to discriminate two error envelopes:
 *   - cross-field rules / base-url SSRF (server commit rejection),
 *   - `unknown_keys` / `invalid_values` / `empty_patch` / `invalid_input`
 *     (whitelist + body-shape rejections from the route layer).
 *   `code` is present for the route-layer cases so the UI can show typed
 *   inline messages; absent for cross-field cases (one entry per failed
 *   field, with the field's `path`). The patch was not persisted either way.
 */
export type CommitEnvResult =
  | { kind: 'ok'; updatedItems: EnvKeyState[]; pendingRestartKeys: string[] }
  | { kind: 'errors'; errors: { path: string; message: string; code?: string }[] };

/**
 * Result of `POST /server/restart`. The server schedules an `process.exit(0)`
 * a short interval after replying so the response actually flushes;
 * `estimatedSeconds` is the supervisor's expected gap before the next process
 * is up and `/health` answers again. UI should poll `/health` after that
 * delay to detect when the server is back.
 */
export interface ServerRestartResult {
  status: 'restarting';
  estimatedSeconds: number;
}

// ─── IM settings manifest (channel-driven config + actions) ─────────────────
//
// Mirror of `@goldpan/im-runtime` ImSettingsManifest shape — but kept here as
// a separately-maintained transport schema so web-sdk consumers (browser code
// + server components) don't need to import from server packages.
//
// Note: `ImSettingsField` is intentionally a FLAT shape (single interface with
// optional fields per kind) — the runtime side uses a discriminated union for
// stricter validation, but rendering code on the web only reads field metadata
// so the relaxed transport shape is easier to consume.

export type LocalizedString = { en: string; zh: string };

export interface ImSettingsField {
  name: string;
  kind: 'text' | 'secret' | 'segmented' | 'toggle';
  label: LocalizedString;
  hint?: LocalizedString;
  envKey: string;
  required?: boolean;
  requiresRestart?: boolean;
  placeholder?: LocalizedString;
  options?: ReadonlyArray<{ value: string; label: LocalizedString }>;
  default?: string | boolean;
}

export interface ImSettingsActionDescriptor {
  id: string;
  // Mirror of @goldpan/im-runtime ImSettingsActionDescriptor.kind. v1 only
  // implements 'test' end-to-end; lookup was rejected at the schema layer
  // (see runtime ImSettingsActionDescriptor JSDoc).
  kind: 'test';
  label: LocalizedString;
  requires: ReadonlyArray<string>;
  errorMessages?: Record<string, LocalizedString>;
}

export interface ImSetupGuideStep {
  id: string;
  title: LocalizedString;
  desc: LocalizedString;
  images: ReadonlyArray<string>;
  externalLink?: { label: LocalizedString; href: string };
  code?: { language: string; text: string };
}

export interface ImSettingsManifest {
  channelId: string;
  branding: { name: LocalizedString; tagline?: LocalizedString };
  enable: { envKey: string; label: LocalizedString; default: boolean };
  fields: ReadonlyArray<ImSettingsField>;
  actions: ReadonlyArray<ImSettingsActionDescriptor>;
  setupGuide: { allDoneTitle: LocalizedString; steps: ReadonlyArray<ImSetupGuideStep> };
}

/**
 * Discriminated union — `code` is required on the failure branch so callers
 * checking `!result.ok` get `code: string` without a null-check. Mirrors the
 * server-side `ImSettingsActionResult` contract (see `@goldpan/im-runtime`).
 */
export type ImActionResult =
  | { ok: true; data?: Record<string, unknown> & { envPatch?: Record<string, string> } }
  | {
      ok: false;
      code: string;
      message?: string;
      data?: Record<string, unknown> & { envPatch?: Record<string, string> };
    };

// ---------------------------------------------------------------------------
// Plugin Settings Contribution — generic protocol (replaces ImSettingsManifest
// over time). Wire format only: server resolves every LocalizedString on the
// core side before serializing, so every text field below is plain string.
// LocalizedString never appears in this wire format — clients consume strings
// without locale logic.
// ---------------------------------------------------------------------------

export type PluginSettingsGroup = 'search' | 'notify' | 'collect' | 'digest' | 'llm' | 'embedding';

export type SettingsFieldKind = 'text' | 'secret' | 'segmented' | 'toggle' | 'number';

export interface SettingsFieldDescriptor {
  name: string;
  kind: SettingsFieldKind;
  envKey: string;
  label: string;
  hint?: string;
  placeholder?: string;
  default?: string | boolean | number;
  required?: boolean;
  requiresRestart?: boolean;
  options?: ReadonlyArray<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
}

export interface PluginActionDescriptor {
  id: string;
  kind: 'test';
  label: string;
  requires?: ReadonlyArray<string>;
  errorMessages?: Record<string, string>;
  timeoutMs?: number;
}

export interface PluginNoticeDescriptor {
  kind: 'warn' | 'info';
  message: string;
}

export interface PluginSetupStepDescriptor {
  id: string;
  title: string;
  desc: string;
  images?: ReadonlyArray<string>;
  externalLink?: { label: string; href: string };
  code?: { language: string; text: string };
}

export interface PluginSetupGuideDescriptor {
  allDoneTitle?: string;
  steps: ReadonlyArray<PluginSetupStepDescriptor>;
}

export interface PluginSettingsContributionDescriptor {
  pluginId: string;
  group: PluginSettingsGroup;
  branding: { name: string; tagline?: string; homepage?: string };
  enable?: { envKey: string; label: string; default: boolean };
  fields: ReadonlyArray<SettingsFieldDescriptor>;
  actions?: ReadonlyArray<PluginActionDescriptor>;
  setupGuide?: PluginSetupGuideDescriptor;
  /**
   * Plugin-level notices rendered above the enable toggle. Used for
   * caveats / warnings / recommendations that apply to the whole plugin
   * rather than to a single field.
   */
  notices?: ReadonlyArray<PluginNoticeDescriptor>;
  /**
   * Plugin metadata merged in by the server route (not the contribution itself).
   * The route looks up the parent `GoldpanPlugin` via `pluginId === plugin.name`
   * and copies `version` / locale-resolved `description` here so the meta strip
   * can render without a second round-trip.
   */
  pluginVersion?: string;
  pluginDescription?: string;
}

export interface PluginSettingsContributionsResponse {
  contributions: PluginSettingsContributionDescriptor[];
}

/**
 * Result of POST /settings/contributions/:pluginId/actions/:actionId.
 * Same shape as ImActionResult — kept as a distinct type so the two
 * dispatch paths can diverge later without breaking the IM mirror.
 */
export type PluginActionResult =
  | { ok: true; data?: Record<string, unknown> & { envPatch?: Record<string, string> } }
  | {
      ok: false;
      code: string;
      message?: string;
      data?: Record<string, unknown> & { envPatch?: Record<string, string> };
    };

// ---------------------------------------------------------------------------
// LLM providers (read-only)
// ---------------------------------------------------------------------------

export interface LlmProviderBuiltin {
  id: string;
  apiKeyEnv: string;
  apiKeyConfigured: boolean;
  /**
   * Chat / completion model ids. 来源 `GOLDPAN_LLM_PROVIDER_<ID>_MODELS` env
   * （user 在 Provider 设置页录入并保存；ollama 也接受 legacy
   * `GOLDPAN_OLLAMA_MODELS` fallback）。Pipeline matrix / Digest / 其它
   * chat 用途下拉读这一份。Empty list = 用户没录入 chat model，前端
   * Pipeline 下拉走「自定义」退路输入。
   */
  models: string[];
  /**
   * Embedding model ids. 来源 `GOLDPAN_LLM_PROVIDER_<ID>_EMBEDDING_MODELS`。
   * Embedding 设置 / onboarding embedding 步骤的 model 下拉只读这一份 ——
   * chat 和 embedding 在真实模型层面集合互斥（`gpt-4o` 没 embedding endpoint、
   * `text-embedding-3-small` 没 chat endpoint），分开维护避免 user 选错。
   * Empty list = 用户没把这家 provider 的任何 model 标记为 embedding 角色。
   */
  embeddingModels: string[];
}

export interface LlmProviderCustom {
  id: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKeyConfigured: boolean;
  /** Pre-registered model ids parsed from `GOLDPAN_LLM_PROVIDER_<ID>_MODELS`. */
  models: string[];
  /** Embedding-role model ids parsed from `GOLDPAN_LLM_PROVIDER_<ID>_EMBEDDING_MODELS`. */
  embeddingModels: string[];
}

export interface LlmProviderPlugin {
  providerId: string;
  pluginName: string;
  status: 'loaded' | 'failed' | 'skipped_conflict';
  error?: string;
  /** Pre-registered model ids parsed from `GOLDPAN_LLM_PROVIDER_<ID>_MODELS`. */
  models: string[];
  /**
   * Embedding-role model ids parsed from
   * `GOLDPAN_LLM_PROVIDER_<ID>_EMBEDDING_MODELS`. Plugin manifest doesn't
   * declare embedding capability yet, so this only populates when the user
   * explicitly registers embedding models via env for the plugin's
   * providerId. Mirrors builtin / custom shape so call sites don't need a
   * per-source guard.
   */
  embeddingModels: string[];
}

export interface LlmProvidersResponse {
  builtin: LlmProviderBuiltin[];
  custom: LlmProviderCustom[];
  plugin: LlmProviderPlugin[];
}

// ─── Notes (P1 — 用户笔记类型；P6 把 Note* 从源详情释放后直接占用此名字) ─────

export type NoteSubtype = (typeof NOTE_SUBTYPES)[number];
export type NoteSourceRelation = 'reference' | 'derived_from';

export interface NoteDetail {
  id: number;
  content: string;
  contentTranslated: string | null;
  language: string | null;
  subtype: NoteSubtype;
  pinned: boolean;
  archived: boolean;
  sourceMessageId: number | null;
  /** P5: derived from sourceMessageId join. NULL when sourceMessageId is null,
   * the conversation was deleted, OR the conversation belongs to a non-web
   * channel (IM origin) — web UI can't open those, so we suppress the link. */
  conversationId: number | null;
  tags: string[];
  linkedEntities: Array<{ id: number; name: string }>;
  linkedSources: Array<{
    id: number;
    relation: NoteSourceRelation;
    title: string | null;
    originalUrl: string | null;
    rawContentPreview?: string | null;
  }>;
  /** Unix-ms timestamp the user wants a reminder for. Null = no reminder. */
  dueAt: number | null;
  /** Unix-ms timestamp at which client UI displayed the reminder. Null = pending. */
  remindedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateNoteInput {
  content: string;
  subtype?: NoteSubtype;
  language?: string;
  tags?: string[];
  linkedEntityIds?: number[];
  linkedSourceId?: number;
  /** Minor: SDK 加 sourceMessageId 与 server route / core 类型对齐（3 way fix）。
   *  ID 来自 conversation_messages.id；非 web channel 调用方留空。 */
  sourceMessageId?: number;
}

export interface UpdateNoteInput {
  content?: string;
  subtype?: NoteSubtype;
  tags?: string[];
  linkedEntityIds?: number[];
  /**
   * B9: 替换 relation='reference' 的 note_sources 全集。relation='derived_from'
   * 保持不动（promote 创建的溯源链）。不存在的 source id 静默丢弃。
   */
  linkedSourceIds?: number[];
  pinned?: boolean;
  archived?: boolean;
  dueAt?: number | null;
}

export interface ListNotesParams {
  subtype?: NoteSubtype | NoteSubtype[];
  tag?: string;
  entityId?: number;
  sourceId?: number;
  pinned?: boolean;
  archived?: boolean;
  search?: string;
  limit?: number;
  cursor?: string | number;
  /** Unix-ms. Filters to notes whose dueAt <= this cutoff (client poll uses Date.now()). */
  dueBefore?: number;
  /**
   * When `true`, returns only notes where dueAt IS NOT NULL AND remindedAt IS NULL
   * (pending reminders). When `false` or omitted, no filter is applied — server treats
   * them equivalently. Pass `true` only when you want the pending-reminder subset.
   */
  hasReminder?: boolean;
}

export interface ListNotesResult {
  data: NoteDetail[];
  nextCursor: string | null;
}

export interface PromoteNoteResult {
  taskId: number;
  sourceId: number;
}

/**
 * Result of POST /user-notes/:id/translate. UI uses contentTranslated to
 * setOverride({ ...detail, contentTranslated }) so the readonly translation
 * preview section beneath the textarea picks up the new translation.
 */
export interface TranslateNoteResult {
  contentTranslated: string;
}

export interface MarkNoteRemindedResult {
  remindedAt: number;
}

export interface MarkNoteRemindedOptions {
  /** Optional CAS guard from the reminder banner snapshot. */
  expectedDueAt?: number;
}
