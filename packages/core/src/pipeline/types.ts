import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import type { GoldpanConfig } from '../config/index';
import type {
  InputType,
  LlmCallRepository,
  LlmStep,
  PointType,
  ProcessingTask,
  Source,
} from '../db/repositories/types';

// ─── Zod Schemas for LLM Outputs ───────────────────────────
// Schemas are defined per-step in ./schemas/ and re-exported here for convenience.

export {
  type ComparingLlmOutput,
  comparingLlmSchema,
  type EntityMatch,
  type ExtractingOutput,
  entityMatchSchema,
  extractingSchema,
  type MatchingOutput,
  matchingSchema,
  RELATION_TYPES,
  type RelatingOutput,
  type RelationItem,
  type RelationType,
  relatingSchema,
  relationItemSchema,
  type TextClassification,
  type TranslatingOutput,
  textClassificationSchema,
  translatingSchema,
  type UrlClassification,
  urlClassificationSchema,
  type VerifierOutput,
  verifierSchema,
} from './schemas';

// Locally import types used by PipelineContext below
import type { MatchingOutput, RelationType } from './schemas';

// ─── Pipeline Internal Types ────────────────────────────────

/** A knowledge point with its assigned pointKey */
export interface IndexedPoint {
  pointKey: string; // e.g. "kp:0", "kp:1"
  content: string;
  type: PointType;
  /** Hashtag-style labels assigned by the extractor LLM (opinion points only). */
  tags?: string[];
}

/** A validated relation between two entities */
export interface RelationOutput {
  sourceEntityKey: string;
  targetEntityKey: string;
  relationType: RelationType;
  description: string;
}

/** Per-point judgment within an entity */
export interface PointJudgment {
  pointKey: string;
  judgment: 'new' | 'skipped';
  matchedPointId: number | null;
  matchedContent: string | null;
}

export function newJudgment(pointKey: string): PointJudgment {
  return { pointKey, judgment: 'new', matchedPointId: null, matchedContent: null };
}

/** Per-entity judgment after comparing step */
export interface EntityJudgment {
  entityKey: string;
  entityName: string;
  resolvedCategoryPath: string;
  knowledgePointKeys: string[];
  discoveredAliases?: string[];
  keywords?: string[];
  description?: string;
  summary?: string;
  outputMode: 'full_summary' | 'summary_plus_increment' | 'increment_only';
  pointJudgments: PointJudgment[];
}

/** Validation result from validatePipelineOutput */
export interface ValidationResult {
  /** Entities that survived validation */
  validEntities: EntityJudgment[];
  /** Points dropped due to validation failures */
  droppedPoints: DroppedPoint[];
  /** Human-readable warnings for ProcessingResult */
  warnings: string[];
  /** Relations that survived validation */
  validRelations?: RelationOutput[];
  /** Relations dropped due to validation failures */
  droppedRelations?: DroppedRelation[];
}

export interface DroppedPoint {
  pointKey: string;
  entityKey?: string;
  content: string;
  type: PointType;
  reason: 'unassigned' | 'invalid_entity_ref' | 'invalid_entity_key_format';
}

export interface DroppedRelation {
  sourceEntityKey: string;
  targetEntityKey: string;
  /** May contain an invalid value when reason is 'invalid_type' */
  relationType: string;
  reason: 'invalid_entity_ref' | 'self_reference' | 'invalid_type' | 'duplicate_after_promotion';
}

/** Output mode thresholds */
export type OutputMode = 'full_summary' | 'summary_plus_increment' | 'increment_only';

export function determineOutputMode(
  existingFactCount: number,
  fullThreshold: number,
  incrementThreshold: number,
): OutputMode {
  if (existingFactCount <= fullThreshold) return 'full_summary';
  if (existingFactCount <= incrementThreshold) return 'summary_plus_increment';
  return 'increment_only';
}

/** Verifier rejection record */
export interface VerifierRejection {
  pointKey: string;
  reason: string;
}

/**
 * What kind of pipeline output a translation item represents. Drives the
 * `kind` hint the translator LLM sees in the prompt — useful when the model
 * needs to pick a register (factual statement vs. user opinion, etc.) — and
 * categorizes IDs in `PipelineContext.translations`.
 */
export type TranslationItemKind =
  | 'fact'
  | 'opinion'
  | 'entityDescription'
  | 'relationDescription'
  | 'summary'
  | 'rejectionReason';

/**
 * Translations produced by the optional `translating` step. Keys are the
 * synthetic ids assigned by the step (e.g. `p:kp:0`, `ed:draft:0`, `r:..`).
 * Storing reads this map and writes the corresponding `*_translated` columns;
 * absent keys mean "no translation — keep original".
 */
export type TranslationItemMap = Record<string, string>;

/**
 * PipelineContext — the mutable state bag that flows through all pipeline steps.
 * Each step reads what it needs and writes its output.
 */
export interface PipelineContext {
  // ─── Input (set by orchestrator before first step) ────────
  task: ProcessingTask;
  source: Source;
  config: GoldpanConfig;

  // ─── Step 1: inputType ────────────────────────────────────
  inputType: InputType | null;

  // ─── Step 2: collecting ───────────────────────────────────
  /** Content ready for LLM processing (raw_content after collecting or user text) */
  content: string | null;
  /** URL collection only — plugin that successfully produced `content` (for task log summaries) */
  collectorPluginName?: string | null;
  /** collector-browser only — how the browser was launched (for task log output) */
  collectorBrowserEngine?: string | null;
  collectorBrowserEngineLabel?: string | null;
  /** Debug lines from collectors (e.g. browser launch fallback); merged into task log collecting output */
  collectingDiagnostics?: string[];

  // ─── Step 2: collecting (continued) ───────────────────────
  /**
   * ⚠️ **WRITE-ONLY.** Only `collecting.ts` writes this; it is flushed to
   * `sources.metadata` by `sourceRepo.updateAfterCollecting` inside the same
   * step. No other pipeline step reads or writes this field.
   *
   * **Middle pipeline steps (classifying / extracting / matching / relating /
   * comparing / verifying / validate / storing) MUST NOT read this field.** If
   * a middle step needs a new collector signal, add a typed field to
   * `PipelineContext` at the `collecting.ts` boundary (see `updateMode` for
   * the reference pattern).
   *
   * Violating this constraint rolls back the R3 refactor: middle steps reading
   * `collector_*` JSON keys makes core logic depend on collector-authored
   * strings, which the type system cannot constrain.
   */
  collectorMetadata?: import('../db/repositories/types').JsonObject | null;

  /**
   * Typed field mirroring the (boundary-translated) `collector_update_mode`
   * metadata key. Used by `extracting.ts` to toggle the incremental prompt
   * branch (spec §9.1, §9.2, R3). Values outside the union are coerced to `null`
   * by `collecting.ts` — do not trust arbitrary strings from metadata.
   */
  updateMode?: 'initial' | 'incremental' | null;

  // ─── Step 3: classifying ──────────────────────────────────
  classification: {
    categoryPath: string;
    keywords: string[];
  } | null;

  // ─── Step 4: extracting ───────────────────────────────────
  /** Indexed points with assigned pointKeys */
  points: IndexedPoint[];

  // ─── Step 5: matching ─────────────────────────────────────
  matchingOutput: MatchingOutput | null;

  // ─── Step 5.5: relating ───────────────────────────────────
  relations?: RelationOutput[];

  // ─── Step 6: comparing ────────────────────────────────────
  entityJudgments: EntityJudgment[];

  // ─── Step 7: verifying ────────────────────────────────────
  verifierRejections: VerifierRejection[];

  // ─── Step 8: validatePipelineOutput ───────────────────────
  validationResult: ValidationResult | null;

  // ─── Step 8.5: translating (optional) ─────────────────────
  /**
   * Translations produced by the optional `translating` step (gated by
   * `config.translation.translatePipelineOutput`). Absent / empty means the
   * step was skipped or degraded — storing falls back to originals.
   */
  translations?: TranslationItemMap;

  // ─── Accumulated warnings ─────────────────────────────────
  validationWarnings: string[];

  // ─── Cached data (optional, avoids redundant DB queries) ──
  /** Entity registry fetched in matching step, reused in validate-output */
  entityRegistry?: Array<
    import('../db/repositories/types').Entity & {
      categoryPaths: string[];
      activePointCount: number;
    }
  >;

  /** Embedding vectors computed during matching prefilter, reused in storing to avoid double API calls */
  pointEmbeddingsCache?: Map<string, number[]>;

  // ─── Final output (optional, set by storing step) ─────────
  /** ProcessingResult produced by the storing step */
  processingResult?: ProcessingResult;
}

/**
 * ProcessingResult — the final output stored in processing_tasks.result.
 * Matches spec §10.5 exactly.
 */
export interface ProcessingResult {
  taskId: string;
  status: 'done';
  /** Whether the original submission was a neutral fact text or a subjective
   * opinion. Drives which chat bubble (TaskBubbleCard vs NoteBubbleCard) the
   * web UI renders for this task. Mirrored from `processing_tasks.input_type`. */
  inputMode?: 'fact' | 'opinion';
  /** Verbatim user input for opinion submissions (NoteBubbleCard quote block).
   * Identical to `sources.raw_content` for `kind='user'` rows; surfaced here
   * to spare the web client from a separate fetch. */
  noteQuote?: string;
  stats: {
    extracted: number;
    accepted: number;
    droppedUnassigned: number;
    quarantined: number;
    skipped: number;
    verifierRejected: number;
  };
  droppedPoints?: Array<{
    pointKey: string;
    entityKey?: string;
    content: string;
    type: PointType;
    reason: 'unassigned' | 'invalid_entity_ref' | 'invalid_entity_key_format';
  }>;
  validationWarnings?: string[];
  relationStats?: {
    extracted: number;
    validated: number;
    stored: number;
    deduplicated: number;
  };
  source?: {
    id: number;
    title: string;
    originalUrl?: string;
    kind: 'external' | 'user';
  };
  classification?: {
    categoryPath: string;
    keywords: string[];
  };
  entities: Array<{
    entityKey: string;
    entityId?: number;
    entityName: string;
    categoryPath: string;
    keywords: string[];
    isNew: boolean;
    outputMode: OutputMode;
    summary?: string;
    /** Translation of `summary` when the translating step produced one. */
    summaryTranslated?: string;
    /** Translation of the new entity's `description` (new entities only). */
    descriptionTranslated?: string;
    newFactPoints: Array<{
      pointKey: string;
      pointId?: number;
      content: string;
      /** Translation of `content` when produced by the translating step. */
      contentTranslated?: string;
    }>;
    newOpinionPoints: Array<{
      pointKey: string;
      pointId?: number;
      content: string;
      /** Translation of `content` when produced by the translating step. */
      contentTranslated?: string;
      /** Hashtag-style labels (extractor output). Undefined when none. */
      tags?: string[];
    }>;
    skippedFactCount: number;
    skippedFactPoints: Array<{
      pointKey: string;
      matchedPointId: number;
      matchedContent: string;
    }>;
    rejectedPoints?: Array<{
      pointKey: string;
      reason: string;
      /** Translation of `reason` when produced by the translating step. */
      reasonTranslated?: string;
    }>;
  }>;
  error?: {
    step: string;
    message: string;
    retryable: boolean;
  };
}

/**
 * PipelineError & PipelineErrorKind — imported from the shared errors module
 * defined in Phase 2 (`packages/core/src/errors.ts`). No local definition.
 */
import { PipelineError, type PipelineErrorKind } from '../errors';

export { PipelineError, type PipelineErrorKind };

/**
 * Callable type for Phase 2's callLlm wrapper.
 * Steps receive this via dependency injection for testability.
 * Signature matches Phase 2 CallLlmOptions → returns z.infer<T> directly.
 *
 * `timeout` is optional — when omitted, the wrapper in `bootstrap.ts`
 * resolves it via `resolveStepTimeout(config, step)`: per-step override
 * (`GOLDPAN_LLM_<STEP>_TIMEOUT`) falling back to global `llmTimeout`.
 * Callers should normally omit it so the central resolution applies.
 */
export type CallLlmFn = <T extends z.ZodType>(opts: {
  model?: LanguageModel;
  step: LlmStep;
  schema: T;
  system: string;
  prompt: string;
  promptHash: string;
  sourceId: number | null;
  llmCallRepo: LlmCallRepository;
  logPayloads: boolean;
  timeout?: number;
  logger?: { error(msg: string, ...args: unknown[]): void };
  signal?: AbortSignal;
}) => Promise<z.infer<T>>;
