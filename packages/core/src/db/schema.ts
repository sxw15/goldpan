import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { NOW_MS } from './sql-fragments';

// ─── categories ─────────────────────────────────────────────
export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    parentId: integer('parent_id'),
    createdAt: integer('created_at').notNull().default(NOW_MS),
    updatedAt: integer('updated_at').notNull().default(NOW_MS),
  },
  (table) => [
    uniqueIndex('idx_categories_path').on(table.path),
    index('idx_categories_parent').on(table.parentId),
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
    }).onDelete('restrict'),
    check('no_self_parent', sql`${table.parentId} IS NULL OR ${table.parentId} != ${table.id}`),
  ],
);

// ─── entities ───────────────────────────────────────────────
export const entities = sqliteTable(
  'entities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    description: text('description'),
    /**
     * Translation of `description` into the configured `GOLDPAN_LANGUAGE`,
     * produced by the optional `translating` pipeline step. NULL when
     * translation is disabled or the row predates the feature; UI consumers
     * fall back to `description`. The original column is never overwritten.
     */
    descriptionTranslated: text('description_translated'),
    aliases: text('aliases').notNull().default('[]'),
    keywords: text('keywords').notNull().default('[]'),
    createdAt: integer('created_at').notNull().default(NOW_MS),
    updatedAt: integer('updated_at').notNull().default(NOW_MS),
  },
  (table) => [
    check(
      'aliases_json',
      sql`json_valid(${table.aliases}) AND json_type(${table.aliases}) = 'array'`,
    ),
    check(
      'keywords_json',
      sql`json_valid(${table.keywords}) AND json_type(${table.keywords}) = 'array'`,
    ),
    index('idx_entities_name').on(table.name),
  ],
);

// ─── entity_categories ──────────────────────────────────────
export const entityCategories = sqliteTable(
  'entity_categories',
  {
    entityId: integer('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.entityId, table.categoryId] }),
    index('idx_ec_category').on(table.categoryId),
  ],
);

// ─── knowledge_points ───────────────────────────────────────
export const knowledgePoints = sqliteTable(
  'knowledge_points',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    content: text('content').notNull(),
    /**
     * Translation of `content` into the configured `GOLDPAN_LANGUAGE`,
     * produced by the optional `translating` pipeline step. NULL when
     * translation is disabled, the LLM call failed, or the row predates the
     * feature; UI falls back to `content`.
     */
    contentTranslated: text('content_translated'),
    type: text('type').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at').notNull().default(NOW_MS),
    updatedAt: integer('updated_at').notNull().default(NOW_MS),
  },
  (table) => [
    check('type_enum', sql`${table.type} IN ('fact', 'opinion')`),
    check('status_enum', sql`${table.status} IN ('active', 'discarded')`),
  ],
);

// ─── tags ───────────────────────────────────────────────────
// Hashtag-style labels attached to opinion knowledge points (the cp-note card
// surfaces them under "标签"). Independent table (rather than a JSON column on
// `knowledge_points`) so future "browse by tag" / counting features can join
// directly without parsing JSON.
//
// Uniqueness is enforced case-insensitively at the DB layer via a unique
// index on `lower(name)`. `KnowledgeRepository.upsertTags` canonicalizes
// case before inserting, but a SELECT-then-INSERT race (two pipelines
// upserting "React" and "react" simultaneously) would otherwise slip past
// an exact-match unique index. The expression index closes that window
// without forcing every write to wrap a transaction.
export const tags = sqliteTable(
  'tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull().default(NOW_MS),
  },
  (table) => [uniqueIndex('idx_tags_name').on(sql`lower(${table.name})`)],
);

// ─── point_tags ─────────────────────────────────────────────
export const pointTags = sqliteTable(
  'point_tags',
  {
    pointId: integer('point_id')
      .notNull()
      .references(() => knowledgePoints.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.pointId, table.tagId] }),
    index('idx_point_tags_tag').on(table.tagId),
  ],
);

// ─── sources ────────────────────────────────────────────────
export const sources = sqliteTable(
  'sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    normalizedUrl: text('normalized_url'),
    originalUrl: text('original_url'),
    title: text('title'),
    rawContent: text('raw_content'),
    metadata: text('metadata'),
    status: text('status').notNull().default('processing'),
    createdAt: integer('created_at').notNull().default(NOW_MS),
    updatedAt: integer('updated_at').notNull().default(NOW_MS),
    origin: text('origin').notNull().default('user'),
    trackingRuleId: integer('tracking_rule_id'),
  },
  (table) => [
    check(
      'status_enum',
      sql`${table.status} IN ('processing', 'confirmed', 'confirmed_empty', 'failed', 'discarded')`,
    ),
    check('kind_enum', sql`${table.kind} IN ('external', 'user')`),
    check(
      'kind_url_constraint',
      sql`
      (${table.kind} = 'external' AND ${table.normalizedUrl} IS NOT NULL AND ${table.originalUrl} IS NOT NULL)
      OR (${table.kind} = 'user' AND ${table.normalizedUrl} IS NULL AND ${table.originalUrl} IS NULL AND ${table.rawContent} IS NOT NULL)
    `,
    ),
    check(
      'metadata_json',
      sql`${table.metadata} IS NULL OR (json_valid(${table.metadata}) AND json_type(${table.metadata}) = 'object')`,
    ),
    check('origin_enum', sql`${table.origin} IN ('user', 'tracking', 'github_refresh')`),
    // Partial unique: only one active source per normalized URL — but refresh flow must be allowed to coexist
    uniqueIndex('idx_sources_url_active')
      .on(table.normalizedUrl)
      .where(sql`status IN ('processing', 'confirmed') AND origin != 'github_refresh'`),
    // DB-level guard against two concurrent refresh inserts racing on the same URL
    uniqueIndex('idx_sources_url_processing_refresh')
      .on(table.normalizedUrl)
      .where(sql`status = 'processing' AND origin = 'github_refresh'`),
    // Full index (non-partial) — watermark lookup scans confirmed + confirmed_empty, so the
    // partial indexes above cannot cover it
    index('idx_sources_normalized_url').on(table.normalizedUrl),
    index('idx_sources_status').on(table.status),
    index('idx_sources_origin').on(table.origin),
    index('idx_sources_tracking_rule_id').on(table.trackingRuleId),
  ],
);

// ─── source_entity_points ───────────────────────────────────
export const sourceEntityPoints = sqliteTable(
  'source_entity_points',
  {
    sourceId: integer('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    entityId: integer('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'restrict' }),
    pointId: integer('point_id')
      .notNull()
      .references(() => knowledgePoints.id, { onDelete: 'restrict' }),
    judgment: text('judgment').notNull(),
    createdAt: integer('created_at').notNull().default(NOW_MS),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.entityId, table.pointId] }),
    check('judgment_enum', sql`${table.judgment} IN ('new', 'skipped')`),
    index('idx_sep_entity_point').on(table.entityId, table.pointId),
    index('idx_sep_point').on(table.pointId),
  ],
);

// ─── entity_relations ───────────────────────────────────────
export const entityRelations = sqliteTable(
  'entity_relations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceEntityId: integer('source_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    targetEntityId: integer('target_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    relationType: text('relation_type').notNull(),
    description: text('description').notNull(),
    /**
     * Translation of `description` into the configured `GOLDPAN_LANGUAGE`.
     * NULL semantics identical to `entities.description_translated` /
     * `knowledge_points.content_translated`.
     */
    descriptionTranslated: text('description_translated'),
    sourceId: integer('source_id').references(() => sources.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(NOW_MS),
    updatedAt: integer('updated_at').notNull().default(NOW_MS),
  },
  (table) => [
    check(
      'relation_type_enum',
      sql`${table.relationType} IN ('organizational', 'competitive', 'collaborative', 'technical', 'causal', 'general')`,
    ),
    check('no_self_relation', sql`${table.sourceEntityId} != ${table.targetEntityId}`),
    unique('uq_entity_relation').on(table.sourceEntityId, table.targetEntityId, table.relationType),
    index('idx_entity_relations_source').on(table.sourceEntityId),
    index('idx_entity_relations_target').on(table.targetEntityId),
  ],
);

// ─── event_logs ─────────────────────────────────────────────
export const eventLogs = sqliteTable(
  'event_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: integer('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict' }),
    entityId: integer('entity_id').references(() => entities.id, { onDelete: 'set null' }),
    pointId: integer('point_id').references(() => knowledgePoints.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    timestamp: integer('timestamp').notNull().default(NOW_MS),
    summary: text('summary'),
  },
  (table) => [
    check(
      'action_enum',
      sql`${table.action} IN ('point_created', 'entity_created', 'source_confirmed', 'source_confirmed_empty', 'source_discarded', 'point_discarded', 'entity_aliases_discovered')`,
    ),
    index('idx_event_logs_source').on(table.sourceId),
  ],
);

// ─── llm_calls ──────────────────────────────────────────────
export const llmCalls = sqliteTable(
  'llm_calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    step: text('step').notNull(),
    provider: text('provider'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    requestBody: text('request_body'),
    responseBody: text('response_body'),
    requestSchema: text('request_schema'),
    promptHash: text('prompt_hash').notNull(),
    sourceId: integer('source_id').references(() => sources.id, { onDelete: 'set null' }),
    /** Whether this row records a successful structured output or a failed attempt. */
    outcome: text('outcome').notNull().default('success'),
    /** When outcome is failed, why the call did not yield a valid result (mirrors pipeline error kinds). */
    failureKind: text('failure_kind'),
    /** Short message for debug UI (truncated at write time). */
    failureMessage: text('failure_message'),
    /** 1-based index of this generateText invocation within a single callLlm() (includes retries). */
    attemptNumber: integer('attempt_number').notNull().default(1),
    /** UTC epoch milliseconds. */
    timestamp: integer('timestamp').notNull().default(NOW_MS),
  },
  (table) => [
    check(
      'step_enum',
      sql`${table.step} IN ('classifier', 'extractor', 'matcher', 'comparator', 'verifier', 'intent_classifier', 'query_understand', 'query', 'relator', 'translator', 'tracking_action_parser', 'github_action_parser', 'digest_summary', 'digest_action_parser')`,
    ),
    check('llm_calls_outcome_enum', sql`${table.outcome} IN ('success', 'failed')`),
    check(
      'llm_calls_failure_kind_enum',
      sql`${table.failureKind} IS NULL OR ${table.failureKind} IN ('schema_validation', 'content_policy', 'rate_limit', 'timeout', 'unknown')`,
    ),
    check(
      'llm_calls_outcome_failure_consistency',
      sql`(${table.outcome} = 'success' AND ${table.failureKind} IS NULL AND ${table.failureMessage} IS NULL) OR (${table.outcome} = 'failed' AND ${table.failureKind} IS NOT NULL)`,
    ),
    check('llm_calls_attempt_positive', sql`${table.attemptNumber} >= 1`),
    index('idx_llm_calls_prompt_hash').on(table.promptHash, table.step),
    index('idx_llm_calls_source_id').on(table.sourceId),
  ],
);

// ─── processing_tasks ───────────────────────────────────────
export const processingTasks = sqliteTable(
  'processing_tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: integer('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    inputType: text('input_type'),
    status: text('status').notNull().default('pending'),
    pipelineStep: text('pipeline_step'),
    result: text('result'),
    errorMessage: text('error_message'),
    errorKind: text('error_kind'),
    createdAt: integer('created_at').notNull().default(NOW_MS),
    updatedAt: integer('updated_at').notNull().default(NOW_MS),
  },
  (table) => [
    check('status_enum', sql`${table.status} IN ('pending', 'processing', 'done', 'error')`),
    check('type_enum', sql`${table.type} IN ('pipeline')`),
    check(
      'input_type_enum',
      sql`${table.inputType} IS NULL OR ${table.inputType} IN ('url', 'text', 'opinion')`,
    ),
    check('done_requires_result', sql`${table.status} != 'done' OR ${table.result} IS NOT NULL`),
    check(
      'error_requires_message',
      sql`${table.status} != 'error' OR ${table.errorMessage} IS NOT NULL`,
    ),
    check(
      'error_kind_enum',
      sql`${table.errorKind} IS NULL OR ${table.errorKind} IN ('schema_validation', 'content_policy', 'content_length', 'rate_limit', 'timeout', 'not_found', 'unknown')`,
    ),
    check('error_requires_kind', sql`${table.status} != 'error' OR ${table.errorKind} IS NOT NULL`),
    check('result_json', sql`${table.result} IS NULL OR json_valid(${table.result})`),
    check(
      'pipeline_step_enum',
      sql`${table.pipelineStep} IS NULL OR ${table.pipelineStep} IN ('collecting', 'classifying', 'extracting', 'matching', 'relating', 'comparing', 'verifying', 'translating', 'validatePipelineOutput', 'storing', 'content_validation')`,
    ),
    index('idx_tasks_status').on(table.status, table.type, table.createdAt),
    // Powers the dedup lookup in `submit.ts` ("does this URL already have a
    // task?"). Without it the lookup full-scans `processing_tasks`, which
    // every duplicate submission pays — proportional to total task count.
    index('idx_tasks_source').on(table.sourceId),
  ],
);

// ─── submission_logs ────────────────────────────────────────
export const submissionLogs = sqliteTable(
  'submission_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    rawInput: text('raw_input').notNull(),
    result: text('result').notNull(),
    reason: text('reason'),
    taskId: integer('task_id').references(() => processingTasks.id, { onDelete: 'set null' }),
    sourceId: integer('source_id').references(() => sources.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(NOW_MS),
  },
  (table) => [
    check('result_enum', sql`${table.result} IN ('accepted', 'duplicate', 'rejected')`),
    check(
      'non_accepted_requires_reason',
      sql`${table.result} = 'accepted' OR ${table.reason} IS NOT NULL`,
    ),
  ],
);

// ─── task_logs ─────────────────────────────────────────────
export const taskLogs = sqliteTable(
  'task_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id')
      .notNull()
      .references(() => processingTasks.id, { onDelete: 'cascade' }),
    step: text('step').notNull(),
    event: text('event').notNull(),
    message: text('message'),
    inputSummary: text('input_summary'),
    outputSummary: text('output_summary'),
    timestamp: integer('timestamp').notNull().default(NOW_MS),
  },
  (table) => [
    check('task_log_event_enum', sql`${table.event} IN ('start', 'end', 'error', 'skip')`),
    index('idx_task_logs_task_id').on(table.taskId, table.timestamp),
  ],
);

// ─── db_metadata ────────────────────────────────────────────
export const dbMetadata = sqliteTable('db_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// ─── conversations ──────────────────────────────────────────
export const conversations = sqliteTable(
  'conversations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionKey: text('session_key').notNull(),
    channelId: text('channel_id').notNull(),
    createdAt: integer('created_at').notNull().default(NOW_MS),
    updatedAt: integer('updated_at').notNull().default(NOW_MS),
    lastMessageAt: integer('last_message_at'),
    archivedAt: integer('archived_at'),
    archivedReason: text('archived_reason'),
  },
  (table) => [
    uniqueIndex('uq_conversations_active_session_key')
      .on(table.sessionKey)
      .where(sql`${table.archivedAt} IS NULL`),
    index('idx_conversations_session_key_archived').on(table.sessionKey, table.archivedAt),
    index('idx_conversations_channel_updated').on(table.channelId, table.updatedAt),
    check(
      'conversations_archived_reason_enum',
      sql`${table.archivedReason} IS NULL OR ${table.archivedReason} IN ('user_reset', 'auto_stale', 'admin')`,
    ),
  ],
);

// ─── conversation_messages ──────────────────────────────────
export const conversationMessages = sqliteTable(
  'conversation_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    metadata: text('metadata'),
    createdAt: integer('created_at').notNull().default(NOW_MS),
    // P3 buffer mechanism: 'buffered_wait' messages are pending classifier
    // re-run within a short window (a follow-up turn may merge into the
    // buffered one); 'consumed' marks a buffered message after merge so it
    // does not re-enter the classifier window. Default 'normal' = pre-P3
    // behavior, so existing rows back-fill cleanly without writes.
    status: text('status').notNull().default('normal'),
    bufferedExpiresAt: integer('buffered_expires_at'),
  },
  (table) => [
    check('conversation_messages_role_enum', sql`${table.role} IN ('user', 'assistant')`),
    check(
      'conversation_messages_metadata_json',
      sql`${table.metadata} IS NULL OR json_valid(${table.metadata})`,
    ),
    check(
      'conversation_messages_status_enum',
      sql`${table.status} IN ('normal','buffered_wait','consumed')`,
    ),
    index('idx_conversation_messages_conv_created').on(table.conversationId, table.createdAt),
    index('idx_conv_msgs_buffered')
      .on(table.status, table.bufferedExpiresAt)
      .where(sql`status = 'buffered_wait'`),
  ],
);

// ─── im_messages_seen ───────────────────────────────────────
export const imMessagesSeen = sqliteTable(
  'im_messages_seen',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelId: text('channel_id').notNull(),
    accountId: text('account_id').notNull(),
    chatId: text('chat_id').notNull(),
    platformMsgId: text('platform_msg_id').notNull(),
    seenAt: integer('seen_at').notNull().default(NOW_MS),
  },
  (table) => [
    unique('uq_im_messages_seen').on(
      table.channelId,
      table.accountId,
      table.chatId,
      table.platformMsgId,
    ),
    index('idx_im_messages_seen_seen_at').on(table.seenAt),
  ],
);

// ─── runtime_config_overrides ───────────────────────────────
// UI-saved overrides for env keys. Merged on top of BOOT_ENV_SNAPSHOT (env
// baseline from .env / docker / k8s) at boot and after every commit.
// Whitelist (MANAGED_ENV_KEYS ∪ MANAGED_ENV_PATTERNS ∪ plugin envSpec keys)
// is enforced by ConfigStore.commit, NOT here — DB schema stays simple
// (key, value) so migrations don't have to change every time the whitelist
// evolves.
export const runtimeConfigOverrides = sqliteTable('runtime_config_overrides', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// ─── notes ──────────────────────────────────────────────────
// User-authored notes. Subtype collapsed to `memo` (reminder-bearing) vs `note`
// (everything else) — see notes/types.ts for rationale. Distinct from the
// `/notes/*` source-view compatibility routes over `sources`; P6 renamed the
// read-model code to SourceView* while keeping HTTP paths stable.
export const notes = sqliteTable(
  'notes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    content: text('content').notNull(),
    contentTranslated: text('content_translated'),
    language: text('language'),
    subtype: text('subtype').notNull().default('note'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    sourceMessageId: integer('source_message_id').references(() => conversationMessages.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at').notNull().default(NOW_MS),
    updatedAt: integer('updated_at').notNull().default(NOW_MS),
    /**
     * Unix-ms timestamp the user wants a reminder for this note (memo subtype
     * only — UI hides input for other subtypes). NULL = no reminder set;
     * NULL also means "never reminded" since dueAt is the trigger.
     */
    dueAt: integer('due_at'),
    /**
     * Unix-ms timestamp at which the client UI displayed the reminder banner
     * for this note. Set by POST /user-notes/:id/mark-reminded once the user
     * acknowledges. Cleared by updateNote when a new dueAt > the existing
     * remindedAt (spec §P7.4 D12 — "user re-set the deadline forward, expects
     * a fresh reminder").
     */
    remindedAt: integer('reminded_at'),
  },
  (table) => [
    check('notes_subtype_enum', sql`${table.subtype} IN ('memo','note')`),
    index('idx_notes_subtype').on(table.subtype),
    index('idx_notes_pinned').on(table.pinned).where(sql`pinned = 1`),
    index('idx_notes_archived').on(table.archived).where(sql`archived = 1`),
    index('idx_notes_created_at').on(table.createdAt),
    index('idx_notes_due_pending')
      .on(table.dueAt)
      .where(sql`due_at IS NOT NULL AND reminded_at IS NULL AND archived = 0`),
  ],
);

export const noteTags = sqliteTable(
  'note_tags',
  {
    noteId: integer('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.tag] }),
    index('idx_note_tags_tag').on(table.tag),
  ],
);

export const noteEntities = sqliteTable(
  'note_entities',
  {
    noteId: integer('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    entityId: integer('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.entityId] }),
    index('idx_note_entities_entity').on(table.entityId),
  ],
);

export const noteSources = sqliteTable(
  'note_sources',
  {
    noteId: integer('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    sourceId: integer('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    relation: text('relation').notNull().default('reference'),
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.sourceId] }),
    check('note_sources_relation_enum', sql`${table.relation} IN ('reference','derived_from')`),
    index('idx_note_sources_source').on(table.sourceId),
  ],
);
