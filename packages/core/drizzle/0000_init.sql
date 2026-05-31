CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`parent_id` integer,
	`created_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "no_self_parent" CHECK("categories"."parent_id" IS NULL OR "categories"."parent_id" != "categories"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_categories_path` ON `categories` (`path`);--> statement-breakpoint
CREATE INDEX `idx_categories_parent` ON `categories` (`parent_id`);--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`metadata` text,
	`created_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	`status` text DEFAULT 'normal' NOT NULL,
	`buffered_expires_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_messages_role_enum" CHECK("conversation_messages"."role" IN ('user', 'assistant')),
	CONSTRAINT "conversation_messages_metadata_json" CHECK("conversation_messages"."metadata" IS NULL OR json_valid("conversation_messages"."metadata")),
	CONSTRAINT "conversation_messages_status_enum" CHECK("conversation_messages"."status" IN ('normal','buffered_wait','consumed'))
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_messages_conv_created` ON `conversation_messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_conv_msgs_buffered` ON `conversation_messages` (`status`,`buffered_expires_at`) WHERE status = 'buffered_wait';--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_key` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	`last_message_at` integer,
	`archived_at` integer,
	`archived_reason` text,
	CONSTRAINT "conversations_archived_reason_enum" CHECK("conversations"."archived_reason" IS NULL OR "conversations"."archived_reason" IN ('user_reset', 'auto_stale', 'admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_conversations_active_session_key` ON `conversations` (`session_key`) WHERE "conversations"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_conversations_session_key_archived` ON `conversations` (`session_key`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_conversations_channel_updated` ON `conversations` (`channel_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `db_metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`description_translated` text,
	`aliases` text DEFAULT '[]' NOT NULL,
	`keywords` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	CONSTRAINT "aliases_json" CHECK(json_valid("entities"."aliases") AND json_type("entities"."aliases") = 'array'),
	CONSTRAINT "keywords_json" CHECK(json_valid("entities"."keywords") AND json_type("entities"."keywords") = 'array')
);
--> statement-breakpoint
CREATE INDEX `idx_entities_name` ON `entities` (`name`);--> statement-breakpoint
CREATE TABLE `entity_categories` (
	`entity_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	PRIMARY KEY(`entity_id`, `category_id`),
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ec_category` ON `entity_categories` (`category_id`);--> statement-breakpoint
CREATE TABLE `entity_relations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_entity_id` integer NOT NULL,
	`target_entity_id` integer NOT NULL,
	`relation_type` text NOT NULL,
	`description` text NOT NULL,
	`description_translated` text,
	`source_id` integer,
	`created_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	FOREIGN KEY (`source_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "relation_type_enum" CHECK("entity_relations"."relation_type" IN ('organizational', 'competitive', 'collaborative', 'technical', 'causal', 'general')),
	CONSTRAINT "no_self_relation" CHECK("entity_relations"."source_entity_id" != "entity_relations"."target_entity_id")
);
--> statement-breakpoint
CREATE INDEX `idx_entity_relations_source` ON `entity_relations` (`source_entity_id`);--> statement-breakpoint
CREATE INDEX `idx_entity_relations_target` ON `entity_relations` (`target_entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_entity_relation` ON `entity_relations` (`source_entity_id`,`target_entity_id`,`relation_type`);--> statement-breakpoint
CREATE TABLE `event_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`entity_id` integer,
	`point_id` integer,
	`action` text NOT NULL,
	`timestamp` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	`summary` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`point_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "action_enum" CHECK("event_logs"."action" IN ('point_created', 'entity_created', 'source_confirmed', 'source_confirmed_empty', 'source_discarded', 'point_discarded', 'entity_aliases_discovered'))
);
--> statement-breakpoint
CREATE INDEX `idx_event_logs_source` ON `event_logs` (`source_id`);--> statement-breakpoint
CREATE TABLE `im_messages_seen` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`account_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`platform_msg_id` text NOT NULL,
	`seen_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_im_messages_seen_seen_at` ON `im_messages_seen` (`seen_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_im_messages_seen` ON `im_messages_seen` (`channel_id`,`account_id`,`chat_id`,`platform_msg_id`);--> statement-breakpoint
CREATE TABLE `knowledge_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content` text NOT NULL,
	`content_translated` text,
	`type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	CONSTRAINT "type_enum" CHECK("knowledge_points"."type" IN ('fact', 'opinion')),
	CONSTRAINT "status_enum" CHECK("knowledge_points"."status" IN ('active', 'discarded'))
);
--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`step` text NOT NULL,
	`provider` text,
	`model` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`request_body` text,
	`response_body` text,
	`request_schema` text,
	`prompt_hash` text NOT NULL,
	`source_id` integer,
	`outcome` text DEFAULT 'success' NOT NULL,
	`failure_kind` text,
	`failure_message` text,
	`attempt_number` integer DEFAULT 1 NOT NULL,
	`timestamp` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "step_enum" CHECK("llm_calls"."step" IN ('classifier', 'extractor', 'matcher', 'comparator', 'verifier', 'intent_classifier', 'query_understand', 'query', 'relator', 'translator', 'tracking_action_parser', 'github_action_parser', 'digest_summary', 'digest_action_parser')),
	CONSTRAINT "llm_calls_outcome_enum" CHECK("llm_calls"."outcome" IN ('success', 'failed')),
	CONSTRAINT "llm_calls_failure_kind_enum" CHECK("llm_calls"."failure_kind" IS NULL OR "llm_calls"."failure_kind" IN ('schema_validation', 'content_policy', 'rate_limit', 'timeout', 'unknown')),
	CONSTRAINT "llm_calls_outcome_failure_consistency" CHECK(("llm_calls"."outcome" = 'success' AND "llm_calls"."failure_kind" IS NULL AND "llm_calls"."failure_message" IS NULL) OR ("llm_calls"."outcome" = 'failed' AND "llm_calls"."failure_kind" IS NOT NULL)),
	CONSTRAINT "llm_calls_attempt_positive" CHECK("llm_calls"."attempt_number" >= 1)
);
--> statement-breakpoint
CREATE INDEX `idx_llm_calls_prompt_hash` ON `llm_calls` (`prompt_hash`,`step`);--> statement-breakpoint
CREATE INDEX `idx_llm_calls_source_id` ON `llm_calls` (`source_id`);--> statement-breakpoint
CREATE TABLE `note_entities` (
	`note_id` integer NOT NULL,
	`entity_id` integer NOT NULL,
	PRIMARY KEY(`note_id`, `entity_id`),
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_note_entities_entity` ON `note_entities` (`entity_id`);--> statement-breakpoint
CREATE TABLE `note_sources` (
	`note_id` integer NOT NULL,
	`source_id` integer NOT NULL,
	`relation` text DEFAULT 'reference' NOT NULL,
	PRIMARY KEY(`note_id`, `source_id`),
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "note_sources_relation_enum" CHECK("note_sources"."relation" IN ('reference','derived_from'))
);
--> statement-breakpoint
CREATE INDEX `idx_note_sources_source` ON `note_sources` (`source_id`);--> statement-breakpoint
CREATE TABLE `note_tags` (
	`note_id` integer NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`note_id`, `tag`),
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_note_tags_tag` ON `note_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content` text NOT NULL,
	`content_translated` text,
	`language` text,
	`subtype` text DEFAULT 'note' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`source_message_id` integer,
	`created_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	`due_at` integer,
	`reminded_at` integer,
	FOREIGN KEY (`source_message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "notes_subtype_enum" CHECK("notes"."subtype" IN ('memo','note'))
);
--> statement-breakpoint
CREATE INDEX `idx_notes_subtype` ON `notes` (`subtype`);--> statement-breakpoint
CREATE INDEX `idx_notes_pinned` ON `notes` (`pinned`) WHERE pinned = 1;--> statement-breakpoint
CREATE INDEX `idx_notes_archived` ON `notes` (`archived`) WHERE archived = 1;--> statement-breakpoint
CREATE INDEX `idx_notes_created_at` ON `notes` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_notes_due_pending` ON `notes` (`due_at`) WHERE due_at IS NOT NULL AND reminded_at IS NULL AND archived = 0;--> statement-breakpoint
CREATE TABLE `point_tags` (
	`point_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`point_id`, `tag_id`),
	FOREIGN KEY (`point_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_point_tags_tag` ON `point_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `processing_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`type` text NOT NULL,
	`input_type` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`pipeline_step` text,
	`result` text,
	`error_message` text,
	`error_kind` text,
	`created_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "status_enum" CHECK("processing_tasks"."status" IN ('pending', 'processing', 'done', 'error')),
	CONSTRAINT "type_enum" CHECK("processing_tasks"."type" IN ('pipeline')),
	CONSTRAINT "input_type_enum" CHECK("processing_tasks"."input_type" IS NULL OR "processing_tasks"."input_type" IN ('url', 'text', 'opinion')),
	CONSTRAINT "done_requires_result" CHECK("processing_tasks"."status" != 'done' OR "processing_tasks"."result" IS NOT NULL),
	CONSTRAINT "error_requires_message" CHECK("processing_tasks"."status" != 'error' OR "processing_tasks"."error_message" IS NOT NULL),
	CONSTRAINT "error_kind_enum" CHECK("processing_tasks"."error_kind" IS NULL OR "processing_tasks"."error_kind" IN ('schema_validation', 'content_policy', 'rate_limit', 'timeout', 'unknown')),
	CONSTRAINT "error_requires_kind" CHECK("processing_tasks"."status" != 'error' OR "processing_tasks"."error_kind" IS NOT NULL),
	CONSTRAINT "result_json" CHECK("processing_tasks"."result" IS NULL OR json_valid("processing_tasks"."result")),
	CONSTRAINT "pipeline_step_enum" CHECK("processing_tasks"."pipeline_step" IS NULL OR "processing_tasks"."pipeline_step" IN ('collecting', 'classifying', 'extracting', 'matching', 'relating', 'comparing', 'verifying', 'translating', 'validatePipelineOutput', 'storing', 'content_validation'))
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `processing_tasks` (`status`,`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_source` ON `processing_tasks` (`source_id`);--> statement-breakpoint
CREATE TABLE `runtime_config_overrides` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_entity_points` (
	`source_id` integer NOT NULL,
	`entity_id` integer NOT NULL,
	`point_id` integer NOT NULL,
	`judgment` text NOT NULL,
	`created_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	PRIMARY KEY(`source_id`, `entity_id`, `point_id`),
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`point_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "judgment_enum" CHECK("source_entity_points"."judgment" IN ('new', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX `idx_sep_entity_point` ON `source_entity_points` (`entity_id`,`point_id`);--> statement-breakpoint
CREATE INDEX `idx_sep_point` ON `source_entity_points` (`point_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`normalized_url` text,
	`original_url` text,
	`title` text,
	`raw_content` text,
	`metadata` text,
	`status` text DEFAULT 'processing' NOT NULL,
	`created_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`tracking_rule_id` integer,
	CONSTRAINT "status_enum" CHECK("sources"."status" IN ('processing', 'confirmed', 'confirmed_empty', 'failed', 'discarded')),
	CONSTRAINT "kind_enum" CHECK("sources"."kind" IN ('external', 'user')),
	CONSTRAINT "kind_url_constraint" CHECK(
      ("sources"."kind" = 'external' AND "sources"."normalized_url" IS NOT NULL AND "sources"."original_url" IS NOT NULL)
      OR ("sources"."kind" = 'user' AND "sources"."normalized_url" IS NULL AND "sources"."original_url" IS NULL AND "sources"."raw_content" IS NOT NULL)
    ),
	CONSTRAINT "metadata_json" CHECK("sources"."metadata" IS NULL OR (json_valid("sources"."metadata") AND json_type("sources"."metadata") = 'object')),
	CONSTRAINT "origin_enum" CHECK("sources"."origin" IN ('user', 'tracking', 'github_refresh'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sources_url_active` ON `sources` (`normalized_url`) WHERE status IN ('processing', 'confirmed') AND origin != 'github_refresh';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sources_url_processing_refresh` ON `sources` (`normalized_url`) WHERE status = 'processing' AND origin = 'github_refresh';--> statement-breakpoint
CREATE INDEX `idx_sources_normalized_url` ON `sources` (`normalized_url`);--> statement-breakpoint
CREATE INDEX `idx_sources_status` ON `sources` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sources_origin` ON `sources` (`origin`);--> statement-breakpoint
CREATE INDEX `idx_sources_tracking_rule_id` ON `sources` (`tracking_rule_id`);--> statement-breakpoint
CREATE TABLE `submission_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`raw_input` text NOT NULL,
	`result` text NOT NULL,
	`reason` text,
	`task_id` integer,
	`source_id` integer,
	`created_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `processing_tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "result_enum" CHECK("submission_logs"."result" IN ('accepted', 'duplicate', 'rejected')),
	CONSTRAINT "non_accepted_requires_reason" CHECK("submission_logs"."result" = 'accepted' OR "submission_logs"."reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tags_name` ON `tags` (lower("name"));--> statement-breakpoint
CREATE TABLE `task_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`step` text NOT NULL,
	`event` text NOT NULL,
	`message` text,
	`input_summary` text,
	`output_summary` text,
	`timestamp` integer DEFAULT (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `processing_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_log_event_enum" CHECK("task_logs"."event" IN ('start', 'end', 'error', 'skip'))
);
--> statement-breakpoint
CREATE INDEX `idx_task_logs_task_id` ON `task_logs` (`task_id`,`timestamp`);