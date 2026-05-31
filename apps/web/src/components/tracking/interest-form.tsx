'use client';

import type { CreateInterestInput, Interest, UpdateInterestInput } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { type FormEvent, type KeyboardEvent, useEffect, useId, useState } from 'react';

/**
 * InterestForm: create / edit an Interest (tracking rule).
 *
 * Discriminated union per mode:
 * - `new`: `onSubmit(CreateInterestInput) => Promise<void>` — used by
 *   InterestsSection inline "新建追踪项" flow.
 * - `edit`: `onSubmit(UpdateInterestInput) => Promise<void>` + `initial: Interest`
 *   — mounted inside InterestPayload's edit mode.
 *
 * Validation lives entirely in handleSubmit:
 *   - empty name → setFormError + block
 *   - empty searchQueries → setFormError + block
 *   - `intervalMinutes` min is server-authoritative (env
 *     `GOLDPAN_TRACKING_MIN_RULE_INTERVAL_MINUTES`) → we only set `min={1}` on
 *     the input to block negatives, and surface the server's validation_error
 *     message verbatim via the catch in handleSubmit.
 *
 * Review round B-Pr-2: `onDirtyChange` bubbles to shell for unsaved-close
 * confirm. `new` mode does not need it (the form isn't inside the Inspector,
 * so ESC/backdrop close doesn't apply) — prop remains optional so both modes
 * share one signature.
 */
export type InterestFormProps =
  | {
      mode: 'new';
      onSubmit: (data: CreateInterestInput) => Promise<void>;
      onCancel: () => void;
      onDirtyChange?: (dirty: boolean) => void;
    }
  | {
      mode: 'edit';
      initial: Interest;
      onSubmit: (data: UpdateInterestInput) => Promise<void>;
      onCancel: () => void;
      onDirtyChange?: (dirty: boolean) => void;
    };

const DEFAULT_INTERVAL_MINUTES = 60;

export function InterestForm(props: InterestFormProps) {
  const t = useTranslations('tracking');

  // useId() avoids DOM id collisions when two InterestForms mount at once
  // (InterestsSection's inline "New interest" + Inspector's edit-mode form).
  // Fixed ids made both <label htmlFor> point at the first matching input.
  const nameId = useId();
  const descId = useId();
  const queriesId = useId();
  const intervalId = useId();

  const [name, setName] = useState(props.mode === 'edit' ? props.initial.name : '');
  const [description, setDescription] = useState(
    props.mode === 'edit' ? (props.initial.description ?? '') : '',
  );
  const [queries, setQueries] = useState<string[]>(
    props.mode === 'edit' ? [...props.initial.searchQueries] : [],
  );
  const [queryInput, setQueryInput] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(
    props.mode === 'edit' ? props.initial.intervalMinutes : DEFAULT_INTERVAL_MINUTES,
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Review round B-Pr-2: edit mode diffs each field vs initial; any diff → dirty=true.
  // `new` mode is not inside Inspector so dirty is not tracked. We still call
  // onDirtyChange(false) in new mode once so shells that pass it don't sit on
  // stale `true` from a prior payload.
  //
  // `queryInput` (pending chip text not yet committed via Enter/comma) counts
  // as dirty too. Without this, typing "foo" into the query input and
  // closing the inspector would bypass the unsaved-edit confirm — the chip
  // had not been pushed to `queries`, so the diff looked clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: props is a union; we only reach props.initial inside the edit branch. Listing the individual deps (name/description/queries/queryInput/intervalMinutes/mode/onDirtyChange) captures every input we actually diff plus the callback we invoke.
  useEffect(() => {
    if (props.mode !== 'edit') {
      props.onDirtyChange?.(false);
      return;
    }
    const initial = props.initial;
    const pendingQueryDirty = queryInput.trim().length > 0;
    const dirty =
      name !== initial.name ||
      description !== (initial.description ?? '') ||
      queries.length !== initial.searchQueries.length ||
      queries.some((q, i) => q !== initial.searchQueries[i]) ||
      intervalMinutes !== initial.intervalMinutes ||
      pendingQueryDirty;
    props.onDirtyChange?.(dirty);
  }, [name, description, queries, queryInput, intervalMinutes, props.mode, props.onDirtyChange]);

  // Functional setter avoids a stale-closure race when multiple chips are
  // pushed in one synchronous batch (e.g. pasting "A,B,C," through
  // `onQueryChange` or inserting 20+ items at once). Without it, each
  // `pushChip` call would read the same initial `queries` and only the last
  // setQueries would win, silently dropping earlier chips.
  function pushChip(raw: string) {
    const v = raw.trim();
    if (!v) return;
    setQueries((prev) => (prev.includes(v) ? prev : [...prev, v]));
  }

  function onQueryKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      pushChip(queryInput);
      setQueryInput('');
    }
  }

  function onQueryChange(value: string) {
    // Comma typed directly into the input (e.g. via paste or autofill) —
    // split eagerly so "AI,LLM," becomes two chips + empty input.
    if (value.includes(',')) {
      const parts = value.split(',');
      const last = parts.pop() ?? '';
      for (const p of parts) pushChip(p);
      setQueryInput(last);
      return;
    }
    setQueryInput(value);
  }

  // Mirrors `TrackingCrudService.validateSearchQueries` + name/description
  // caps. Service is still the authority — these checks exist so users get
  // instant feedback without a round-trip, and so the same rule set appears
  // in both client UI strings and server error messages. If service rules
  // change, update both here and in plugins/tracking/src/service.ts.
  //
  // Validates against an explicit query list so handleSubmit can include a
  // freshly-flushed pending chip without waiting for the next render.
  function validateLocalAgainst(
    trimmedName: string,
    trimmedDescription: string,
    qs: string[],
  ): string | null {
    if (!trimmedName) return t('form_error_name_required');
    if (trimmedName.length > 200) return t('form_error_name_too_long');
    if (trimmedDescription.length > 500) return t('form_error_description_too_long');
    if (qs.length === 0) return t('form_error_queries_required');
    if (qs.length > 20) return t('form_error_queries_too_many');
    for (const q of qs) {
      if (q.length > 100) return t('form_error_query_too_long', { query: q });
    }
    const joinedLength = qs.reduce((acc, q) => acc + q.length, 0) + (qs.length - 1) * 4;
    if (joinedLength > 500) {
      return t('form_error_queries_joined_too_long', { length: joinedLength });
    }
    return null;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    // Flush pending chip text (user typed a query but didn't press Enter /
    // comma before hitting save). Without this, the visible input value
    // would be silently dropped on submit — a confusing data-loss case.
    const pendingQuery = queryInput.trim();
    const effectiveQueries =
      pendingQuery && !queries.includes(pendingQuery) ? [...queries, pendingQuery] : queries;
    if (effectiveQueries !== queries) {
      setQueries(effectiveQueries);
      setQueryInput('');
    }
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const localError = validateLocalAgainst(trimmedName, trimmedDescription, effectiveQueries);
    if (localError) {
      setFormError(localError);
      return;
    }
    setSubmitting(true);
    try {
      if (props.mode === 'new') {
        // Create: omit description when blank (server defaults to null).
        // Server accepts `description?: string` so a missing field is fine.
        await props.onSubmit({
          name: trimmedName,
          ...(trimmedDescription ? { description: trimmedDescription } : {}),
          searchQueries: effectiveQueries,
          intervalMinutes,
        });
      } else {
        // Edit: always include `description`, even when empty. Sending
        // `undefined` would cause JSON.stringify to drop the field, which
        // the server treats as "not provided" → the old description stays.
        // Sending an empty string forces the server-side trim() → null
        // branch and lets users clear a previously-set description.
        await props.onSubmit({
          name: trimmedName,
          description: trimmedDescription,
          searchQueries: effectiveQueries,
          intervalMinutes,
        });
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="gp-interest-form" onSubmit={handleSubmit}>
      <div className="gp-interest-form__row">
        <label htmlFor={nameId}>{t('form_name_label')}</label>
        <input
          id={nameId}
          className="gp-interest-form__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('form_name_placeholder')}
          maxLength={200}
        />
      </div>

      <div className="gp-interest-form__row">
        <label htmlFor={descId}>{t('form_description_label')}</label>
        <textarea
          id={descId}
          className="gp-interest-form__textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
        />
      </div>

      <div className="gp-interest-form__row">
        <label htmlFor={queriesId}>{t('form_queries_label')}</label>
        <div className="gp-interest-form__queries-input">
          {queries.map((q) => (
            <span key={q} className="gp-interest-payload__query-chip">
              {q}
              <button
                type="button"
                className="gp-interest-form__chip-remove"
                aria-label={t('chip_remove_label', { query: q })}
                onClick={() => setQueries(queries.filter((x) => x !== q))}
              >
                ✕
              </button>
            </span>
          ))}
          <input
            id={queriesId}
            className="gp-interest-form__input"
            value={queryInput}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onQueryKeyDown}
          />
        </div>
        <small className="gp-interest-form__hint">{t('form_queries_hint')}</small>
      </div>

      <div className="gp-interest-form__row">
        <label htmlFor={intervalId}>{t('form_interval_label')}</label>
        <input
          id={intervalId}
          type="number"
          className="gp-interest-form__input"
          value={intervalMinutes}
          onChange={(e) => setIntervalMinutes(Number(e.target.value) || DEFAULT_INTERVAL_MINUTES)}
          min={1}
        />
        {/* min interval 由 server env 决定；前端 min={1} 只防负数。违规 → server validation_error → catch → formError */}
      </div>

      {formError && (
        <p role="alert" className="gp-interest-form__error">
          {formError}
        </p>
      )}

      <div className="gp-interest-form__actions">
        <button type="submit" className="gp-interest-form__submit" disabled={submitting}>
          {props.mode === 'new' ? t('form_submit_new') : t('form_submit_edit')}
        </button>
        <button type="button" className="gp-interest-form__cancel" onClick={props.onCancel}>
          {t('form_cancel')}
        </button>
      </div>
    </form>
  );
}
