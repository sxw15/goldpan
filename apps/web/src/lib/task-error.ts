import { TASK_ERROR_KINDS, type TaskErrorKind } from '@goldpan/web-sdk';

/**
 * Shared vocabulary for task processing errors.
 *
 * The server returns a stable `error.kind` plus a raw English `error.message`
 * (apps/server/src/routes/tasks.ts `ERROR_KIND_MESSAGE`). Surfacing that raw
 * message directly makes the UI flip to English the moment a poll response
 * arrives, even after SSR rendered a localized string. Every surface that shows
 * a task error (task detail page, task-detail-client poll path, chat bubbles)
 * must localize from `kind` via {@link localizeErrorKind} instead — one source
 * of truth, always locale-correct.
 */

/** Re-exported from web-sdk's `TASK_ERROR_KINDS` — the canonical mirror of
 * core's `PIPELINE_ERROR_KINDS`, kept array-identical to core by
 * `web-sdk/tests/task-error-kinds-sync.test.ts`. The web has no independent
 * copy of this list anymore; unrecognized kinds still localize as `unknown`
 * (forward-compatible). Separately, `task-error.test.ts` asserts every kind
 * here has an `error_kind_*` i18n message. */
export const KNOWN_ERROR_KINDS = TASK_ERROR_KINDS;
export type KnownErrorKind = TaskErrorKind;

export function normalizeErrorKind(kind: string | null | undefined): KnownErrorKind {
  return kind && (KNOWN_ERROR_KINDS as readonly string[]).includes(kind)
    ? (kind as KnownErrorKind)
    : 'unknown';
}

/**
 * Localize a task error kind. `t` must be scoped to the `task_detail` namespace
 * (which owns the `error_kind_*` keys) — both `useTranslations('task_detail')`
 * (client) and `getTranslations('task_detail')` (server) satisfy this.
 */
export function localizeErrorKind(
  kind: string | null | undefined,
  t: (key: string) => string,
): string {
  return t(`error_kind_${normalizeErrorKind(kind)}`);
}
