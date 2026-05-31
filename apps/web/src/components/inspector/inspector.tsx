'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm } from '../confirm-provider';
import { InspectorHeader } from './inspector-header';
import { PayloadRouter } from './payloads';
import type {
  InspectorKind,
  InspectorPayload,
  PayloadAction,
  PayloadCapabilitySet,
} from './payloads/types';
import { useInspectorStack } from './use-inspector-stack';

export interface InspectorProps {
  /** 入口 payload；null/undefined 关闭 */
  payload: InspectorPayload | null;
  /** 关闭回调（✕ / ESC / backdrop 点击） */
  onClose: () => void;
  /** i18n labels (consumer 传翻译值；默认值中文兜底) */
  backFallbackLabel?: string;
  closeLabel?: string;
  /** Map the currently rendered payload kind to an i18n badge label. */
  getKindLabel?: (kind: InspectorKind) => string;
  /**
   * Payload action dispatcher. Payload components dispatch discriminated-union
   * actions (discardSource / updateInterest / deleteInterest / ...) and the
   * shell implements a single `handleAction` switch that routes each case to
   * the appropriate SDK call. Resolving = success; rejecting = failure (the
   * payload surfaces an inline alert per spec §4.2).
   */
  onAction?: (action: PayloadAction) => Promise<void>;
  /**
   * Shell-declared action capability whitelist. Forwarded to PayloadRouter
   * which forwards to each payload. Payloads render CTAs only for actions
   * the shell actually handles — TrackingShell omits `trackFromEntity`, so
   * EntityPayload does not render the "追踪此主题" button there.
   */
  capabilities?: PayloadCapabilitySet;
  /**
   * Inspector owns the unsaved-edits confirm guard centrally: payload
   * components (InterestPayload, NotePayload) report dirty state via the
   * internal `setPayloadDirty` callback handed to PayloadRouter, and Inspector
   * intercepts ALL leave paths (Esc / backdrop / ✕ / Back / linked-entity
   * push). Shells used to plumb this through `useConfirm` themselves, which
   * left `pop` / `push` / chat-inspector unguarded; that duplication is gone.
   *
   * `onDirtyChange` is still exposed for consumers that need to read dirty
   * state externally (e.g. to gate sibling UI), but the confirm prompt is
   * owned here — callers do NOT need to wire `useConfirm` themselves.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export function Inspector({
  payload,
  onClose,
  backFallbackLabel,
  closeLabel,
  getKindLabel,
  onAction,
  capabilities,
  onDirtyChange,
}: InspectorProps) {
  const { current, previous, push, pop, setCurrentTitle } = useInspectorStack(payload);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const confirm = useConfirm();
  const tInspector = useTranslations('inspector');

  // Payloads report dirty state up through PayloadRouter — Inspector owns the
  // confirm prompt so every leave path (Esc / backdrop / ✕ / Back / push) is
  // guarded by one source of truth. `onDirtyChange` prop, if provided, is
  // mirrored to the parent so consumers can still read dirty state externally.
  const [payloadDirty, setPayloadDirty] = useState(false);
  // Latest-snapshot ref so the leave handlers can stay stable across re-renders
  // (they only need to read dirty, not re-bind on every change).
  const payloadDirtyRef = useRef(payloadDirty);
  useEffect(() => {
    payloadDirtyRef.current = payloadDirty;
  }, [payloadDirty]);

  const handleDirtyChange = useCallback(
    (next: boolean) => {
      setPayloadDirty(next);
      onDirtyChange?.(next);
    },
    [onDirtyChange],
  );

  // Run `commit` immediately if not dirty (keeps Esc / backdrop / click leave
  // paths synchronous for tests and accessibility tools that rely on no extra
  // microtask hop). Otherwise prompt and run `commit` only on accept; on
  // accept also clear the dirty flag eagerly so a re-open of a clean payload
  // doesn't inherit stale state.
  const guardedLeave = useCallback(
    (commit: () => void) => {
      if (!payloadDirtyRef.current) {
        commit();
        return;
      }
      void (async () => {
        const ok = await confirm({ message: tInspector('unsaved_confirm') });
        if (!ok) return;
        setPayloadDirty(false);
        onDirtyChange?.(false);
        commit();
      })();
    },
    [confirm, tInspector, onDirtyChange],
  );

  const handleClose = useCallback(() => guardedLeave(onClose), [guardedLeave, onClose]);
  const handleBack = useCallback(() => guardedLeave(pop), [guardedLeave, pop]);
  const handlePush = useCallback(
    (next: InspectorPayload) => guardedLeave(() => push(next)),
    [guardedLeave, push],
  );

  // 记录打开前的 activeElement，关闭时还原焦点（spec §5.5 a11y）
  const openerRef = useRef<HTMLElement | null>(null);
  const [openedOnce, setOpenedOnce] = useState(false);
  useEffect(() => {
    if (payload && !openedOnce) {
      openerRef.current = document.activeElement as HTMLElement | null;
      setOpenedOnce(true);
    }
    if (!payload && openedOnce) {
      openerRef.current?.focus?.();
      setOpenedOnce(false);
    }
  }, [payload, openedOnce]);

  // 打开时把焦点移进 dialog（首个可聚焦元素，一般是 close 按钮）
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — re-run only on payload identity change (kind/id), not on every render when `current` object re-references.
  useEffect(() => {
    if (!current) return;
    const focusables = getFocusableElements(dialogRef.current);
    focusables[0]?.focus();
  }, [current?.payload.kind, current?.payload.id]);

  // 键盘：ESC 关闭 + Tab focus trap（spec §5.5 a11y）
  useEffect(() => {
    if (!payload) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = getFocusableElements(dialogRef.current);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const insideDialog = dialogRef.current?.contains(active ?? null) ?? false;
      if (!insideDialog) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [payload, handleClose]);

  const handleBackdropPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.target === backdropRef.current) handleClose();
    },
    [handleClose],
  );

  if (!current) return null;

  // 加载中 / 失败时 payload.title 尚未回填，用 payload.id 兜底
  // 避免 header h3 与 aria-labelledby 指向空字符串（spec §5.5）。
  const currentTitle = current.title ?? String(current.payload.id);
  const previousTitle = previous ? (previous.title ?? String(previous.payload.id)) : null;
  const currentKindLabel = getKindLabel?.(current.payload.kind);

  return (
    <div
      ref={backdropRef}
      className="gp-inspector__backdrop"
      onPointerDown={handleBackdropPointerDown}
    >
      <aside
        ref={dialogRef}
        className="gp-inspector"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inspector-title"
      >
        <InspectorHeader
          currentTitle={currentTitle}
          kind={current.payload.kind}
          previousTitle={previousTitle}
          onBack={handleBack}
          onClose={handleClose}
          backFallbackLabel={backFallbackLabel}
          closeLabel={closeLabel}
          kindLabel={currentKindLabel}
        />
        <div className="gp-inspector__body">
          <PayloadRouter
            payload={current.payload}
            onTitleReady={setCurrentTitle}
            onNavigateEntity={handlePush}
            onAction={onAction}
            capabilities={capabilities}
            onDirtyChange={handleDirtyChange}
            onClose={onClose}
          />
        </div>
      </aside>
    </div>
  );
}
