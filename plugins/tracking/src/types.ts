export class TrackingServiceError extends Error {
  code: 'not_found' | 'conflict' | 'invalid_provider' | 'validation_error';
  constructor(code: TrackingServiceError['code'], message: string) {
    super(message);
    this.name = 'TrackingServiceError';
    this.code = code;
  }
}

export interface Interest {
  id: number;
  name: string;
  description: string | null;
  searchQueries: string[];
  toolProvider: string | null;
  intervalMinutes: number;
  enabled: boolean;
  status: 'idle' | 'executing';
  lastRunAt: number | null;
  nextRunAt: number | null;
  linkedEntityIds: number[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateInterestInput {
  name: string;
  description?: string;
  searchQueries: string[];
  toolProvider?: string;
  intervalMinutes?: number;
  linkedEntityIds?: number[];
  enabled?: boolean;
}

/**
 * Resolution status enum mirrors the CHECK constraint in `tracking_rules`
 * (see `db.ts` → `createV5Tables` lines ~65-69). Keep these literals in sync
 * with the CHECK list — Biome flags unreachable cases when one side drifts.
 *
 * - `resolved`            — normal rule, enabled, scheduler picks it up
 * - `pending_pipeline`    — created from a source still in pipeline; P4
 *                           resolver flips to `resolved` (and re-enables)
 *                           when the source terminates with entities
 * - `awaiting_clarify`    — confirmed source had >1 candidate entity; UI
 *                           needs to ask the user which subject to track
 * - `failed_no_entity`    — pipeline finished but produced no entities
 * - `failed_source_pipeline` — source ended in failed/discarded; rule
 *                              never auto-resolves (spec N3 race-hang防御)
 */
export type ResolutionStatus =
  | 'resolved'
  | 'pending_pipeline'
  | 'awaiting_clarify'
  | 'failed_no_entity'
  | 'failed_source_pipeline';

/**
 * Shape of the JSON written into `tracking_rules.pending_resolution`.
 * P4 deferredResolver reads it back when the source terminates;
 * conversationId + sessionRef are snapshots needed to push the resolved
 * assistant turn back to the originating chat (the user may have closed
 * the IM window or refreshed the web tab by then).
 */
export interface PendingResolutionPayload {
  /** The source whose pipeline must complete before resolution. */
  sourceId: number;
  /** create_tracking handler placeholder (user-facing label until resolved). */
  placeholderName?: string;
  /** Set on awaiting_clarify rows (resolver already saw >1 entity). */
  candidateEntityIds?: number[];
  /** P4: conversation that originated the tracking request. */
  conversationId: number;
  /** P4: IM session ref snapshot (undefined for Web/CLI origins). */
  sessionRef?: {
    channelId: string;
    accountId: string;
    chatId: string;
    userId: string;
  };
}

/**
 * Input for `createInterestWithResolution` — superset of `CreateInterestInput`
 * that allows callers (only the create_tracking handler today) to write a row
 * with `enabled=0` and a non-`resolved` resolution_status atomically. Distinct
 * from `createInterest` so the management-CRUD path can't accidentally land a
 * pending row by forgetting a field.
 *
 * The DB cross-column CHECK enforces `resolutionStatus = 'resolved' OR
 * enabled = 0`, so passing `enabled: true` + non-resolved status will hit
 * SQLITE_CONSTRAINT — callers should keep them in sync.
 */
export interface CreateInterestWithResolutionInput {
  name: string;
  description?: string;
  searchQueries: string[];
  toolProvider?: string;
  intervalMinutes?: number;
  linkedEntityIds?: number[];
  linkedSourceId?: number;
  enabled: boolean;
  resolutionStatus: ResolutionStatus;
  /** JSON blob stored verbatim in `tracking_rules.pending_resolution`. */
  pendingResolution?: PendingResolutionPayload;
}

export interface UpdateInterestInput {
  name?: string;
  description?: string;
  searchQueries?: string[];
  toolProvider?: string;
  intervalMinutes?: number;
  linkedEntityIds?: number[];
}

/**
 * Aggregate per-interest counters used by the list view (per-row hit numbers
 * + sparkline). Computed in a single batch SQL across `tracking_executions`
 * so the route does not pay N+1 round-trips when rendering the rule list.
 *
 * `sparkline` is always a 14-element array (oldest day → newest), zero-filled
 * for days with no executions. Length is part of the contract — front-end
 * relies on it for fixed-width rendering.
 */
export interface InterestStats {
  totalHits: number;
  newHits24h: number;
  ingestedTotal: number;
  sparkline: number[];
}

export interface InterestExecution {
  id: number;
  /**
   * Owning interest id. Must match the SDK shape (mirrored via the shared
   * fixture's `INTEREST_EXECUTION_KEYS`) so `/tracking/executions/:id`
   * callers can resolve the parent interest without a round-trip.
   */
  interestId: number;
  status: 'running' | 'done' | 'error';
  itemsFound: number;
  itemsSubmitted: number;
  startedAt: number;
  finishedAt: number | null;
  errorMessage: string | null;
}

export interface InterestExecutionDetail extends InterestExecution {
  items: InterestItem[];
}

export interface InterestItem {
  id: number;
  url: string;
  title: string | null;
  snippet: string | null;
  publishedAt: number | null;
  status: 'found' | 'submitted' | 'duplicate' | 'failed';
  sourceId: number | null;
}

export interface TrackingService {
  getInterests: () => Interest[];
  /**
   * Batch fetch per-interest aggregate counters. Returns one entry per
   * interest that has at least one execution; the route layer fills zeros
   * for missing ids so InterestListItem.totalHits etc. are always defined.
   */
  getInterestListStats: () => Map<number, InterestStats>;
  getInterest: (id: number) => Interest | undefined;
  createInterest: (data: CreateInterestInput) => Interest;
  /**
   * P2 `create_tracking` only — write a tracking_rule row that may carry a
   * non-`resolved` resolution_status (enabled MUST be false in that case).
   * Single INSERT, atomic with the entity-link junction writes. Used by
   * `create-tracking-handler.ts` to seed pending rows that P4's deferred
   * resolver later flips back to `resolved` + enabled.
   *
   * Returns only `{id, name}` (not the full Interest row) so the handler
   * can `tracking_pending` without paying for a second SELECT — the caller
   * only needs the id for the IntentPluginResult.
   */
  createInterestWithResolution: (data: CreateInterestWithResolutionInput) => {
    id: number;
    name: string;
  };
  updateInterest: (id: number, data: UpdateInterestInput) => Interest;
  deleteInterest: (id: number) => void;
  enableInterest: (id: number) => Interest;
  disableInterest: (id: number) => Interest;
  triggerExecution: (interestId: number) => void;
  getExecution: (id: number) => InterestExecutionDetail | undefined;
  getInterestExecutions: (
    interestId: number,
    options?: { page?: number; perPage?: number },
  ) => { executions: InterestExecution[]; total: number };
  startScheduler: () => void;
  drainScheduler: () => Promise<void>;
  /**
   * P4 deferred resolver lookup + transitions. Bootstrap forwards these to a
   * `DeferredTrackingPort` consumed by `@goldpan/core`'s pipeline post-hook;
   * keeping them on the public service interface (rather than a separate
   * repo type) means the resolver and the management CRUD share one
   * stateful implementation and one cross-column CHECK guarantee.
   *
   * All transitions are CAS — callers pass `expectedStatus` and read the
   * boolean to know whether a parallel resolver / clarify cron beat them.
   * Return-shape pre-parses `pending_resolution` JSON so the port can
   * forward `{id, pendingResolution}` without a second decode hop.
   */
  findPendingByPipelineSource: (
    sourceId: number,
  ) => Array<{ id: number; pendingResolution: PendingResolutionPayload | null }>;
  markResolved: (
    id: number,
    input: {
      name: string;
      searchQueries: string[];
      linkedEntityIds: number[];
      expectedStatus: ResolutionStatus;
    },
  ) => boolean;
  markFailedResolution: (
    id: number,
    input: {
      targetStatus: 'failed_no_entity' | 'failed_source_pipeline';
      expectedStatus: ResolutionStatus;
    },
  ) => boolean;
  markAwaitingClarify: (
    id: number,
    input: { candidateEntityIds: number[]; expectedStatus: ResolutionStatus },
  ) => boolean;
  findAwaitingClarifyOlderThan: (
    cutoffMs: number,
  ) => Array<{ id: number; pendingResolution: PendingResolutionPayload | null }>;
}
