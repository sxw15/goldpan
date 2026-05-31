import type { InspectorKind } from '@/components/inspector/payloads/types';

export const LIBRARY_KINDS = [
  'entity',
  'note',
  'source',
] as const satisfies readonly InspectorKind[];

export const TRACKING_KINDS = ['interest'] as const satisfies readonly InspectorKind[];

// Const lookup keyed by `InspectorKind` so callers can hand `kind` directly to
// `t(...)` without `as 'kind_entity'` casts. `satisfies` forces the map to
// stay exhaustive when a new kind is added.
export const INSPECTOR_KIND_I18N_KEY = {
  entity: 'kind_entity',
  source: 'kind_source',
  note: 'kind_note',
  interest: 'kind_interest',
  task: 'kind_task',
} as const satisfies Record<InspectorKind, string>;
