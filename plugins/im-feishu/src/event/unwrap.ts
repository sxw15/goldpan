/**
 * Normalize a raw Feishu event payload into a `{ header, inner }` view.
 *
 * Why this exists
 * ---------------
 * The `@larksuiteoapi/node-sdk` (verified against v1.61.1, see
 * `RequestHandle.parse` in `lib/index.js`) flattens v2 events before
 * invoking registered handlers: the on-the-wire JSON
 *
 *   ```
 *   { schema: '2.0', header: { event_type, create_time, ... },
 *     event:  { sender, message, ... } }
 *   ```
 *
 * is delivered to the handler as
 *
 *   ```
 *   { schema: '2.0', event_type, create_time, ..., sender, message, ... }
 *   ```
 *
 * — i.e. both `header.*` and `event.*` are spread to the top level. Code
 * that reads `raw.event.message` against that shape gets `undefined` and
 * silently drops every real-world delivery (this was the Phase 2 latent
 * bug that motivated this helper).
 *
 * Webhook mode and unit-test fixtures still pass the un-flattened JSON
 * directly. Both shapes need to keep working, so every parser /filter
 * funnels through this helper instead of branching at the call site.
 *
 * Detection rule: if `raw.event` is an object, treat the payload as
 * un-flattened (the SDK never re-introduces an `event` key at the top
 * level of a flattened event); otherwise treat it as flattened and read
 * the inner fields directly off `raw`.
 */

export interface FeishuEventHeader {
  event_type?: string;
  event_id?: string;
  create_time?: string;
  tenant_key?: string;
  app_id?: string;
}

/**
 * The inner payload (what the original v2 schema calls `event`). Each
 * concrete event type narrows this further; we keep the union loose here
 * so a single helper serves message, card-action, and future event types.
 */
export interface FeishuEventInner {
  // im.message.receive_v1
  sender?: {
    sender_id?: { open_id?: string; union_id?: string; user_id?: string };
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    thread_id?: string;
    chat_type?: 'p2p' | 'group' | string;
    message_type?: string;
    content?: string;
    parent_id?: string;
    mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>;
  };
  // card.action.trigger
  operator?: { open_id?: string };
  action?: { value?: unknown };
  chat_id?: string;
}

export interface FeishuEventEnvelope {
  header: FeishuEventHeader;
  inner: FeishuEventInner;
}

/**
 * Keys lifted from the v2 `header` envelope to the top level by
 * `RequestHandle.parse`. Anything not in this set is treated as
 * inner-event payload after flattening.
 */
const HEADER_KEYS = [
  'event_type',
  'event_id',
  'create_time',
  'tenant_key',
  'app_id',
  // Schema marker the SDK leaves at top level via `__rest(targetData,
  // ['header','event'])`. Not part of the inner event but harmless to
  // strip alongside the real header keys.
  'schema',
  // SDK also writes a synthesized `[CEventType]` symbol-keyed marker;
  // it's a Symbol, not a string, so iteration over `HEADER_KEYS`
  // wouldn't catch it anyway. Symbol keys are skipped naturally by
  // `Object.entries`/`for...in`, so they cannot leak into `inner`.
] as const;

function pickString(
  source: Record<string, unknown>,
  key: (typeof HEADER_KEYS)[number],
): string | undefined {
  const v = source[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Per-payload memoization. Every inbound message is unwrapped once in
 * `parse-message.ts` and again in `filters/group-mention.ts`, and Lark
 * flattened payloads can carry dozens of top-level keys — re-splitting
 * on every filter hit is wasted work. The cache is keyed on the raw
 * object identity, so it naturally releases memory once the parse
 * closure drops the reference.
 */
const envelopeCache = new WeakMap<object, FeishuEventEnvelope>();

export function unwrapFeishuEvent(raw: unknown): FeishuEventEnvelope {
  if (!raw || typeof raw !== 'object') return { header: {}, inner: {} };
  const cached = envelopeCache.get(raw);
  if (cached) return cached;
  const r = raw as Record<string, unknown>;

  // Un-flattened (webhook payload, unit-test fixture): the wire format
  // still has a real `event` object hanging off the top.
  if (r.event && typeof r.event === 'object') {
    const headerRaw =
      r.header && typeof r.header === 'object' ? (r.header as Record<string, unknown>) : {};
    const header: FeishuEventHeader = {};
    for (const key of HEADER_KEYS) {
      const v = pickString(headerRaw, key);
      if (v !== undefined && key !== 'schema') header[key] = v;
    }
    const envelope: FeishuEventEnvelope = { header, inner: r.event as FeishuEventInner };
    envelopeCache.set(raw, envelope);
    return envelope;
  }

  // SDK-flattened: header fields and inner fields share the top level.
  // We split them into a typed `header` and a header-stripped `inner`
  // so future readers cannot accidentally pick up `event_type` /
  // `tenant_key` / `create_time` from the inner payload (which would
  // be a layering bug — the inner event has its own `chat_id`, not the
  // envelope's `app_id`).
  const header: FeishuEventHeader = {};
  const inner: Record<string, unknown> = {};
  const headerKeys = new Set<string>(HEADER_KEYS);
  for (const [k, v] of Object.entries(r)) {
    if (headerKeys.has(k)) {
      if (k !== 'schema' && typeof v === 'string') {
        header[k as Exclude<(typeof HEADER_KEYS)[number], 'schema'>] = v;
      }
      continue;
    }
    inner[k] = v;
  }
  const envelope: FeishuEventEnvelope = { header, inner: inner as FeishuEventInner };
  envelopeCache.set(raw, envelope);
  return envelope;
}
