'use client';

import type { CommitEnvResult } from '@goldpan/web-sdk';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { rethrowNextErrors } from '@/lib/rethrow';
import { sanitizeErrorMessage } from '@/lib/sanitize-error';
import { FieldStatus, type FieldStatusState } from './field-status';

/**
 * Caller-supplied commit function. Wraps the commitEnv server action plus
 * any shell-level housekeeping (firstSave modal trigger, pendingRestart
 * merge, env-state update). Returns the raw CommitEnvResult so the hook
 * can route on `kind: 'ok' | 'errors'` + read `pendingRestartKeys`.
 *
 * Hooks NEVER call commitEnv directly — the indirection lets SettingsShell
 * keep one global commit pipeline shared with the legacy SaveBar path.
 */
export type CommitFn = (patch: Record<string, string | null>) => Promise<CommitEnvResult>;

export const SAVED_TIMEOUT_MS = 2500;

/**
 * Pick the most relevant error message for a field. Prefer one matching the
 * field's envKey; fall back to a path-less (general) error. When neither
 * matches (server returned errors for OTHER keys only) we return `null` —
 * displaying another key's error in this field's FieldStatus row would
 * mislead about which input was rejected, AND surfacing the literal
 * sentinel `'unknown'` (the prior placeholder) bled an untranslated
 * English token into both zh and en UIs. The shell-level toast (which
 * sees the whole commit result) is the right surface for cross-field
 * errors; FieldStatus renders the i18n key `error_no_detail` ("Save
 * failed — see the notice above") when error is null so the user knows
 * something went wrong AND where to look.
 *
 * Zod parse failures in `validate-staged.ts` emit issues with
 * `path = ['GOLDPAN_X']` (or nested `['GOLDPAN_X', 'sub']`) joined by `.`,
 * so `path === envKey` is the only safe identity check.
 */
function pickErrorForField(
  errors: ReadonlyArray<{ path: string; message: string }>,
  envKey: string,
): string | null {
  const own = errors.find((e) => e.path === envKey);
  if (own) return own.message;
  const general = errors.find((e) => e.path === '');
  if (general) return general.message;
  return null;
}

/**
 * Discriminated commit outcome. Exposed to callers (e.g. account.tsx's
 * password edit flow) so they can branch on the semantically distinct
 * outcomes without re-reading the hook's state field after the await (which
 * is racy: a sibling fire/save could have transitioned state by then).
 *
 * All variants share the `kind` discriminant so a single exhaustive switch
 * covers every branch — including the "ignore this resolve" cases
 * (`superseded`) that earlier returned `null` outside the discriminant and
 * forced every caller into truthy short-circuits.
 */
export type CommitOutcome =
  | { kind: 'saved' }
  | { kind: 'pending-restart' }
  | { kind: 'error'; message: string }
  /** No-op: caller invoked save() but draft was clean (no `dirty` flag and
   * no `overrideValue`), so the hook short-circuited without round-tripping
   * the server. Distinct from `'saved'` so callers don't conflate "I
   * persisted something" with "there was nothing to persist". Only
   * `useEditableCommit.save` can produce this — `useToggleCommit.fire`
   * always fires (no draft notion), so its return type narrows this out. */
  | { kind: 'no-op' }
  /** Attempt superseded — either a newer fire/save bumped `inflightIdRef`,
   * or the component unmounted mid-commit. The hook deliberately drops the
   * resolve on the floor (no setState); callers should treat this as
   * "ignore, the user's later action is in flight" and leave their UI
   * alone. Replaces the previous `null` sentinel so callers can express
   * the contract via exhaustive switch instead of `outcome && outcome.kind`. */
  | { kind: 'superseded' };

/** Toggle fire outcomes are a strict subset of {@link CommitOutcome}: a
 * toggle always commits a discrete value, so the "draft is clean" no-op
 * path never applies. Narrowing here lets toggle callers write a switch
 * without a dead `no-op` branch. */
export type ToggleOutcome = Exclude<CommitOutcome, { kind: 'no-op' }>;

/**
 * Hook for "instant-commit" field kinds (toggle / segmented / enum).
 *
 * Holds an OPTIMISTIC value (`current`) so the UI control updates the moment
 * the user clicks — toggle visually jumps to new position immediately. If the
 * commit fails, `current` rolls back to `committed`. Without this, a
 * controlled Toggle bound to env state would only update after commit +
 * setStore + re-render (100-300ms delay feels broken).
 *
 * Usage:
 *   const ssrf = useToggleCommit({
 *     envKey: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
 *     committed: ssrfRaw,            // 'true' or 'false' from env
 *     commit,
 *     fieldName,
 *   });
 *   <Toggle on={ssrf.current === 'true'} onChange={(v) => ssrf.fire(v ? 'true' : 'false')} />
 *   <SettingsField ... status={ssrf.status} />
 *
 * State machine:
 *   pristine →(fire(v))→ saving (current = v, optimistic)
 *   saving →(ok, no restart)→ saved → (2.5s)→ pristine
 *   saving →(ok, restart-required)→ pending-restart (sticky until reload)
 *   saving →(errors)→ error (sticky until next fire, current rolled back)
 */
export function useToggleCommit({
  envKey,
  committed,
  commit,
  fieldName,
  baselineDiffers,
}: {
  envKey: string;
  /** Authoritative server value. UI uses `current` (optimistic) for
   * rendering, but `committed` is what we roll back to on failure. */
  committed: string;
  commit: CommitFn;
  /** Human field label for ARIA. */
  fieldName?: string;
  baselineDiffers?: boolean;
}): {
  state: FieldStatusState;
  error: string | null;
  status: ReactNode;
  /** Optimistic value — caller binds this to the control (Toggle.on etc.). */
  current: string;
  /**
   * Submit `newValue`. Resolves with `{kind:'saved'}` for clean success,
   * `{kind:'pending-restart'}` if the server queued a restart,
   * `{kind:'error', message}` on rollback, or `{kind:'superseded'}` when a
   * newer fire / unmount made this attempt obsolete (callers should ignore
   * superseded — the hook itself dropped the resolve on the floor).
   */
  fire: (newValue: string) => Promise<ToggleOutcome>;
  /** Reset the state machine to pristine — used when an external action
   * (e.g. a sibling Reset button that bypasses this hook) has changed the
   * field. Cancels in-flight commits' late resolves via inflightIdRef bump. */
  clear: () => void;
  /** Switch FieldStatus into the 'error' state with an external message.
   * Used when an action OUTSIDE this hook fails (e.g. the parent's Reset
   * button — see account.tsx) and the UI would otherwise still show this
   * hook's last successful state ("Saved · restart"), creating a false
   * positive after a toast-only failure signal flashes by. */
  markError: (message: string) => void;
} {
  const [state, setState] = useState<FieldStatusState>('pristine');
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string>(committed);
  // Monotonic counter for FieldStatus key — each fire bumps this so the
  // saved-state CSS animation replays on every save attempt (CSS animation
  // doesn't auto-restart when data-state="saved" reappears on the same node).
  const [attemptId, setAttemptId] = useState<number>(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the latest fire's id so out-of-order resolutions don't stomp each
  // other. Fire #1 (slow) resolving after Fire #2 (fast) must NOT mutate
  // state — the user's last action is what should be visible.
  const inflightIdRef = useRef<number>(0);
  // Mirror of `committed` so in-flight fire's rollback reads the freshest
  // authoritative value instead of the closure-captured snapshot.
  const committedRef = useRef<string>(committed);
  // Mount flag — guards post-await setState after the component unmounts
  // (e.g. user navigates away mid-commit).
  const isMountedRef = useRef<boolean>(true);

  // Sync optimistic value AND ref when authoritative `committed` shifts.
  // The ref lets in-flight fire's rollback read the freshest value
  // (closure capture would otherwise snap to a stale committed).
  useEffect(() => {
    committedRef.current = committed;
    setCurrent(committed);
  }, [committed]);

  // Clear any scheduled "saved → pristine" timeout on unmount so we don't
  // setState after the field is gone (React warns, harness flags it as a
  // bug). Also flip the mount flag so post-await setState in fire bails.
  //
  // Setup explicitly re-sets isMountedRef = true so dev StrictMode's
  // setup → cleanup → setup cycle doesn't leave the ref stuck at false
  // (cleanup runs, sets false; second setup must restore true or every
  // subsequent fire bails on the post-await guard and the UI stalls).
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const fire = useCallback(
    async (newValue: string): Promise<ToggleOutcome> => {
      // Cancel any in-flight "saved" fade-out — a fresh edit supersedes.
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      // Optimistic update — UI control jumps to new position immediately.
      setCurrent(newValue);
      setState('saving');
      setError(null);
      const myAttempt = inflightIdRef.current + 1;
      inflightIdRef.current = myAttempt;
      setAttemptId(myAttempt);
      try {
        const result = await commit({ [envKey]: newValue });
        // Bail if unmounted or a newer fire superseded us.
        if (!isMountedRef.current || inflightIdRef.current !== myAttempt) {
          return { kind: 'superseded' };
        }
        if (result.kind !== 'ok') {
          // Roll back optimistic value — server rejected the change. Read
          // committedRef so we roll back to the freshest authoritative
          // value, not the closure-captured one.
          setCurrent(committedRef.current);
          // pickErrorForField returns null for cross-field-only errors;
          // we propagate that through setError so FieldStatus can render
          // 'error_no_detail' instead of the empty-interpolated 'error'.
          // CommitOutcome.message stays string for caller ergonomics —
          // we surface '' for the null case, since most callers only
          // care that the kind is 'error', not the message detail.
          const message = pickErrorForField(result.errors, envKey);
          setError(message);
          setState('error');
          return { kind: 'error', message: message ?? '' };
        }
        if (result.pendingRestartKeys.includes(envKey)) {
          setState('pending-restart');
          return { kind: 'pending-restart' };
        }
        setState('saved');
        timeoutRef.current = setTimeout(() => {
          // Only revert to pristine if no newer fire is in flight and we're
          // still mounted — otherwise we'd clobber a fresh saving/error.
          if (inflightIdRef.current === myAttempt && isMountedRef.current) {
            setState('pristine');
          }
          timeoutRef.current = null;
        }, SAVED_TIMEOUT_MS);
        return { kind: 'saved' };
      } catch (e) {
        // Let Next framework errors (NEXT_REDIRECT etc.) propagate so 401
        // → /login navigation isn't swallowed into FieldStatus error text.
        rethrowNextErrors(e);
        // Network / unexpected — also roll back. Same bail guard as ok-branch.
        if (!isMountedRef.current || inflightIdRef.current !== myAttempt) {
          return { kind: 'superseded' };
        }
        setCurrent(committedRef.current);
        // Sanitize before rendering inline: client-side fetch errors like
        // "fetch failed at http://internal.lan:8443/..." would otherwise
        // surface the internal hostname in the FieldStatus row (which is
        // pasteable into bug reports just like the shell toast). Same
        // helper as settings-shell.tsx — toast + inline kept consistent.
        const message = sanitizeErrorMessage(e);
        setError(message);
        setState('error');
        return { kind: 'error', message };
      }
    },
    [envKey, commit],
  );

  const clear = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    // Bump so any in-flight fire's late resolve is treated as stale.
    inflightIdRef.current += 1;
    // Snap optimistic value back to authoritative committed in the SAME
    // batch as the state-machine reset — React 18 automatic batching folds
    // these setStates into a single render, so the UI never paints an
    // intermediate "ON state-pristine" frame between clear() and the
    // useEffect-on-[committed] sync that follows the parent's setStore.
    // Mirrors useEditableCommit.clear's setDraft(committedRef.current).
    setCurrent(committedRef.current);
    setError(null);
    setState('pristine');
  }, []);

  const markError = useCallback((message: string) => {
    // External-error injection: parent action (e.g. resetEnvKey) failed and
    // we want FieldStatus to reflect that the OPTIMISTIC last-successful
    // state ('saved' / 'pending-restart') is now misleading. Bump the
    // attempt counter so the FieldStatus key changes and the CSS animation
    // re-plays even if `state` was already 'error'.
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    // Bump inflight so any late commit resolve doesn't stomp this externally
    // injected error.
    inflightIdRef.current += 1;
    setAttemptId((id) => id + 1);
    setError(message);
    setState('error');
  }, []);

  return {
    state,
    error,
    status: (
      <FieldStatus
        key={attemptId}
        state={state}
        error={error}
        fieldName={fieldName}
        baselineDiffers={baselineDiffers}
      />
    ),
    current,
    fire,
    clear,
    markError,
  };
}

/**
 * Hook for "editable" field kinds (text / number / secret). Holds a draft
 * value separate from the committed value so the user can edit, see [Save]/
 * [Cancel] buttons appear, then either submit or revert.
 *
 * Usage (text field):
 *   const baseUrl = useEditableCommit({
 *     envKey: 'OLLAMA_BASE_URL',
 *     committed: env.get('OLLAMA_BASE_URL')?.mask ?? '',
 *     commit,
 *   });
 *   <input value={baseUrl.draft} onChange={(e) => baseUrl.setDraft(e.target.value)} />
 *   {baseUrl.dirty ? <><Btn onClick={baseUrl.cancel}>Cancel</Btn><Btn onClick={baseUrl.save}>Save</Btn></> : null}
 *   <SettingsField ... status={baseUrl.status} />
 *
 * State machine:
 *   pristine ←(draft === committed)
 *   dirty   ←(draft !== committed)
 *   saving  ←(save() in flight)
 *   saved / pending-restart / error  (same as useToggleCommit)
 *   pristine on `cancel()` → draft reverts to committed
 *
 * `committed` is the authoritative server value. When commit succeeds,
 * parent re-fetches and the new `committed` flows back in — useEffect
 * resets draft AND committedRef so subsequent renders reflect the new baseline.
 *
 * Defensive refs (same pattern as useToggleCommit):
 * - inflightIdRef: out-of-order resolution can't stomp newer state
 * - committedRef: rollback reads freshest committed even if it changed mid-save
 * - isMountedRef: post-unmount setState is suppressed
 */
export function useEditableCommit({
  envKey,
  committed,
  commit,
  fieldName,
  baselineDiffers,
  serialize,
  onEditingChange,
}: {
  envKey: string;
  committed: string;
  commit: CommitFn;
  fieldName?: string;
  baselineDiffers?: boolean;
  /** Optional serializer — e.g. coerce empty string → null for "reset to
   * baseline" semantics on text/number fields. Default: identity. */
  serialize?: (draft: string) => string | null;
  /** Optional notification for hosts with a page-level leave guard. Fires
   * when the editable draft becomes dirty/clean, plus false on unmount. */
  onEditingChange?: (editing: boolean) => void;
}): {
  state: FieldStatusState;
  error: string | null;
  status: ReactNode;
  draft: string;
  setDraft: (v: string) => void;
  dirty: boolean;
  /**
   * Submit. Pass `overrideValue` to commit a specific value without going
   * through React state (avoids the "I just called setDraft, save reads
   * stale closure" footgun for callers that hold the canonical value in
   * their own state — e.g. account.tsx's `pwd` + confirm flow).
   *
   * Resolves with the discriminated outcome (see {@link CommitOutcome}):
   * `saved` / `pending-restart` / `error` / `no-op` (clean draft, no
   * override) / `superseded` (newer attempt / unmount, ignore).
   */
  save: (overrideValue?: string) => Promise<CommitOutcome>;
  cancel: () => void;
  /** Same semantics as useToggleCommit.clear — full reset to pristine for
   * external-action paths (Reset button, refresh, etc.). */
  clear: () => void;
  /** External-error injection — see {@link useToggleCommit}'s markError
   * for the user-experience rationale. */
  markError: (message: string) => void;
} {
  const [draft, setDraft] = useState<string>(committed);
  const [state, setState] = useState<FieldStatusState>('pristine');
  const [error, setError] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<number>(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightIdRef = useRef<number>(0);
  const committedRef = useRef<string>(committed);
  const isMountedRef = useRef<boolean>(true);
  const onEditingChangeRef = useRef(onEditingChange);
  onEditingChangeRef.current = onEditingChange;

  // Resync draft to new `committed` ONLY when the user hasn't started
  // editing (draft still equals the previous committed). When draft has
  // diverged, the user is mid-edit — overwriting it would silently destroy
  // their input. The committedRef still updates so cancel() reverts to the
  // new baseline if they choose to abandon.
  useEffect(() => {
    const prevCommitted = committedRef.current;
    committedRef.current = committed;
    if (draft === prevCommitted) {
      setDraft(committed);
    }
    // else: keep user draft. They can save() against the new baseline or
    // cancel() to discard their edit and snap to the new committed value.
  }, [committed, draft]);

  // Same StrictMode-safe pattern as useToggleCommit — see comment there.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const dirty = draft !== committed;

  useEffect(() => {
    onEditingChangeRef.current?.(dirty);
    return () => onEditingChangeRef.current?.(false);
  }, [dirty]);

  const save = useCallback(
    async (overrideValue?: string): Promise<CommitOutcome> => {
      const valueToCommit = overrideValue !== undefined ? overrideValue : draft;
      // No-op only when caller didn't override AND nothing is dirty —
      // overrideValue !== undefined is an explicit "commit this", trust it.
      if (overrideValue === undefined && !dirty) return { kind: 'no-op' };
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setState('saving');
      setError(null);
      const myAttempt = inflightIdRef.current + 1;
      inflightIdRef.current = myAttempt;
      setAttemptId(myAttempt);
      try {
        const serialized = serialize !== undefined ? serialize(valueToCommit) : valueToCommit;
        const result = await commit({ [envKey]: serialized });
        if (!isMountedRef.current || inflightIdRef.current !== myAttempt) {
          return { kind: 'superseded' };
        }
        if (result.kind !== 'ok') {
          // null → cross-field-only error; FieldStatus picks error_no_detail.
          const message = pickErrorForField(result.errors, envKey);
          setError(message);
          setState('error');
          return { kind: 'error', message: message ?? '' };
        }
        if (result.pendingRestartKeys.includes(envKey)) {
          setState('pending-restart');
          return { kind: 'pending-restart' };
        }
        setState('saved');
        timeoutRef.current = setTimeout(() => {
          if (inflightIdRef.current === myAttempt && isMountedRef.current) {
            setState('pristine');
          }
          timeoutRef.current = null;
        }, SAVED_TIMEOUT_MS);
        return { kind: 'saved' };
      } catch (e) {
        // Same Next framework rethrow as useToggleCommit — keeps redirect
        // signals out of the local error pipeline.
        rethrowNextErrors(e);
        if (!isMountedRef.current || inflightIdRef.current !== myAttempt) {
          return { kind: 'superseded' };
        }
        // Sanitize — see useToggleCommit's catch for rationale.
        const message = sanitizeErrorMessage(e);
        setError(message);
        setState('error');
        return { kind: 'error', message };
      }
    },
    [dirty, draft, envKey, commit, serialize],
  );

  const cancel = useCallback(() => {
    setDraft(committedRef.current);
    setError(null);
    if (state === 'error') {
      setState('pristine');
    }
  }, [state]);

  const clear = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    inflightIdRef.current += 1;
    setDraft(committedRef.current);
    setError(null);
    setState('pristine');
  }, []);

  const markError = useCallback((message: string) => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    inflightIdRef.current += 1;
    setAttemptId((id) => id + 1);
    setError(message);
    setState('error');
  }, []);

  return {
    state,
    error,
    status: (
      <FieldStatus
        key={attemptId}
        state={state}
        error={error}
        fieldName={fieldName}
        baselineDiffers={baselineDiffers}
      />
    ),
    draft,
    setDraft,
    dirty,
    save,
    cancel,
    clear,
    markError,
  };
}
