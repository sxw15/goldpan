PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_processing_tasks` (
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
	CONSTRAINT "status_enum" CHECK("__new_processing_tasks"."status" IN ('pending', 'processing', 'done', 'error')),
	CONSTRAINT "type_enum" CHECK("__new_processing_tasks"."type" IN ('pipeline')),
	CONSTRAINT "input_type_enum" CHECK("__new_processing_tasks"."input_type" IS NULL OR "__new_processing_tasks"."input_type" IN ('url', 'text', 'opinion')),
	CONSTRAINT "done_requires_result" CHECK("__new_processing_tasks"."status" != 'done' OR "__new_processing_tasks"."result" IS NOT NULL),
	CONSTRAINT "error_requires_message" CHECK("__new_processing_tasks"."status" != 'error' OR "__new_processing_tasks"."error_message" IS NOT NULL),
	CONSTRAINT "error_kind_enum" CHECK("__new_processing_tasks"."error_kind" IS NULL OR "__new_processing_tasks"."error_kind" IN ('schema_validation', 'content_policy', 'content_length', 'rate_limit', 'timeout', 'unknown')),
	CONSTRAINT "error_requires_kind" CHECK("__new_processing_tasks"."status" != 'error' OR "__new_processing_tasks"."error_kind" IS NOT NULL),
	CONSTRAINT "result_json" CHECK("__new_processing_tasks"."result" IS NULL OR json_valid("__new_processing_tasks"."result")),
	CONSTRAINT "pipeline_step_enum" CHECK("__new_processing_tasks"."pipeline_step" IS NULL OR "__new_processing_tasks"."pipeline_step" IN ('collecting', 'classifying', 'extracting', 'matching', 'relating', 'comparing', 'verifying', 'translating', 'validatePipelineOutput', 'storing', 'content_validation'))
);
--> statement-breakpoint
INSERT INTO `__new_processing_tasks`("id", "source_id", "type", "input_type", "status", "pipeline_step", "result", "error_message", "error_kind", "created_at", "updated_at") SELECT "id", "source_id", "type", "input_type", "status", "pipeline_step", "result", "error_message", "error_kind", "created_at", "updated_at" FROM `processing_tasks`;--> statement-breakpoint
DROP TABLE `processing_tasks`;--> statement-breakpoint
ALTER TABLE `__new_processing_tasks` RENAME TO `processing_tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `processing_tasks` (`status`,`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_source` ON `processing_tasks` (`source_id`);