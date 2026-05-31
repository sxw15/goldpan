'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

/**
 * Model entry — a model id plus its role flag. `embedding=true` 表示这条 model
 * 是 embedding 角色（放进 `_EMBEDDING_MODELS` env），`false` 是 chat / completion
 * 角色（放进 `_MODELS` env）。chat 和 embedding 在真实模型层面集合互斥
 * （`gpt-4o` 没有 embedding endpoint、`text-embedding-3-small` 没有 chat
 * endpoint），所以单选语义足够。
 */
export interface Model {
  id: string;
  embedding: boolean;
}

export interface ModelRowsInputHandle {
  /**
   * Force-commit ALL pending input — any focused-but-unblurred existing-row
   * edit AND the trailing draft — into the row list. Returns the post-commit
   * list synchronously because React 18 batches `setState`, so a parent that
   * calls `flush()` then reads `value` from its own state in the same event
   * handler would still see the pre-flush list.
   */
  flush: () => Model[];
}

interface Props {
  value: Model[];
  onChange: (next: Model[]) => void;
  /** Placeholder shown on the trailing add input. */
  placeholder?: string;
  /** Forwarded as `id` on the trailing add input so a `<label htmlFor>` can target it. */
  inputId?: string;
  /** Aria label for the trailing add input. */
  inputAriaLabel?: string;
  /** Visible label next to the embedding toggle on each row. */
  embeddingLabel: string;
  /** Aria label hook for the embedding toggle (per-row, takes the model id). */
  embeddingAriaLabel: (modelId: string) => string;
  /** Aria label hook for the per-row remove button. */
  removeAriaLabel: (modelId: string) => string;
  /** Disable row editing while a parent save is in flight. */
  disabled?: boolean;
  /**
   * Per-field editing notification: fires `true` while the user has a
   * non-empty draft in the trailing add input, `false` when the draft is
   * empty or the component unmounts. Parents wire this to the shell's
   * `setFieldEditing` so the leave-guard recognises typed-but-uncommitted
   * model rows as "editing" — without this, a user who types a model id
   * into the add input then clicks the sidebar to switch groups never
   * sees the leave-modal: React 18's setState batching means the
   * sidebar click reads `hasNavBlocker` from the previous render (no
   * in-flight, no editing) BEFORE the input's onBlur-triggered commit
   * fires beginInFlight, so the navigation proceeds and the typed
   * intent is silently committed (or worse, gets blurred away when
   * the panel unmounts).
   */
  onEditingChange?: (editing: boolean) => void;
}

/**
 * Row-style editor for a list of LLM model ids, each with an "embedding"
 * toggle. Replaces the chip-based input because chat 和 embedding 是 model 的
 * 固有角色（不是用户在做"分配"），单 list + 每行 toggle 比"两栏分别填"更紧凑也更
 * 符合现实——同一个 OpenAI account 出 chat 和 embedding，不是两个独立资源池。
 *
 * Trailing draft commit triggers (any of):
 *   - Pressing Enter / Tab while the trailing input is non-empty
 *   - Blurring the trailing input
 *   - Parent calling `ref.current.flush()` (modal save path)
 *
 * 已存在的 row 用 uncontrolled `<input defaultValue>` + onBlur 提交语义：每次
 * 输入不会触发 parent 重渲染（避免 React reconciliation 在键入中途换 key 引起
 * 输入丢焦），blur 时把最终值校验后写回。空字符串 = 删除该行。
 */
export const ModelRowsInput = forwardRef<ModelRowsInputHandle, Props>(function ModelRowsInput(
  {
    value,
    onChange,
    placeholder,
    inputId,
    inputAriaLabel,
    embeddingLabel,
    embeddingAriaLabel,
    removeAriaLabel,
    disabled = false,
    onEditingChange,
  },
  ref,
) {
  const [draft, setDraft] = useState('');
  const addInputRef = useRef<HTMLInputElement>(null);
  // Live refs to each existing-row <input>, keyed by its committed id. Those
  // inputs are uncontrolled (defaultValue + onBlur commit), so a focused edit
  // the user hasn't blurred yet lives only in the DOM. flush() reads it from
  // here — see flushPendingInput.
  const rowInputRefs = useRef(new Map<string, HTMLInputElement>());
  // Mirror onEditingChange via a ref so [draft] stays the only effect
  // dep — parents pass inline arrow callbacks whose identity churns every
  // render, and putting them in the dep array would re-fire on every
  // parent re-render even when draft hasn't changed.
  const onEditingChangeRef = useRef(onEditingChange);
  onEditingChangeRef.current = onEditingChange;
  useEffect(() => {
    onEditingChangeRef.current?.(draft.length > 0);
    // Unmount cleanup: fire `false` so the shell's editingFields releases
    // its entry. Without this, navigating away mid-draft would leave a
    // stuck "editing" record that prompts the leave-guard on every
    // subsequent group switch.
    return () => onEditingChangeRef.current?.(false);
  }, [draft]);

  function commitDraft(): Model[] {
    if (disabled) return value;
    const t = draft.trim();
    if (t.length === 0) {
      if (draft.length > 0) setDraft('');
      return value;
    }
    if (value.some((m) => m.id === t)) {
      setDraft('');
      return value;
    }
    const next = [...value, { id: t, embedding: false }];
    onChange(next);
    setDraft('');
    return next;
  }

  /**
   * Commit ALL pending input into one final list and return it synchronously.
   * The parent's save handler calls this. Footer buttons preventDefault their
   * mousedown (see Modal) so the focused field never blurs on a save click —
   * meaning neither commitRowEdit nor commitDraft fires on its own. flush is the
   * single path that captures everything: focused-but-unblurred existing-row
   * edits (read from the live DOM via rowInputRefs) plus the trailing draft.
   * Without folding in the row edits, a user who renamed a row then clicked Save
   * directly would silently save the OLD id.
   */
  function flushPendingInput(): Model[] {
    if (disabled) return value;
    const result: Model[] = [];
    const seen = new Set<string>();
    // Existing rows — mirror commitRowEdit's blur semantics off the live DOM
    // value: empty = delete the row, duplicate = collapse, else keep / rename.
    for (const m of value) {
      const id = (rowInputRefs.current.get(m.id)?.value ?? m.id).trim();
      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      result.push(id === m.id ? m : { ...m, id });
    }
    // Trailing draft (commitDraft's append, deduped against the rebuilt rows).
    const t = draft.trim();
    if (t.length > 0 && !seen.has(t)) result.push({ id: t, embedding: false });
    const changed =
      result.length !== value.length ||
      result.some((m, i) => m.id !== value[i]?.id || m.embedding !== value[i]?.embedding);
    if (changed) onChange(result);
    if (draft.length > 0) setDraft('');
    return result;
  }

  useImperativeHandle(ref, () => ({ flush: flushPendingInput }));

  function commitRowEdit(originalId: string, rawNext: string): void {
    if (disabled) return;
    const trimmed = rawNext.trim();
    if (trimmed.length === 0) {
      onChange(value.filter((m) => m.id !== originalId));
      return;
    }
    if (trimmed === originalId) return;
    // 同一 id 重复时拒绝（用户编辑成既有 id 会引起两个 row 重叠）—— 静默回退到
    // 原值，下一次 render 用 originalId 作为 React key 强制 input 重挂载，浏览器
    // 会显示 defaultValue=originalId（即旧 id），用户能看到回退。
    if (value.some((m) => m.id === trimmed)) {
      onChange([...value]); // identity change → forces remount with originalId
      return;
    }
    onChange(value.map((m) => (m.id === originalId ? { ...m, id: trimmed } : m)));
  }

  function toggleEmbedding(rowId: string, on: boolean): void {
    if (disabled) return;
    onChange(value.map((m) => (m.id === rowId ? { ...m, embedding: on } : m)));
  }

  function removeRow(rowId: string): void {
    if (disabled) return;
    onChange(value.filter((m) => m.id !== rowId));
  }

  function handleAddKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (e.key === 'Enter') e.preventDefault();
      commitDraft();
    }
  }

  return (
    <div className="gp-model-rows">
      {value.map((m) => (
        <div className="gp-model-row" key={m.id}>
          <input
            ref={(el) => {
              const refs = rowInputRefs.current;
              if (el) refs.set(m.id, el);
              else refs.delete(m.id);
            }}
            type="text"
            className="gp-sinput gp-sinput--mono gp-model-row__id"
            defaultValue={m.id}
            disabled={disabled}
            onBlur={(e) => commitRowEdit(m.id, e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label={m.id}
          />
          {/* Inline button (not <Toggle>) so biome's noLabelWithoutControl can
              see the form control as a direct descendant of <label>; component
              wrapping hides it from the rule's static analysis (same trick
              as ToggleRow in digest.tsx). */}
          <label className="gp-model-row__embed">
            <button
              type="button"
              className="gp-toggle"
              data-on={m.embedding ? '1' : '0'}
              aria-pressed={m.embedding}
              aria-label={embeddingAriaLabel(m.id)}
              disabled={disabled}
              onClick={() => toggleEmbedding(m.id, !m.embedding)}
            >
              <i />
            </button>
            <span className="gp-model-row__embed-label">{embeddingLabel}</span>
          </label>
          <button
            type="button"
            className="gp-model-row__remove"
            disabled={disabled}
            onClick={() => removeRow(m.id)}
            aria-label={removeAriaLabel(m.id)}
          >
            ×
          </button>
        </div>
      ))}
      <div className="gp-model-rows__add">
        <span className="gp-model-rows__add-icon" aria-hidden="true">
          +
        </span>
        <input
          ref={addInputRef}
          id={inputId}
          type="text"
          className="gp-model-rows__input"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleAddKeyDown}
          onBlur={() => {
            commitDraft();
          }}
          placeholder={placeholder}
          aria-label={inputAriaLabel}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    </div>
  );
});
