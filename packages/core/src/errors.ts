import type { LlmStep, PipelineStep } from './db/repositories/types';

/**
 * Canonical task/pipeline error kinds. Runtime array (not just a union) so
 * downstream mirrors can be sync-tested against it — `packages/web-sdk`
 * re-declares `TASK_ERROR_KINDS` and `web-sdk/tests/task-error-kinds-sync.test.ts`
 * asserts parity, the same guard pattern used for `MANAGED_ENV_KEYS`. Adding a
 * kind here forces, at build time: (1) the server `ERROR_KIND_MESSAGE` map
 * (`Record<TaskErrorKind, …>` → compile error); (2) the web-sdk mirror
 * (`task-error-kinds-sync.test.ts` → red CI); (3) the web `error_kind_*` i18n
 * keys (`apps/web/src/lib/task-error.test.ts` → red CI). Three distinct guards.
 */
export const PIPELINE_ERROR_KINDS = [
  'schema_validation',
  'content_policy',
  'content_length',
  'rate_limit',
  'timeout',
  'not_found',
  'unknown',
] as const;

export type PipelineErrorKind = (typeof PIPELINE_ERROR_KINDS)[number];

export class PipelineError extends Error {
  /**
   * The step where the error occurred.
   * - PipelineStep (gerund form): used when thrown from pipeline orchestration
   * - LlmStep (noun form): used when thrown from LLM call wrapper
   * Pipeline phase (Phase 3) maps LlmStep → PipelineStep when forwarding to task error handling.
   */
  public readonly step: PipelineStep | LlmStep | null;
  public readonly kind: PipelineErrorKind;

  constructor(
    message: string,
    step: PipelineStep | LlmStep | null,
    kind: PipelineErrorKind,
    cause?: unknown,
  ) {
    super(message, cause != null ? { cause } : undefined);
    this.name = 'PipelineError';
    this.step = step;
    this.kind = kind;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
