import { EntityPayload } from './entity-payload';
import { InterestPayload } from './interest-payload';
import { NotePayload } from './note-payload';
import { SourceViewPayload } from './source-view-payload';
import { TaskPayload } from './task-payload';
import {
  EMPTY_CAPABILITIES,
  type InspectorPayload,
  type PayloadAction,
  type PayloadCapabilitySet,
} from './types';

export interface PayloadRouterProps {
  payload: InspectorPayload;
  onTitleReady: (title: string) => void;
  onNavigateEntity: (next: InspectorPayload) => void;
  onAction?: (action: PayloadAction) => Promise<void>;
  /**
   * Shell-declared action whitelist. Payloads use this to gate CTA rendering
   * so a button only appears in contexts where the dispatcher actually
   * handles the corresponding action. Absent → treated as empty (no CTAs).
   */
  capabilities?: PayloadCapabilitySet;
  /**
   * Review round B-Pr-2: only `interest` currently threads this through.
   * P5 Fix Batch 3 (I6): `note` now also reports dirty for content edits —
   * subtype / pin / archive / tag / entity changes are immediate PATCHes and
   * have no dirty concept.
   * Other payload kinds have no "unsaved changes" concept; shell close is
   * immediate for them.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /** P5 一轮 review: NotePayload delete / reclassify 成功后调用关闭 inspector. */
  onClose?: () => void;
}

function exhaustive(x: never): never {
  throw new Error(`Unhandled payload kind: ${JSON.stringify(x)}`);
}

export function PayloadRouter({
  payload,
  onTitleReady,
  onNavigateEntity,
  onAction,
  capabilities = EMPTY_CAPABILITIES,
  onDirtyChange,
  onClose,
}: PayloadRouterProps) {
  switch (payload.kind) {
    case 'entity':
      return (
        <EntityPayload
          key={`${payload.kind}:${payload.id}`}
          id={payload.id}
          onTitleReady={onTitleReady}
          onNavigateEntity={onNavigateEntity}
          onAction={onAction}
          capabilities={capabilities}
        />
      );
    case 'source':
      // SourceViewPayload is the source's full detail view: meta + URL + tags
      // + categories + entity-grouped knowledge points + discard. It used to
      // be a separate `kind: 'note'` in the discriminated union, but users
      // see both as "来源" — the duplication only created the "顶部写笔记"
      // mismatch.
      return (
        <SourceViewPayload
          key={`${payload.kind}:${payload.id}`}
          id={payload.id}
          onTitleReady={onTitleReady}
          onNavigateEntity={onNavigateEntity}
          onAction={onAction}
          capabilities={capabilities}
        />
      );
    case 'note':
      return (
        <NotePayload
          key={`${payload.kind}:${payload.id}`}
          id={payload.id}
          onTitleReady={onTitleReady}
          onNavigateEntity={onNavigateEntity}
          onAction={onAction}
          capabilities={capabilities}
          onClose={onClose}
          onDirtyChange={onDirtyChange}
        />
      );
    case 'interest':
      return (
        <InterestPayload
          key={`${payload.kind}:${payload.id}`}
          id={payload.id}
          onTitleReady={onTitleReady}
          onNavigateEntity={onNavigateEntity}
          onAction={onAction}
          capabilities={capabilities}
          onDirtyChange={onDirtyChange}
        />
      );
    case 'task':
      // TaskPayload is read-only per spec §4.4 — no onAction / onNavigateEntity
      // wiring. V1 has no UI trigger source (S7/S8 topnav dropdown will mount);
      // LIBRARY_KINDS / TRACKING_KINDS intentionally omit 'task' so URL
      // `?focus=N&kind=task` falls back to the shell's first allowed kind.
      return (
        <TaskPayload
          key={`${payload.kind}:${payload.id}`}
          id={payload.id}
          onTitleReady={onTitleReady}
        />
      );
    default:
      return exhaustive(payload);
  }
}
