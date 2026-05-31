import type { ILogObj, Logger } from 'tslog';
import type { GoldpanConfig } from './config/index';
import type { DrizzleDB } from './db/connection';
import { errorMessage, PipelineError } from './errors';
import { t } from './i18n/index';
import { type ClassifyIntentDeps, classifyIntent, type IntentResult } from './intent/index';
import type { IntentNoteSubtype } from './intent/types';
import type { CallLlmFn } from './pipeline/types';
import { collectMentionedSourceIds } from './plugins/builtin/utils/conversation-context';
import type { PluginRegistry } from './plugins/registry';
import type {
  HandleInputRepos,
  IntentExecutionContext,
  IntentPluginResult,
  IntentSessionRef,
} from './plugins/types';
import { INTENT_RESULT_TYPES } from './plugins/types';
import { type SubmitDeps, submitInput } from './submit';
import { detectInputUrl } from './utils/input-detector';

// ─── Types ──────────────────────────────────────────────────

export type InputErrorCode =
  | 'input_empty'
  | 'text_too_long'
  /** @deprecated Retained for standalone /query endpoint; handleInput uses input_too_long_for_intent */
  | 'query_too_long'
  | 'input_too_long_for_intent'
  | 'intent_failed'
  | 'submit_failed'
  | 'query_failed'
  | 'unknown_intent'
  | 'plugin_error';

export type HandleInputResult =
  | IntentPluginResult
  | { type: 'error'; code: InputErrorCode; message: string };

export interface HandleInputDeps {
  db: DrizzleDB;
  callLlm: CallLlmFn;
  pluginRegistry: PluginRegistry;
  config: GoldpanConfig;
  repos: HandleInputRepos;
  logger: Logger<ILogObj>;
  signal?: AbortSignal;
  embeddingProvider?: import('./embedding/types').EmbeddingProvider | null;
  /** Optional multi-turn conversation context (forwarded into IntentExecutionContext). */
  conversation?: import('./conversation/types').ConversationContext;
  /**
   * Optional IM session reference forwarded verbatim into `IntentExecutionContext.sessionRef`.
   * The IM runtime's inbound dispatcher populates this so plugins see the real `userId`
   * even under `per_chat` routing (where `sessionKey` omits it).
   */
  sessionRef?: IntentSessionRef;
  /**
   * When provided, `handleInput` skips intent classification (no LLM call) and dispatches
   * the input straight to the plugin handling this intent name. Used by the IM Runtime to
   * implement bound-intent commands (`/ask` → `query`, `/note` → `record_thought`,
   * `/save` → `submit_url`). When unset, free-text intent classification runs as usual.
   * Unknown intent names yield the same `unknown_intent` error as a misclassification.
   */
  forcedIntent?: string;
  /**
   * P4: opaque payload that travels alongside `forcedIntent` end-to-end. clarify chip
   * 的 structuredOptions 携带的 `payload?: string` 由 server / inputAction 透传到这里，
   * 再注入 `IntentExecutionContext.payload`，plugin (例如 resolve_tracking_entity)
   * 自行解析。shape 由 plugin 决定 —— 这里只做透明搬运。
   */
  payload?: string;
  /**
   * P2: 调用方写入 user turn 后传进来的 conversation_messages.id。
   * - execute 分支：透传到 IntentExecutionContext.currentUserMessageId，让
   *   intent-note 等 plugin 能把 note.sourceMessageId 关联到这条消息。
   * - wait 分支：作为 markBufferedWait 的 messageId 参数（CAS 目标）。
   *   undefined 时（CLI 场景）wait 决策降级为立即跑 fallbackIntent，避免悬空。
   */
  currentUserMessageId?: number;
  /**
   * P3 buffer-finalize 注入点 —— forcedIntent 路径绕开 classifier 时，由
   * caller（finalizeBuffer）直接把 classifierDecision.linkedSourceId 透传进来，
   * input.ts execute 分支按 `deps.linkedSourceId` fallback 注入 IntentExecutionContext。
   */
  linkedSourceId?: number;
  /**
   * P3 buffer-finalize 注入点 —— forcedIntent 路径绕开 classifier 时，由
   * caller 直接传入 note subtype（classifier 不会再跑一次拿不到这个字段）。
   */
  noteSubtype?: IntentNoteSubtype;
  /**
   * P2 DI 注入点：测试 / P3 buffer-release 场景下传 mock 或 pre-cooked
   * classifier 实现；生产 fallback 到 import 的默认 classifyIntent。
   * 走 DI 而非 vi.mock，对齐项目"0 处 vi.spyOn / vi.mock" 惯例（spec §11）。
   */
  classifyIntent?: typeof classifyIntent;
}

export type { HandleInputRepos };

// Short-circuit threshold: URLs with annotation shorter than this skip LLM intent
// classification and go directly to submit. 20 chars covers brief prefixes like
// "check this:" but routes longer annotations (questions, opinions) through the LLM.
const URL_SHORT_CIRCUIT_ANNOTATION_LIMIT = 20;

// Built-in intent names — update this union when adding new built-in intents so
// that INTENT_ERROR_CODE stays exhaustive (TS will error on missing keys).
type BuiltInIntentName = 'submit_url' | 'submit_text' | 'record_thought' | 'query';

const INTENT_ERROR_CODE: Record<BuiltInIntentName, InputErrorCode> = {
  submit_url: 'submit_failed',
  submit_text: 'submit_failed',
  record_thought: 'submit_failed',
  query: 'query_failed',
};

// ─── Main entry point ───────────────────────────────────────

/**
 * Unified input handler. Routes user input through intent classification,
 * then delegates to the appropriate plugin handler.
 *
 * Short-circuits obvious URLs to skip LLM intent classification.
 * Does NOT handle auth, rate limiting, or i18n — those are caller concerns.
 */
export async function handleInput(
  rawInput: string,
  deps: HandleInputDeps,
): Promise<HandleInputResult> {
  const { config } = deps;
  const input = rawInput.trim();
  if (!input) {
    return { type: 'error', code: 'input_empty', message: 'Input is empty' };
  }

  // Length check applies to ALL paths (including URL short-circuit) to prevent
  // oversized inputs from reaching the DB or consuming excessive resources.
  if (input.length > config.maxTextInputLength) {
    return { type: 'error', code: 'text_too_long', message: 'Input too long' };
  }

  // P3 Path C：原 fire-and-forget IIFE 已废弃 —— 与主路径 classify 的 assistant
  // turn 写入存在 ordering race。caller (apps/server main.ts / im-runtime
  // dispatcher.ts) 现在在 appendUserTurn 之前同步 await
  // `reconcileExpiredBufferedBySession`，fallback assistant turn 一定在新
  // user turn 之前入库，UI 顺序正确。Path E cron 仍负责"用户彻底没回来"。

  // Short circuit: obvious URL with brief annotation → skip LLM
  // Gated on !forcedIntent so that bound-intent commands bypass auto-detection.
  if (!deps.forcedIntent) {
    const detection = detectInputUrl(input);
    if (detection.hasUrl) {
      const annotationLength = detection.userAnnotation?.length ?? 0;
      if (annotationLength < URL_SHORT_CIRCUIT_ANNOTATION_LIMIT) {
        try {
          const submitDeps: SubmitDeps = {
            db: deps.db,
            submissionLog: deps.repos.submissionLog,
            maxTextInputLength: config.maxTextInputLength,
            ssrfValidationEnabled: config.ssrfValidationEnabled,
          };
          const result = await submitInput(input, submitDeps);
          return { type: 'submit', result };
        } catch (err) {
          deps.logger.error('URL short-circuit submit failed', {
            err: errorMessage(err),
          });
          return { type: 'error', code: 'submit_failed', message: 'Submit failed' };
        }
      }
    }
  }

  // ─── Intent decision resolution ─────────────────────────────
  // classifierDecision 仅在非 forcedIntent 路径下被 populate，后续 context 装配
  // 时按 decision==='execute' 拆出 linkedSourceId / noteSubtype / deferredEntityResolution。
  let classifierDecision: IntentResult | null = null;
  let resolvedIntent: string;

  if (deps.forcedIntent) {
    resolvedIntent = deps.forcedIntent;
  } else {
    const declarations = deps.pluginRegistry.getIntentDeclarations();
    const intentDeps: ClassifyIntentDeps = {
      callLlm: deps.callLlm,
      llmCallRepo: deps.repos.llmCall,
      language: config.language,
      logPayloads: config.llmLogPayloads,
      intentDeclarations: declarations,
      recentMessages: deps.conversation?.recentMessages,
      signal: deps.signal,
    };

    // DI 注入点：测试 / P3 buffer-release 走 deps.classifyIntent；生产 fallback 到 import
    const classify = deps.classifyIntent ?? classifyIntent;

    try {
      const limit = config.intentClassificationCharLimit;
      const classifyInput =
        limit > 0 && input.length > limit ? Array.from(input).slice(0, limit).join('') : input;
      classifierDecision = await classify(classifyInput, intentDeps);
    } catch (err) {
      deps.logger.error('Intent classification failed', {
        err: errorMessage(err),
        kind: err instanceof PipelineError ? err.kind : undefined,
      });
      return { type: 'error', code: 'intent_failed', message: 'Intent classification failed' };
    }

    // ─── decision=wait: 标 buffered + 早退 ────────────────────
    if (classifierDecision.decision === 'wait') {
      const currentMsgId = deps.currentUserMessageId;
      if (currentMsgId === undefined) {
        // CLI 场景无 conversation_messages.id —— wait 无意义（没东西可挂起）。
        // 降级为立即跑 fallbackIntent 避免悬空。spec §"关键设计取舍" 第 11 条明确容忍。
        deps.logger.debug('wait decision without currentUserMessageId — falling back', {
          fallbackIntent: classifierDecision.fallbackIntent,
        });
        resolvedIntent = classifierDecision.fallbackIntent;
      } else {
        const expiresAt = Date.now() + classifierDecision.maxWaitMs;
        const marked = deps.repos.conversation.markBufferedWait(
          currentMsgId,
          expiresAt,
          {
            decision: 'wait',
            intent: classifierDecision.intent,
            fallbackIntent: classifierDecision.fallbackIntent,
            waitReason: classifierDecision.waitReason,
            maxWaitMs: classifierDecision.maxWaitMs,
            linkedSourceId: classifierDecision.linkedSourceId ?? null,
          },
          { waitReasonKey: classifierDecision.waitReason }, // P3: 顶层 user-visible
        );
        if (!marked) {
          // CAS 失败：message 已经不是 normal 状态（被并发 buffer / consume）。
          // 安全做法是放弃这次 wait，告诉 caller 重试 / 切到别的 intent。
          deps.logger.warn('markBufferedWait CAS failed', { messageId: currentMsgId });
          return {
            type: 'error',
            code: 'intent_failed',
            message: 'Could not buffer message — already consumed',
          };
        }
        return {
          type: 'wait',
          bufferedMessageId: currentMsgId,
          expiresAt,
          fallbackIntent: classifierDecision.fallbackIntent,
          maxWaitMs: classifierDecision.maxWaitMs,
          waitReasonKey: classifierDecision.waitReason,
        };
      }
    }

    // ─── decision=clarify: 早退 ────────────────────────────────
    if (classifierDecision.decision === 'clarify') {
      // 同时填 keyed（P2 UI 优先消费）+ legacy（外部 plugin / 老 UI 兜底）字段。
      // legacy.question / legacy.options 通过 core t() 把 enum key 翻译为当前 language
      // 的人类可读文案，让现有 ClarifyResultCard / IM render 不破即可显示。
      // Task 15 会补全 i18n key；此前 t() 找不到 key 时降级返回 key 本身（i18n/index.ts 行为）。
      const legacyQuestion = t(
        `intent_classifier.clarify_question.${classifierDecision.clarifyQuestionKey}`,
      );
      const legacyOptions = classifierDecision.clarifyOptions.map((o) =>
        t(`intent_classifier.clarify_option.${o.intentKey}`),
      );
      return {
        type: 'clarify',
        questionKey: classifierDecision.clarifyQuestionKey,
        structuredOptions: classifierDecision.clarifyOptions,
        // legacy 兼容字段
        question: legacyQuestion,
        options: legacyOptions,
      };
    }

    // decision === 'execute'
    resolvedIntent = classifierDecision.intent;
  }

  // ─── Plugin lookup ──────────────────────────────────────────
  const registration = deps.pluginRegistry.findIntentDeclaration(resolvedIntent);
  if (!registration) {
    return {
      type: 'error',
      code: 'unknown_intent',
      message: `Unknown intent: ${resolvedIntent}`,
    };
  }
  const plugin = registration.plugin;

  // Generic maxInputLength check — uses the winning declaration's limit
  if (
    registration.declaration.maxInputLength != null &&
    registration.declaration.maxInputLength > 0
  ) {
    const maxLen = registration.declaration.maxInputLength;
    if (input.length > maxLen) {
      return {
        type: 'error',
        code: 'input_too_long_for_intent',
        message: `Input too long for intent "${resolvedIntent}" (max ${maxLen} characters)`,
      };
    }
  }

  // Build execution context — llmCallRepo is derived from repos.llmCall
  // (duplicated field kept for backward compat with QueryDeps / external plugins).
  //
  // classifier 的 linked-* 字段仅 execute 分支携带；wait 降级路径 / forcedIntent 留 undefined。
  // 把 narrow 过的 execute decision 抓出来一次性 destructure，避免在 object literal 里
  // 多次 if-condition 触发 TS narrowing 丢失（discriminatedUnion 在 callback / ternary
  // 里不会自动 narrow 到 'execute' 分支，必须用 if-guard）。
  const executeDecision = classifierDecision?.decision === 'execute' ? classifierDecision : null;

  // B2 中央化校验：linkedSourceId 必须 ∈ recentMessages 提到的 sourceId 集合，
  // 防 LLM hallucinate 跨 conversation 串到无关 source。plugin 不再各自重复
  // 同一校验 —— context 透传出去的值已经 trusted。
  const candidateLinkedSourceId =
    executeDecision?.linkedSourceId ?? deps.linkedSourceId ?? undefined;
  let validatedLinkedSourceId: number | undefined;
  if (candidateLinkedSourceId !== undefined) {
    const mentioned = collectMentionedSourceIds(deps.conversation?.recentMessages);
    if (mentioned.has(candidateLinkedSourceId)) {
      validatedLinkedSourceId = candidateLinkedSourceId;
    } else {
      deps.logger.warn('handleInput: linkedSourceId not in recent messages — dropping', {
        linkedSourceId: candidateLinkedSourceId,
        mentioned: [...mentioned],
      });
    }
  }

  const context: IntentExecutionContext = {
    logger: deps.logger,
    config,
    language: config.language,
    db: deps.db,
    repos: deps.repos,
    callLlm: deps.callLlm,
    llmCallRepo: deps.repos.llmCall,
    logPayloads: config.llmLogPayloads,
    llmTimeout: config.llmTimeout,
    embeddingProvider: deps.embeddingProvider,
    conversation: deps.conversation,
    sessionRef: deps.sessionRef,
    // ─── P2 additions ────────────────────────────────────────
    // P3: forcedIntent 路径下 classifier 不跑（executeDecision==null），
    // 由 caller（finalizeBuffer）通过 deps.linkedSourceId / deps.noteSubtype
    // 直接注入。两条路径互斥：classifier 跑过就用它的输出，没跑就读 deps。
    linkedSourceId: validatedLinkedSourceId,
    noteSubtype: executeDecision?.noteSubtype ?? deps.noteSubtype,
    deferredEntityResolution: executeDecision?.deferredEntityResolution,
    currentUserMessageId: deps.currentUserMessageId,
    // P4: forcedIntent 路径 (chip click) 的 payload 透传到 plugin。free-text
    // 路径 deps.payload 始终 undefined —— 与 classifier 路径互斥。
    payload: deps.payload,
  };

  // Execute plugin (pass signal for cooperative cancellation)
  try {
    const pluginResult = await plugin.execute(resolvedIntent, input, context, deps.signal);

    // Runtime validation: ensure plugin result type is allowed
    const allValidTypes: readonly string[] = INTENT_RESULT_TYPES;
    const declaredTypes = registration.declaration.resultTypes;
    const allowedTypes = declaredTypes && declaredTypes.length > 0 ? declaredTypes : allValidTypes;
    if (
      !pluginResult ||
      !allValidTypes.includes(pluginResult.type) ||
      !allowedTypes.includes(pluginResult.type)
    ) {
      return {
        type: 'error',
        code: 'plugin_error',
        message: `Plugin returned invalid result type: ${(pluginResult as Record<string, unknown>)?.type ?? 'undefined'}`,
      };
    }

    return pluginResult;
  } catch (err) {
    const code =
      resolvedIntent in INTENT_ERROR_CODE
        ? INTENT_ERROR_CODE[resolvedIntent as BuiltInIntentName]
        : 'plugin_error';
    deps.logger.error('Plugin execution failed', {
      intent: resolvedIntent,
      code,
      err: errorMessage(err),
    });
    return { type: 'error', code, message: 'Plugin execution failed' };
  }
}
