import type { UpdateInterestInput } from '@goldpan/web-sdk';

export type InspectorPayload =
  | { kind: 'entity'; id: number }
  | { kind: 'source'; id: number }
  | { kind: 'note'; id: number }
  | { kind: 'interest'; id: number }
  | { kind: 'task'; id: number };

export type InspectorKind = InspectorPayload['kind'];

/**
 * Inspector dispatcher action union. `onAction(a)` returns `Promise<void>`:
 * resolve = SDK succeeded; reject = SDK failed (payload consumer handles inline alert).
 *
 * Spec §9.1 Option Y: `discardSource` keeps `window.confirm` inside the payload
 * component so cancelling does NOT cross the dispatcher boundary.
 */
export type PayloadAction =
  | { type: 'discardSource'; id: number }
  | { type: 'trackFromEntity'; entityId: number; entityName: string }
  | { type: 'updateInterest'; id: number; patch: UpdateInterestInput }
  | { type: 'deleteInterest'; id: number }
  | { type: 'setInterestEnabled'; id: number; enabled: boolean };

/**
 * Action capability declared by a shell. Shells pass a readonly set of the
 * actions their dispatcher actually handles, so payload components can
 * render CTAs only in contexts where a click does something meaningful.
 *
 * Without this, Inspector would forward `onAction` to every payload and
 * payloads like EntityPayload would render their CTA ("追踪此主题") in
 * TrackingShell, where the dispatcher's `trackFromEntity` case is
 * silently ignored → dead click.
 *
 * Default = no capabilities (safe: CTAs hidden). Shells must opt in.
 */
export type PayloadCapability = PayloadAction['type'];
export type PayloadCapabilitySet = ReadonlySet<PayloadCapability>;

export const EMPTY_CAPABILITIES: PayloadCapabilitySet = new Set<PayloadCapability>();
