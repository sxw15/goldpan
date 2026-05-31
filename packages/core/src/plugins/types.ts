import type { LanguageModel } from 'ai';
import type { ILogObj, Logger } from 'tslog';
import type { z } from 'zod';
import type { GoldpanConfig } from '../config/index';
import type { ConfigStore } from '../config/store-types';
import type { DrizzleDB } from '../db/connection';
import type { LlmCallRepository, LlmStep } from '../db/repositories/types';
import type { Language } from '../i18n/types';
import type { CallLlmFn } from '../pipeline/types';
import type { QueryResult } from '../query/index';
import type { SubmitResult } from '../submit';
import type { PluginActionHandler, PluginSettingsContribution } from './contribution';

export type PluginType = 'collector' | 'intent' | 'tool' | 'llm-provider';

// Plugins receive only non-sensitive config via pluginConfig.
// V1: startup code populates { httpTimeout: config.collectTimeout }.
// Future: YAML `plugins:` section populates pluginConfig per plugin.
export interface PluginContext {
  logger: Logger<ILogObj>;
  pluginConfig: Record<string, unknown>;
  /**
   * Live config store — plugins may either read snap.config per-call or
   * subscribe via configStore.onChange to react to user-saved updates.
   * Subscriptions returned via the unsubscribe fn should be detached in
   * the plugin's destroy() hook so unit tests don't leak listeners.
   */
  configStore: ConfigStore;
}

export interface GoldpanPlugin {
  name: string;
  version: string;
  type: PluginType;
  /** Default description, English-first. Used as fallback when descriptions[lang] missing. */
  description: string;
  /**
   * Optional per-language descriptions for the settings UI. Mirrors
   * `IntentDeclaration.descriptions`: the locale key selects, falls back to
   * `description`. Server `/settings/plugins` resolves this server-side before
   * returning to the web client.
   */
  descriptions?: Partial<Record<Language, string>>;
  /** Declare which service capabilities this plugin needs (empty = none). */
  requiredCapabilities?: (keyof ServiceCapabilities)[];
  initialize?: (
    context: PluginContext,
    capabilities?: Partial<ServiceCapabilities>,
  ) => Promise<void>;
  /**
   * Runs after every plugin's initialize has finished. Use when setup needs
   * services (e.g. pluginRegistry.getService('tracking')) that may not be
   * registered until later plugins' initialize runs, or until composition
   * layers (e.g. composeIMRuntime) register their own services.
   * Failures are logged but do NOT abort other plugins' postInit.
   */
  postInit?: (context: PluginContext, capabilities?: Partial<ServiceCapabilities>) => Promise<void>;
  destroy?: () => Promise<void>;
  /**
   * Optional settings UI contribution. When present, `PluginRegistry.register`
   * automatically calls `registerSettingsContribution` with this descriptor +
   * `settingsActionHandlers` (if any). Plugin authors get a Settings page
   * section for free without manually wiring registry hooks. Validation runs
   * synchronously at register time; an invalid contribution throws and aborts
   * registration of the whole plugin.
   *
   * `pluginId` inside the contribution must equal `plugin.name`. This is
   * enforced at register time so settings UI can be routed by stable id
   * (URL-encoded into `/settings/contributions/:pluginId/actions/...`).
   */
  settingsContribution?: PluginSettingsContribution;
  /**
   * Action handlers for the plugin's `settingsContribution.actions`. Keyed by
   * action.id. Required when the contribution declares any actions; omitting
   * a referenced handler throws at register time.
   */
  settingsActionHandlers?: Record<string, PluginActionHandler>;
}

// ─── Collector Plugin ──────────────────────────────────────

export interface CollectorInput {
  url: string;
}

export interface CollectorOutput {
  /** Extracted content as Markdown */
  content: string;
  /** Page title, null if not extractable */
  title: string | null;
  /** Collector-owned metadata (all keys prefixed with `collector_`) */
  metadata: Record<string, unknown>;
  /** Final URL after following redirects */
  finalUrl: string;
}

/**
 * Phase 4 adapter result returned by PluginRegistry.getCollector().
 * Differs from CollectorOutput: no top-level finalUrl (injected into metadata instead).
 */
export interface CollectorResult {
  content: string;
  title: string | null;
  metadata: Record<string, unknown>;
}

export interface CollectorPlugin extends GoldpanPlugin {
  type: 'collector';
  canHandle: (input: CollectorInput) => boolean | Promise<boolean>;
  /** Higher priority = checked first. Built-in collector-web uses 0 (fallback). */
  priority: number;
  collect: (input: CollectorInput, signal: AbortSignal) => Promise<CollectorOutput>;

  /**
   * Per-plugin collect timeout (milliseconds). Returning `undefined` (or not
   * implementing this method at all) makes the registry fall back to the global
   * `collectTimeoutSeconds` default. Plugins whose collect path is inherently
   * slower than typical web collectors (e.g. `collector-media` invoking
   * `yt-dlp`) should report their own longer timeout here so the registry can
   * set the AbortSignal accordingly.
   */
  getCollectTimeoutMs?(): number | undefined;
}

// ─── Tool Plugin ──────────────────────────────────────────

export interface ToolDeclaration {
  /** Capability identifier, e.g. 'search'. Multiple plugins may register the same capability. */
  name: string;
  /** Human-readable description */
  description: string;
  /** Zod schema for tool input validation */
  inputSchema: z.ZodType;
  /** Zod schema for tool output validation */
  outputSchema: z.ZodType;
}

export interface ToolPlugin extends GoldpanPlugin {
  type: 'tool';
  /** Higher priority = tried first when multiple plugins offer the same tool. */
  priority: number;
  /** Tool declarations. May be empty initially — populated during initialize() (see self-disabling pattern). */
  tools: ToolDeclaration[];
  executeTool(toolName: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
}

export function isToolPlugin(plugin: GoldpanPlugin): plugin is ToolPlugin {
  return plugin.type === 'tool';
}

// ─── Service Capabilities ─────────────────────────────────

/**
 * Simplified LLM call signature for service plugins. Pre-binds model resolution,
 * logger, llmCallRepo, logPayloads, and timeout from bootstrap context.
 */
export type ServiceCallLlmFn = <T extends z.ZodType>(opts: {
  step: LlmStep;
  schema: T;
  system: string;
  prompt: string;
  promptHash: string;
  sourceId?: number | null;
  signal?: AbortSignal;
}) => Promise<z.infer<T>>;

/**
 * Capabilities that service-level plugins may request.
 * Plugins declare needed capabilities in their manifest.
 * Bootstrap injects only the requested capabilities during initializeAll().
 */
export interface ServiceCapabilities {
  db: DrizzleDB;
  config: GoldpanConfig;
  pluginRegistry: import('./registry').PluginRegistry;
  submitInput: (input: string, options?: { origin?: 'user' | 'tracking' }) => Promise<SubmitResult>;
  callLlm: ServiceCallLlmFn;
}

// ─── Intent Plugin ─────────────────────────────────────────

export interface IntentDeclaration {
  /** Unique identifier, kebab or snake_case, e.g. 'daily_report' */
  name: string;
  /** Default description injected into LLM system prompt */
  description: string;
  /** Optional per-language descriptions; language key selects, falls back to description */
  descriptions?: Partial<Record<Language, string>>;
  /** Input examples to help LLM classify more accurately */
  examples?: string[];
  /** Classification guidelines injected into system prompt for disambiguation */
  classificationHints?: string[];
  /**
   * Priority for same-name intent arbitration. Higher number wins.
   * Built-in plugins use 0 (default). External plugins should use 10+.
   */
  priority?: number;
  /**
   * Max input length (characters) accepted by this intent's execute().
   * If set, handleInput rejects inputs exceeding this limit before calling execute().
   */
  maxInputLength?: number;
  /**
   * Allowed result types this intent may return. If set, handleInput validates
   * the plugin result type against this list. If omitted, all result types are accepted.
   */
  resultTypes?: IntentPluginResult['type'][];
}

/** Internal registry entry linking an intent name to its owning plugin and declaration. */
export interface IntentRegistration {
  plugin: IntentPlugin;
  declaration: IntentDeclaration;
}

/** Narrow repo interface for intent plugin execution context */
export interface HandleInputRepos {
  llmCall: LlmCallRepository;
  submissionLog: import('../db/repositories/types').SubmissionLogRepository;
  knowledge: import('../db/repositories/types').KnowledgeRepository;
  category: import('../db/repositories/types').CategoryRepository;
  /** P2: intent-note 用 — 写 notes 表 / 反查 note detail */
  notes: import('../notes/types').NotesRepository;
  /** P2: intent-tracking + intent-note 反查 entity_ids from source */
  source: import('../db/repositories/types').SourceRepository;
  /** P2: handleInput wait 分支用 — markBufferedWait + 反查 message 等 */
  conversation: import('../db/repositories/types').ConversationRepository;
}

/**
 * Structurally compatible subset of the IM runtime's `SessionRef`
 * (`channelId` / `accountId` / `chatId` / `userId`). Populated by the IM
 * runtime's inbound dispatcher when an intent is invoked from a chat message,
 * so plugins don't have to reverse-engineer the `userId` out of
 * `conversation.sessionKey` — the key loses the user under `per_chat` routing
 * (three segments, userId absent), which would silently collide every
 * subscription/preference keyed on (chat, user) in group chats.
 *
 * Declared inline here rather than imported from `@goldpan/im-runtime` to keep
 * dependency direction going only from high to low (CLAUDE.md §1). The IM
 * runtime's `SessionRef` is structurally compatible and assigns into this shape
 * at the dispatch site.
 */
export interface IntentSessionRef {
  channelId: string;
  accountId: string;
  chatId: string;
  userId: string;
}

export interface IntentExecutionContext {
  logger: Logger<ILogObj>;
  config: import('../config/index').GoldpanConfig;
  language: Language;
  db: DrizzleDB;
  repos: HandleInputRepos;
  callLlm: CallLlmFn;
  /** Derived from repos.llmCall by handleInput; kept as convenience for QueryDeps compatibility */
  llmCallRepo: LlmCallRepository;
  logPayloads: boolean;
  llmTimeout: number;
  embeddingProvider?: import('../embedding/types').EmbeddingProvider | null;
  /** Optional multi-turn conversation context. Filled by IM Runtime; web/CLI leave undefined. */
  conversation?: import('../conversation/types').ConversationContext;
  /**
   * Optional session reference set by the IM runtime's inbound dispatcher.
   * Carries the real `userId` alongside `chatId` so plugins don't have to parse
   * `conversation.sessionKey` (which under `per_chat` routing contains only
   * channel/account/chat — no userId). Web/CLI callers leave this undefined.
   */
  sessionRef?: IntentSessionRef;

  // ─── P2 additions ──────────────────────────────────────────
  /**
   * Classifier 输出的 linkedSourceId（指向某条具体 source）。Plugin 自行决定
   * 是否反查 entity_ids。intent-note / intent-tracking 用得到。
   */
  linkedSourceId?: number;
  /**
   * Classifier 输出的 note subtype（仅 intent='create_note' 时由 classifier 携带）。
   */
  noteSubtype?: import('../intent/types').IntentNoteSubtype;
  /**
   * Classifier 标记 source 还在 pipeline，需要 deferred 解析 entity。
   * 仅 intent='create_tracking' 时由 classifier 携带。
   */
  deferredEntityResolution?: boolean;
  /**
   * Adapter 写入 user turn 后传进来的 conversation_messages.id。Plugin 写
   * 关联（如 note.sourceMessageId）时拿来引用。
   */
  currentUserMessageId?: number;
  /**
   * P4: 与 `forcedIntent` 成对透传的不透明 payload —— clarify chip 的
   * `structuredOptions[i].payload` 由 server / inputAction 一路搬到这里。
   * Plugin 自行约定 shape (例如 resolve_tracking_entity 把 ruleId / entityId
   * 序列化进 JSON)。free-text 路径 (classifier execute / wait) 留 undefined。
   */
  payload?: string;
}

export const INTENT_RESULT_TYPES = [
  'submit',
  'query',
  'content',
  'action',
  'clarify',
  'wait', // 新增 — handleInput wait decision 出口
  'note', // 新增 — intent-note plugin 出口
  'tracking_pending', // 新增 — intent-tracking deferred 出口
] as const;
export type IntentPluginResultType = (typeof INTENT_RESULT_TYPES)[number];

export interface ResolvedEntity {
  id: number;
  name: string;
  categoryPaths: string[];
}

export interface ResolvedKnowledgePoint {
  id: number;
  type: 'fact' | 'opinion';
  content: string;
  entityId: number | null;
}

export type IntentPluginResult =
  | { type: 'submit'; result: SubmitResult }
  | {
      type: 'query';
      result: QueryResult;
      query: string;
      /** Resolved entity rows (populated by intent-query plugin from citedEntityIds). Empty if not resolved. */
      citedEntities?: ResolvedEntity[];
      /** Resolved knowledge point rows (populated by intent-query plugin from citedPointIds). Empty if not resolved. */
      citedPoints?: ResolvedKnowledgePoint[];
    }
  | { type: 'content'; text: string; format?: 'text' | 'markdown'; title?: string }
  | { type: 'action'; message: string; actionId?: string }
  | {
      type: 'clarify';
      // ─── Legacy fields（兼容现有 tracking / github-intent / digest plugin）──
      // 仍允许外部 plugin 返回 free-text question + string[] options。P2 不强制
      // 全 plugin 迁移；P6 cleanup 时统一删。Web UI 优先读 keyed 字段，回退 legacy。
      question?: string;
      options?: string[];
      // ─── P2 keyed fields（classifier 路径产物）─────────────────────────────
      questionKey?: import('../intent/types').ClarifyQuestion;
      structuredOptions?: Array<{
        intentKey: import('../intent/types').ClarifyOptionKey;
        payload?: string;
      }>;
    }
  | {
      type: 'wait';
      /** conversation_messages.id of the just-buffered user turn */
      bufferedMessageId: number;
      /** Absolute expiry timestamp in epoch ms (now + maxWaitMs) */
      expiresAt: number;
      fallbackIntent: import('../intent/types').FallbackIntent;
      maxWaitMs: number;
      waitReasonKey: import('../intent/types').WaitReason;
    }
  | {
      type: 'note';
      detail: import('../notes/types').NoteDetail;
    }
  | {
      type: 'tracking_pending';
      trackingRuleId: number;
      /** Why is this pending (i18n key). E.g. 'waiting_pipeline', 'multi_entity_clarify' */
      reasonKey: 'waiting_pipeline' | 'multi_entity_clarify';
    };

// Compile-time assertion: IntentPluginResult['type'] and IntentPluginResultType must stay in sync.
// Adding a variant to IntentPluginResult without updating INTENT_RESULT_TYPES (or vice versa)
// makes `true satisfies false` fail. Tuple wrapping prevents union distribution.
true satisfies [IntentPluginResult['type']] extends [IntentPluginResultType]
  ? [IntentPluginResultType] extends [IntentPluginResult['type']]
    ? true
    : false
  : false;

export interface IntentPlugin extends GoldpanPlugin {
  type: 'intent';
  intents: IntentDeclaration[];
  execute(
    intent: string,
    input: string,
    context: IntentExecutionContext,
    signal?: AbortSignal,
  ): Promise<IntentPluginResult>;
}

export function isIntentPlugin(plugin: GoldpanPlugin): plugin is IntentPlugin {
  return plugin.type === 'intent';
}

// ─── LLM Provider Plugin ───────────────────────────────────

export interface LlmProviderPlugin extends GoldpanPlugin {
  type: 'llm-provider';
  /** Prefix used in modelId strings (e.g. "cohere:command-r-plus"). Lowercase, must not collide with builtins or other plugins. */
  providerId: string;
  /**
   * Returns an AI SDK Provider object. Plugin reads its own env vars (mirrors
   * the existing collector/intent/tool plugin pattern — see
   * plugins/tool-search-tavily/src/index.ts:22). Throwing here records the
   * plugin in `pluginLoadStatus` as failed; other plugins continue.
   */
  createProvider(): {
    languageModel(modelId: string): LanguageModel;
  };
}

/**
 * Resolve a plugin's description for the given locale. Mirrors the
 * `IntentDeclaration.descriptions` lookup: `descriptions[locale]` wins, then
 * falls back to the default English-first `description` field.
 */
export function resolvePluginDescription(
  plugin: Pick<GoldpanPlugin, 'description' | 'descriptions'>,
  locale: Language,
): string {
  return plugin.descriptions?.[locale] ?? plugin.description;
}

export function isLlmProviderPlugin(value: unknown): value is LlmProviderPlugin {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<LlmProviderPlugin>;
  return (
    p.type === 'llm-provider' &&
    typeof p.name === 'string' &&
    typeof p.version === 'string' &&
    typeof p.description === 'string' &&
    typeof p.providerId === 'string' &&
    /^[a-z][a-z0-9_-]*$/.test(p.providerId) &&
    typeof p.createProvider === 'function'
  );
}
