import { generateText, type LanguageModel, NoObjectGeneratedError, Output } from 'ai';
import { toJSONSchema, type z } from 'zod';
import type { LlmCallRepository, LlmFailureKind, LlmStep } from '../db/repositories/types';
import { errorMessage, PipelineError } from '../errors';
import { t } from '../i18n/index';
import { truncate } from '../utils/truncate';

const MAX_TRANSIENT_RETRIES = 3;
const MAX_SCHEMA_RETRIES = 2;
/**
 * Hard cap on `generateText` invocations per `callLlm` (safety fuse against pathological loops).
 * Not derived from MAX_TRANSIENT_RETRIES / MAX_SCHEMA_RETRIES alone; adjust with care if retry logic changes.
 */
const MAX_TOTAL_INVOCATIONS = MAX_TRANSIENT_RETRIES + MAX_SCHEMA_RETRIES + 1;
const BACKOFF_BASE_MS = 1000;
const MAX_FAILURE_MSG = 500;

/** Minimal logger interface accepted by callLlm for observability-failure logs. */
interface MinimalLogger {
  error(msg: string, ...args: unknown[]): void;
}

export interface CallLlmOptions<T extends z.ZodType> {
  model: LanguageModel;
  step: LlmStep;
  schema: T;
  system: string;
  prompt: string;
  promptHash: string;
  sourceId: number | null;
  llmCallRepo: LlmCallRepository;
  logPayloads: boolean;
  timeout: number;
  /** Optional structured logger for observability-failure log lines. Falls back to console.error. */
  logger?: MinimalLogger;
  /** Caller-supplied signal for cooperative cancellation (merged with per-call timeout). */
  signal?: AbortSignal;
}

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
  }
  return undefined;
}

function getErrorData(error: unknown): Record<string, unknown> | undefined {
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    if (typeof e.data === 'object' && e.data !== null) return e.data as Record<string, unknown>;
  }
  return undefined;
}

function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    return getErrorStatus(error) === 429;
  }
  return false;
}

function isServerError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status !== undefined && status >= 500 && status < 600;
}

function isContentPolicyError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('content policy') || msg.includes('content_policy')) return true;
    // Anthropic: "Your request was flagged" or "output blocked by content filtering"
    if (msg.includes('content filtering') || msg.includes('request was flagged')) return true;
    // Google: "SAFETY" block reason or "blocked due to safety"
    if (
      msg.includes('blocked due to safety') ||
      msg.includes('safety block') ||
      msg.includes('safety filter')
    )
      return true;

    const data = getErrorData(error);
    const errorType = (data?.error as Record<string, unknown> | undefined)?.type;
    if (typeof errorType === 'string' && errorType.includes('content_policy')) return true;

    const status = getErrorStatus(error);
    if (status === 400) {
      // Anthropic returns 400 with specific error type for content moderation
      if (typeof errorType === 'string' && errorType === 'invalid_request_error') {
        if (msg.includes('output blocked') || msg.includes('content moderation')) return true;
      }
    }
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function describeModel(model: LanguageModel): { providerName: string; modelId: string } {
  if (typeof model === 'string') {
    const [providerName, ...modelParts] = model.split(':');
    return {
      providerName: providerName || 'unknown',
      modelId: modelParts.join(':') || model,
    };
  }

  const modelRecord = model as Record<string, unknown>;
  const provider = modelRecord.provider;
  const modelId = modelRecord.modelId;

  return {
    providerName: typeof provider === 'string' ? provider : String(provider ?? 'unknown'),
    modelId: typeof modelId === 'string' ? modelId : String(modelId ?? 'unknown'),
  };
}

function describeUsage(usage: unknown): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  if (typeof usage !== 'object' || usage === null) {
    return { inputTokens: null, outputTokens: null };
  }

  const usageRecord = usage as Record<string, unknown>;
  const inputTokens =
    typeof usageRecord.inputTokens === 'number'
      ? usageRecord.inputTokens
      : typeof usageRecord.promptTokens === 'number'
        ? usageRecord.promptTokens
        : null;
  const outputTokens =
    typeof usageRecord.outputTokens === 'number'
      ? usageRecord.outputTokens
      : typeof usageRecord.completionTokens === 'number'
        ? usageRecord.completionTokens
        : null;

  return { inputTokens, outputTokens };
}

export async function callLlm<T extends z.ZodType>(
  options: CallLlmOptions<T>,
): Promise<z.infer<T>> {
  const {
    model,
    step,
    schema,
    system,
    prompt,
    promptHash,
    sourceId,
    llmCallRepo,
    logPayloads,
    timeout,
    logger,
    signal: callerSignal,
  } = options;

  const logError = logger
    ? (msg: string, err: unknown) => logger.error(msg, err)
    : (msg: string, err: unknown) => console.error(msg, err);

  const { providerName, modelId } = describeModel(model);
  const schemaJson = logPayloads ? JSON.stringify(toJSONSchema(schema)) : null;

  // AI SDK 6.x no longer injects "JSON schema: …" into the system prompt.
  // OpenAI-compatible providers (e.g. DeepSeek) require the word "json" in the
  // prompt when response_format is json_object. Append a brief instruction so
  // every step satisfies this requirement without modifying individual prompts.
  const systemWithJsonHint = `${system}\n\nRespond in JSON.`;
  const requestBodyForLog = logPayloads
    ? JSON.stringify({ system: systemWithJsonHint, prompt })
    : null;

  let lastError: unknown;
  /** Counts each `generateText` invocation within this `callLlm` (for stable attempt labels in logs). */
  let invokeNumber = 0;

  // Two independent retry budgets (neither consumes the other):
  // - transientAttempts: 429/5xx provider errors → exponential backoff
  // - schemaRetries: null output / NoObjectGeneratedError → immediate retry
  let transientAttempts = 0;
  let schemaRetries = 0;

  // Each generateText() call gets the full configured timeout independently.
  const perCallTimeoutMs = timeout * 1000;

  const recordCall = (params: {
    outcome: 'success' | 'failed';
    failureKind: LlmFailureKind | null;
    failureMessage: string | null;
    responseText?: string | null;
    usage: { inputTokens: number | null; outputTokens: number | null };
  }) => {
    try {
      llmCallRepo.create({
        step,
        provider: providerName,
        model: modelId,
        inputTokens: params.usage.inputTokens,
        outputTokens: params.usage.outputTokens,
        requestBody: requestBodyForLog,
        responseBody: logPayloads ? (params.responseText ?? null) : null,
        requestSchema: schemaJson,
        promptHash,
        sourceId,
        outcome: params.outcome,
        failureKind: params.failureKind,
        failureMessage:
          params.failureMessage !== null ? truncate(params.failureMessage, MAX_FAILURE_MSG) : null,
        attemptNumber: invokeNumber,
      });
    } catch (logErr) {
      logError('Failed to log LLM call:', logErr);
    }
  };

  while (transientAttempts <= MAX_TRANSIENT_RETRIES) {
    if (callerSignal?.aborted) {
      throw new PipelineError(
        t('llm.timeout', { step, timeoutSeconds: timeout, message: 'Cancelled by caller' }),
        step,
        'timeout',
      );
    }

    if (invokeNumber >= MAX_TOTAL_INVOCATIONS) {
      break;
    }

    try {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), perCallTimeoutMs);
      const effectiveSignal = callerSignal
        ? AbortSignal.any([callerSignal, abortController.signal])
        : abortController.signal;

      try {
        invokeNumber++;
        const result = await generateText({
          model,
          system: systemWithJsonHint,
          prompt,
          output: Output.object({ schema }),
          maxRetries: 0,
          abortSignal: effectiveSignal,
        });
        const usage = describeUsage(result.usage);

        if (result.output === null || result.output === undefined) {
          const rawHint = `output is null. Raw text: ${result.text?.slice(0, 500) ?? ''}`;
          recordCall({
            outcome: 'failed',
            failureKind: 'schema_validation',
            failureMessage: rawHint,
            responseText: result.text,
            usage,
          });

          if (schemaRetries < MAX_SCHEMA_RETRIES) {
            schemaRetries++;
            lastError = new PipelineError(
              t('llm.schema_validation', {
                step,
                message: rawHint,
              }),
              step,
              'schema_validation',
            );
            continue;
          }
          throw new PipelineError(
            t('llm.schema_validation', {
              step,
              message: `output is null after ${schemaRetries + 1} attempts. Raw text: ${result.text?.slice(0, 500)}`,
            }),
            step,
            'schema_validation',
          );
        }

        recordCall({
          outcome: 'success',
          failureKind: null,
          failureMessage: null,
          responseText: result.text,
          usage,
        });

        return result.output as z.infer<T>;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      if (error instanceof PipelineError) {
        throw error;
      }
      const usage = describeUsage(
        typeof error === 'object' && error !== null
          ? (error as Record<string, unknown>).usage
          : undefined,
      );

      if (NoObjectGeneratedError.isInstance(error)) {
        recordCall({
          outcome: 'failed',
          failureKind: 'schema_validation',
          failureMessage: error.message,
          responseText: error.text,
          usage,
        });
        if (schemaRetries < MAX_SCHEMA_RETRIES) {
          schemaRetries++;
          lastError = new PipelineError(
            t('llm.schema_validation', { step, message: error.message }),
            step,
            'schema_validation',
            error,
          );
          continue;
        }
        throw new PipelineError(
          t('llm.schema_validation', {
            step,
            message: `${error.message} (after ${schemaRetries + 1} attempts)`,
          }),
          step,
          'schema_validation',
          error,
        );
      }

      if (isContentPolicyError(error)) {
        recordCall({
          outcome: 'failed',
          failureKind: 'content_policy',
          failureMessage: (error as Error).message,
          usage,
        });
        throw new PipelineError(
          t('llm.content_policy', { step, message: (error as Error).message }),
          step,
          'content_policy',
          error,
        );
      }

      const isTransient = isRateLimitError(error) || isServerError(error);
      if (isTransient && transientAttempts < MAX_TRANSIENT_RETRIES) {
        const failureKind: LlmFailureKind = isRateLimitError(error) ? 'rate_limit' : 'unknown';
        recordCall({
          outcome: 'failed',
          failureKind,
          failureMessage: (error as Error).message,
          usage,
        });
        lastError = error;
        const backoffMs = BACKOFF_BASE_MS * 2 ** transientAttempts;
        transientAttempts++;
        try {
          await sleep(backoffMs, callerSignal);
        } catch {
          if (callerSignal?.aborted) {
            const abortError = new Error(
              `Cancelled by caller during backoff: ${callerSignal.reason ?? 'signal aborted'}`,
              { cause: lastError },
            );
            abortError.name = 'AbortError';
            lastError = abortError;
          }
          break;
        }
        continue;
      }

      // Log per-attempt record for non-retryable or budget-exhausted errors
      // (transient retries within budget are already logged above)
      recordCall({
        outcome: 'failed',
        failureKind: isRateLimitError(error) ? 'rate_limit' : 'unknown',
        failureMessage: errorMessage(error),
        usage,
      });
      lastError = error;
      break;
    }
  }

  const lastErrorMsg = errorMessage(lastError);
  const errorCode =
    typeof lastError === 'object' && lastError !== null
      ? (lastError as Record<string, unknown>).code
      : undefined;
  const isCancelled = callerSignal?.aborted === true;
  const isTimeout =
    !isCancelled &&
    lastError instanceof Error &&
    (lastError.name === 'AbortError' ||
      lastError.name === 'TimeoutError' ||
      errorCode === 'ABORT_ERR');
  const isRateLimit = isRateLimitError(lastError);

  throw new PipelineError(
    isCancelled
      ? t('llm.timeout', { step, timeoutSeconds: timeout, message: 'Cancelled by caller' })
      : isRateLimit
        ? t('llm.rate_limit', { step, retries: MAX_TRANSIENT_RETRIES, message: lastErrorMsg })
        : isTimeout
          ? t('llm.timeout', { step, timeoutSeconds: timeout, message: lastErrorMsg })
          : t('llm.generic_failure', { step, message: lastErrorMsg }),
    step,
    isRateLimit ? 'rate_limit' : isCancelled || isTimeout ? 'timeout' : 'unknown',
    lastError,
  );
}
