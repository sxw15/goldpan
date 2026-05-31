// monorepo/packages/core/src/plugins/contribution.ts
//
// Settings contribution protocol — what every plugin (collector / intent /
// tool / llm-provider / im-channel / future) declares to drive its slice of
// the Settings UI. The host renders generic forms from `fields`, runs validation
// via `schema`, dispatches `actions` through a uniform endpoint, and resolves
// every LocalizedString to a plain string before sending to web.
//
// Design notes:
// - `schema` (zod) and `fields` (UI descriptors) are sibling declarations.
//   `validateContribution` enforces that every fields[i].name exists as a key
//   in schema.shape. Two declarations look redundant but each carries info the
//   other can't (zod has no UI kind / envKey; UI descriptors have no validation
//   rules). Mirroring the existing ImSettingsManifest pattern.
// - LocalizedString accepts a plain string, a partial locale record, or a full
//   record. Single-language plugin authors can ship a string and forget about
//   i18n; the host falls back gracefully.
// - resolveContribution() flattens everything to plain strings for the wire
//   format. Web receives JSON without union types — no client-side locale
//   logic needed for plugin content.

import type { ILogObj, Logger } from 'tslog';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------------

export type LocaleCode = 'en' | 'zh';

const REFERENCE_LOCALE: LocaleCode = 'en';

/**
 * Plugin-supplied localized string. Three legal forms:
 *
 *   1. Plain string — applies to every locale. Use this when shipping a
 *      single-language plugin and you don't care about translations.
 *   2. Partial locale record — translations for a subset of locales.
 *   3. Full locale record — every supported locale.
 *
 * Older strict `{ en: string; zh: string }` shape is a subtype of (3); no
 * plugin written against the old contract needs to change.
 */
export type LocalizedString = string | Partial<Record<LocaleCode, string>>;

/**
 * Resolve a LocalizedString to plain string for the active locale, with
 * fallback chain: requested locale → reference locale (en) → first non-empty
 * entry. Throws on broken values (empty string, `{}`) so the plugin author
 * sees the failure at boot rather than the user seeing a blank UI.
 */
export function resolveLocalized(value: LocalizedString, locale: LocaleCode): string {
  if (typeof value === 'string') {
    if (value.length === 0) {
      throw new Error('resolveLocalized: empty string is not a valid LocalizedString');
    }
    return value;
  }
  const direct = value[locale];
  if (direct !== undefined && direct.length > 0) return direct;
  const reference = value[REFERENCE_LOCALE];
  if (reference !== undefined && reference.length > 0) return reference;
  for (const key of Object.keys(value) as LocaleCode[]) {
    const v = value[key];
    if (v !== undefined && v.length > 0) return v;
  }
  throw new Error('resolveLocalized: no available translation in LocalizedString');
}

// ---------------------------------------------------------------------------
// Settings field descriptors
// ---------------------------------------------------------------------------

export type SettingsFieldKind = 'text' | 'secret' | 'segmented' | 'toggle' | 'number';

export interface SettingsFieldBase {
  /** Property name in `schema.shape`. */
  name: string;
  kind: SettingsFieldKind;
  /** Env var that backs this field. Must be unique within the contribution. */
  envKey: string;
  label: LocalizedString;
  hint?: LocalizedString;
  required?: boolean;
  /** When true, host shows "requires restart" badge after editing. Default false. */
  requiresRestart?: boolean;
}

export interface SettingsTextField extends SettingsFieldBase {
  kind: 'text' | 'secret';
  placeholder?: LocalizedString;
  /**
   * Schema default surfaced to the UI when the env key is unconfigured
   * (`source: 'default'`). Plugins SHOULD set this to the same value their
   * host config schema (`z.string().default(...)`) carries so the UI shows
   * the truth — without it, the row reads "未配置" while the runtime is
   * actually using the schema default, a silent display/runtime drift.
   * Plain language: "what would actually run if no override exists".
   * Secret kinds typically leave this unset (no meaningful default exists
   * for a credential); it's tolerated on `secret` only for type uniformity.
   */
  default?: string;
}

export interface SettingsNumberField extends SettingsFieldBase {
  kind: 'number';
  placeholder?: LocalizedString;
  min?: number;
  max?: number;
  step?: number;
  /** Schema default surfaced to the UI when the env key is unconfigured.
   * See SettingsTextField.default for rationale. */
  default?: number;
}

export interface SettingsSegmentedField<V extends string = string> extends SettingsFieldBase {
  kind: 'segmented';
  options: ReadonlyArray<{ value: V; label: LocalizedString }>;
  default?: V;
}

export interface SettingsToggleField extends SettingsFieldBase {
  kind: 'toggle';
  default?: boolean;
}

export type SettingsField =
  | SettingsTextField
  | SettingsNumberField
  | SettingsSegmentedField
  | SettingsToggleField;

// ---------------------------------------------------------------------------
// Settings group
// ---------------------------------------------------------------------------

/**
 * Top-level Settings UI groups. A contribution declares which group its
 * fields appear under. New groups should be rare — coarse semantics keep
 * the UI navigable.
 */
export type SettingsGroup = 'search' | 'notify' | 'collect' | 'digest' | 'llm' | 'embedding';

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Server-side button the plugin exposes (e.g. "send test message"). Host
 * renders one button per descriptor; clicking POSTs to
 * `/settings/contributions/:pluginId/actions/:actionId` with the current
 * (possibly unsaved) form values. The plugin's handler returns success/
 * failure with optional structured data the host surfaces in a toast.
 *
 * v1 only implements `kind: 'test'`. The old IM-only protocol also reserved
 * 'lookup' (server returns a list of pickable items), but no consumer
 * exists yet. Add new kinds only when there's a real UI to dispatch them.
 */
export interface PluginActionDescriptor {
  /** Stable id within the plugin. URL-encoded into the action endpoint. */
  id: string;
  kind: 'test';
  label: LocalizedString;
  /**
   * Form field names that must be non-empty before the button is enabled.
   * References `Object.keys(contribution.schema.shape)`.
   */
  requires?: ReadonlyArray<string>;
  /**
   * Maps handler-returned `errorCode` → localized message. The host shows
   * the resolved string in a toast when the action returns `ok: false`.
   */
  errorMessages?: Record<string, LocalizedString>;
  /**
   * Per-action timeout override. Host default is 30s. Long-running actions
   * (binary downloads, browser installs) declare a higher value so the
   * generic handler timeout does not kill the work mid-flight.
   */
  timeoutMs?: number;
}

export interface PluginActionContext {
  /**
   * Resolved current field values (secrets included). Keyed by field name
   * (matches `contribution.fields[i].name`).
   */
  values: Record<string, string | boolean | number | undefined>;
  locale: LocaleCode;
  logger: Logger<ILogObj>;
  /**
   * Aborted by the host when the action's overall deadline elapses (server
   * enforces HANDLER_TIMEOUT_MS). Plugin authors should pass this to any
   * outbound `fetch(..., { signal })` so a timeout actually cancels the
   * underlying request instead of leaking the socket. Always present — the
   * host wires up a fresh AbortController per dispatch even when no explicit
   * timeout fires, so `signal.aborted` becomes the canonical liveness check.
   */
  signal: AbortSignal;
}

/**
 * Reserved key in `data` for "I've produced env values that should be
 * persisted". Web extracts `envPatch` and pushes them into dirty state — the
 * single .env writer stays the existing commitEnv flow.
 */
export interface PluginActionEnvPatch {
  envPatch?: Record<string, string>;
}

export type PluginActionResult =
  | { ok: true; data?: Record<string, unknown> & PluginActionEnvPatch }
  | {
      ok: false;
      code: string;
      message?: string;
      data?: Record<string, unknown> & PluginActionEnvPatch;
    };

export type PluginActionHandler = (ctx: PluginActionContext) => Promise<PluginActionResult>;

// ---------------------------------------------------------------------------
// Notices (optional)
// ---------------------------------------------------------------------------

/**
 * Plugin-level informational / warning blocks rendered at the top of the
 * settings card (above the enable toggle). Use for context that applies to
 * the whole plugin (anti-scrape risk, prerequisite warnings, recommendation
 * to prefer another provider) rather than to a single field.
 *
 * Two kinds:
 *  - `warn`: yellow/orange styled block — material caveat the user should
 *    read before enabling.
 *  - `info`: neutral callout — non-blocking context.
 */
export interface PluginNotice {
  kind: 'warn' | 'info';
  message: LocalizedString;
}

// ---------------------------------------------------------------------------
// Setup guide (optional)
// ---------------------------------------------------------------------------

export interface PluginSetupStep {
  id: string;
  title: LocalizedString;
  desc: LocalizedString;
  /**
   * Plugin-relative paths to images. Resolved against the plugin's static
   * mount: `/settings/contributions/:pluginId/assets/<path>`.
   */
  images?: ReadonlyArray<string>;
  externalLink?: { label: LocalizedString; href: string };
  code?: { language: string; text: string };
}

export interface PluginSetupGuide {
  allDoneTitle?: LocalizedString;
  steps: ReadonlyArray<PluginSetupStep>;
}

// ---------------------------------------------------------------------------
// Contribution
// ---------------------------------------------------------------------------

/**
 * What a plugin contributes to the Settings UI. Single source of truth: each
 * plugin exports one contribution; the host enumerates them, resolves
 * LocalizedStrings to the user's locale, and renders generic forms.
 */
export interface PluginSettingsContribution {
  /**
   * Stable plugin id, must match the plugin's `manifest.name` (core plugins)
   * or the channel id (IM plugins). Routes derived from this: hosts
   * URL-encode it.
   */
  pluginId: string;
  group: SettingsGroup;
  branding: {
    name: LocalizedString;
    tagline?: LocalizedString;
    /** Optional project / docs URL surfaced as a link in the plugin meta strip. */
    homepage?: string;
  };
  /**
   * Optional master enable toggle. When present, host renders a top-level
   * toggle that gates the rest of the form.
   */
  enable?: {
    envKey: string;
    label: LocalizedString;
    default: boolean;
  };
  /**
   * Zod schema for validation. Every key in `schema.shape` must have a
   * matching entry in `fields` (enforced by `validateContribution`).
   */
  schema: z.ZodObject<z.ZodRawShape>;
  /** UI field descriptors. Render order = array order. */
  fields: ReadonlyArray<SettingsField>;
  actions?: ReadonlyArray<PluginActionDescriptor>;
  setupGuide?: PluginSetupGuide;
  /**
   * Plugin-level notices rendered above the enable toggle. Render order =
   * array order. See `PluginNotice`.
   */
  notices?: ReadonlyArray<PluginNotice>;
}

/**
 * Server-side counterpart: contribution + handlers indexed by action.id.
 * Plugin exports `{ contribution, actionHandlers }` together. Handlers may
 * be omitted when contribution has no actions.
 */
export interface PluginSettingsModule {
  contribution: PluginSettingsContribution;
  actionHandlers?: Record<string, PluginActionHandler>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// z.record(z.enum([...]), v) in zod v4 requires ALL enum keys — not partial —
// so we use z.object({ en, zh }) with both optional + a refine to enforce
// "at least one locale present". This also rejects unknown locale keys
// (e.g. typo `enn:`) which a partial record would silently accept.
const localizedStringSchema = z.union([
  z.string().min(1),
  z
    .object({
      en: z.string().min(1).optional(),
      zh: z.string().min(1).optional(),
    })
    .refine((v) => v.en !== undefined || v.zh !== undefined, {
      message: 'at least one locale must be present',
    }),
]);

const fieldBase = {
  name: z.string().min(1),
  envKey: z.string().min(1),
  label: localizedStringSchema,
  hint: localizedStringSchema.optional(),
  required: z.boolean().optional(),
  requiresRestart: z.boolean().optional(),
};

const textFieldSchema = z.object({
  ...fieldBase,
  kind: z.enum(['text', 'secret']),
  placeholder: localizedStringSchema.optional(),
});

const numberFieldSchema = z.object({
  ...fieldBase,
  kind: z.literal('number'),
  placeholder: localizedStringSchema.optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
});

const segmentedFieldSchema = z.object({
  ...fieldBase,
  kind: z.literal('segmented'),
  options: z.array(z.object({ value: z.string(), label: localizedStringSchema })).min(1),
  default: z.string().optional(),
});

const toggleFieldSchema = z.object({
  ...fieldBase,
  kind: z.literal('toggle'),
  default: z.boolean().optional(),
});

const fieldSchemaUnion = z.discriminatedUnion('kind', [
  textFieldSchema,
  numberFieldSchema,
  segmentedFieldSchema,
  toggleFieldSchema,
]);

const actionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('test'),
  label: localizedStringSchema,
  requires: z.array(z.string()).optional(),
  errorMessages: z.record(z.string(), localizedStringSchema).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
});

const noticeSchema = z.object({
  kind: z.enum(['warn', 'info']),
  message: localizedStringSchema,
});

const setupStepSchema = z.object({
  id: z.string().min(1),
  title: localizedStringSchema,
  desc: localizedStringSchema,
  images: z.array(z.string()).optional(),
  externalLink: z.object({ label: localizedStringSchema, href: z.url() }).optional(),
  code: z.object({ language: z.string(), text: z.string() }).optional(),
});

// `schema` (the zod ZodObject) is checked separately because zod can't validate
// another zod schema as a value.
const contributionStaticSchema = z.object({
  pluginId: z.string().min(1),
  group: z.enum(['search', 'notify', 'collect', 'digest', 'llm', 'embedding']),
  branding: z.object({
    name: localizedStringSchema,
    tagline: localizedStringSchema.optional(),
    homepage: z.url().optional(),
  }),
  enable: z
    .object({
      envKey: z.string().min(1),
      label: localizedStringSchema,
      default: z.boolean(),
    })
    .optional(),
  fields: z.array(fieldSchemaUnion),
  actions: z.array(actionSchema).optional(),
  setupGuide: z
    .object({
      allDoneTitle: localizedStringSchema.optional(),
      steps: z.array(setupStepSchema),
    })
    .optional(),
  notices: z.array(noticeSchema).optional(),
});

function isZodObjectSchema(value: unknown): value is z.ZodObject {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    shape?: unknown;
    safeParse?: unknown;
    _zod?: { def?: { type?: unknown } };
    _def?: { type?: unknown; typeName?: unknown };
  };
  const typeName = candidate._zod?.def?.type ?? candidate._def?.type ?? candidate._def?.typeName;
  return (
    typeof candidate.safeParse === 'function' &&
    typeof candidate.shape === 'object' &&
    candidate.shape !== null &&
    (typeName === 'object' || typeName === 'ZodObject')
  );
}

export interface ContributionValidationError {
  path: string[];
  message: string;
}

export type ContributionValidationResult =
  | { ok: true; contribution: PluginSettingsContribution }
  | { ok: false; errors: ContributionValidationError[] };

/**
 * Validate a candidate contribution. Returns structured errors on failure
 * (zod issues + cross-field checks). Cross-field checks beyond what zod can
 * express:
 *  - every fields[i].name must be a key in schema.shape
 *  - no duplicate field names
 *  - no duplicate envKeys across fields
 *  - every action.requires[] entry must reference an existing field name
 */
export function validateContribution(candidate: unknown): ContributionValidationResult {
  if (typeof candidate !== 'object' || candidate === null) {
    return { ok: false, errors: [{ path: [], message: 'contribution must be an object' }] };
  }

  // Pull `schema` out for separate validation (zod can't validate another zod
  // schema as a value). This structural guard accepts z.object() from another
  // bundled Zod copy, but rejects shape-only impostors.
  const c = candidate as { schema?: unknown };
  const schemaValue = c.schema;
  if (!isZodObjectSchema(schemaValue)) {
    return {
      ok: false,
      errors: [{ path: ['schema'], message: 'schema must be a z.object(...) — got non-zod value' }],
    };
  }

  const { schema: _schema, ...rest } = candidate as Record<string, unknown>;
  const parsed = contributionStaticSchema.safeParse(rest);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String),
        message: issue.message,
      })),
    };
  }

  const shape = (schemaValue as { shape: Record<string, unknown> }).shape;
  const shapeKeys = new Set(Object.keys(shape));

  const fieldNames = new Set<string>();
  const envKeys = new Set<string>();
  if (parsed.data.enable !== undefined) {
    envKeys.add(parsed.data.enable.envKey);
  }
  for (const field of parsed.data.fields) {
    if (!shapeKeys.has(field.name)) {
      return {
        ok: false,
        errors: [
          {
            path: ['fields', field.name],
            message: `field "${field.name}" not present in schema.shape`,
          },
        ],
      };
    }
    if (fieldNames.has(field.name)) {
      return {
        ok: false,
        errors: [{ path: ['fields'], message: `duplicate field name: ${field.name}` }],
      };
    }
    if (envKeys.has(field.envKey)) {
      return {
        ok: false,
        errors: [{ path: ['fields'], message: `duplicate envKey: ${field.envKey}` }],
      };
    }
    fieldNames.add(field.name);
    envKeys.add(field.envKey);
  }
  for (const key of shapeKeys) {
    if (!fieldNames.has(key)) {
      return {
        ok: false,
        errors: [
          {
            path: ['schema', key],
            message: `schema key "${key}" has no matching field descriptor`,
          },
        ],
      };
    }
  }

  if (parsed.data.actions) {
    const actionIds = new Set<string>();
    for (const action of parsed.data.actions) {
      if (actionIds.has(action.id)) {
        return {
          ok: false,
          errors: [{ path: ['actions'], message: `duplicate action id: ${action.id}` }],
        };
      }
      actionIds.add(action.id);
      for (const r of action.requires ?? []) {
        if (!fieldNames.has(r)) {
          return {
            ok: false,
            errors: [
              {
                path: ['actions', action.id, 'requires'],
                message: `unknown field name in requires: ${r}`,
              },
            ],
          };
        }
      }
    }
  }

  return {
    ok: true,
    // Re-attach the raw zod schema to the parsed shape — type assertion is
    // safe because the static + cross checks above cover everything.
    contribution: {
      ...parsed.data,
      schema: schemaValue,
    } as unknown as PluginSettingsContribution,
  };
}

/**
 * Convert a field-name contribution schema into env-key validators suitable for
 * ConfigStore's staged env validation. The UI persists strings, but plugin
 * authors write schemas against typed field values, so this adapter handles the
 * string -> boolean / number coercion at the host boundary.
 */
export function buildContributionEnvSchema(
  contribution: PluginSettingsContribution,
): z.ZodRawShape {
  const validation = validateContribution(contribution);
  if (!validation.ok) {
    const issues = validation.errors
      .map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`)
      .join('; ');
    throw new Error(`Invalid settings contribution for "${contribution.pluginId}": ${issues}`);
  }

  const out: Record<string, z.ZodTypeAny> = {};
  if (contribution.enable !== undefined) {
    out[contribution.enable.envKey] = z.enum(['true', 'false']).optional();
  }
  const shape = contribution.schema.shape;
  for (const field of contribution.fields) {
    const fieldSchema = shape[field.name] as z.ZodTypeAny;
    // Env validation runs against the whole staged env record on every save,
    // including saves for unrelated groups. A required contribution field
    // should only fail when that key is present with an invalid value; missing
    // plugin config means "plugin not configured yet", not "block all saves".
    out[field.envKey] = envFieldSchema(field, fieldSchema).optional();
  }
  return out;
}

function envFieldSchema(field: SettingsField, fieldSchema: z.ZodTypeAny): z.ZodTypeAny {
  if (field.kind === 'number') {
    return z.preprocess((value) => {
      if (value === undefined || value === '') return undefined;
      if (typeof value === 'string') return Number(value);
      return value;
    }, fieldSchema);
  }
  if (field.kind === 'toggle') {
    return z.preprocess((value) => {
      if (value === undefined || value === '') return undefined;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    }, fieldSchema);
  }
  return z.preprocess((value) => {
    if (value === undefined) return undefined;
    return String(value);
  }, fieldSchema);
}

/**
 * Decide whether a contribution is "ready to use at runtime" from env state.
 * Used by callers that need to know if a plugin can actually serve traffic
 * (e.g. tracking page's "do we have a usable search engine?" probe), as
 * opposed to just "is the plugin registered" — `listToolCandidates` answers
 * the latter and does not consult env.
 *
 * Rules:
 *  - If `contribution.enable` is declared, the env value must be the literal
 *    string `"true"` (matches how every search plugin gates `executeTool`).
 *  - Every `kind: 'secret'` field's env value must be non-empty.
 *  - Any field marked `required: true` must also be non-empty, including
 *    non-secret runtime prerequisites such as a self-hosted base URL.
 *
 * Pure function over the env source so tests can pass a plain object. Defaults
 * to `process.env` for production callers.
 */
export function isContributionRuntimeReady(
  contribution: PluginSettingsContribution,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (contribution.enable && env[contribution.enable.envKey] !== 'true') return false;
  for (const f of contribution.fields) {
    if ((f.kind === 'secret' || f.required === true) && !env[f.envKey]?.trim()) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Resolved descriptors (server → web wire format)
// ---------------------------------------------------------------------------

/**
 * After server resolves every LocalizedString to a plain string. Web receives
 * these — no union types, no client-side locale logic for plugin content.
 */
export interface ResolvedSettingsField {
  name: string;
  kind: SettingsFieldKind;
  envKey: string;
  label: string;
  hint?: string;
  placeholder?: string;
  default?: string | boolean | number;
  required?: boolean;
  requiresRestart?: boolean;
  options?: ReadonlyArray<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
}

export interface ResolvedPluginActionDescriptor {
  id: string;
  kind: 'test';
  label: string;
  requires?: ReadonlyArray<string>;
  errorMessages?: Record<string, string>;
  timeoutMs?: number;
}

export interface ResolvedPluginNotice {
  kind: 'warn' | 'info';
  message: string;
}

export interface ResolvedPluginSetupStep {
  id: string;
  title: string;
  desc: string;
  images?: ReadonlyArray<string>;
  externalLink?: { label: string; href: string };
  code?: { language: string; text: string };
}

export interface ResolvedPluginSetupGuide {
  allDoneTitle?: string;
  steps: ReadonlyArray<ResolvedPluginSetupStep>;
}

export interface ResolvedPluginSettingsContribution {
  pluginId: string;
  group: SettingsGroup;
  branding: { name: string; tagline?: string; homepage?: string };
  enable?: { envKey: string; label: string; default: boolean };
  fields: ReadonlyArray<ResolvedSettingsField>;
  actions?: ReadonlyArray<ResolvedPluginActionDescriptor>;
  setupGuide?: ResolvedPluginSetupGuide;
  notices?: ReadonlyArray<ResolvedPluginNotice>;
  /**
   * Plugin metadata merged in by the server route (not the contribution itself).
   * The route looks up the parent `GoldpanPlugin` via `pluginId === plugin.name`
   * and copies `version` / locale-resolved `description` here so the web meta
   * strip can render without an extra round-trip.
   */
  pluginVersion?: string;
  pluginDescription?: string;
}

/**
 * Flatten every LocalizedString in a contribution to plain strings for the
 * given locale. Server calls this before serializing the response to web.
 */
export function resolveContribution(
  contribution: PluginSettingsContribution,
  locale: LocaleCode,
): ResolvedPluginSettingsContribution {
  const t = (v: LocalizedString) => resolveLocalized(v, locale);

  const resolved: ResolvedPluginSettingsContribution = {
    pluginId: contribution.pluginId,
    group: contribution.group,
    branding: {
      name: t(contribution.branding.name),
      ...(contribution.branding.tagline !== undefined
        ? { tagline: t(contribution.branding.tagline) }
        : {}),
      ...(contribution.branding.homepage !== undefined
        ? { homepage: contribution.branding.homepage }
        : {}),
    },
    fields: contribution.fields.map((f) => resolveField(f, t)),
  };

  if (contribution.enable !== undefined) {
    resolved.enable = {
      envKey: contribution.enable.envKey,
      label: t(contribution.enable.label),
      default: contribution.enable.default,
    };
  }
  if (contribution.actions !== undefined) {
    resolved.actions = contribution.actions.map((a) => resolveAction(a, t));
  }
  if (contribution.setupGuide !== undefined) {
    resolved.setupGuide = resolveSetupGuide(contribution.setupGuide, t);
  }
  if (contribution.notices !== undefined) {
    resolved.notices = contribution.notices.map((n) => ({ kind: n.kind, message: t(n.message) }));
  }
  return resolved;
}

function resolveField(f: SettingsField, t: (v: LocalizedString) => string): ResolvedSettingsField {
  const base: ResolvedSettingsField = {
    name: f.name,
    kind: f.kind,
    envKey: f.envKey,
    label: t(f.label),
  };
  if (f.hint !== undefined) base.hint = t(f.hint);
  if (f.required !== undefined) base.required = f.required;
  if (f.requiresRestart !== undefined) base.requiresRestart = f.requiresRestart;

  if (f.kind === 'text' || f.kind === 'secret') {
    if (f.placeholder !== undefined) base.placeholder = t(f.placeholder);
    if (f.default !== undefined) base.default = f.default;
  } else if (f.kind === 'number') {
    if (f.placeholder !== undefined) base.placeholder = t(f.placeholder);
    if (f.min !== undefined) base.min = f.min;
    if (f.max !== undefined) base.max = f.max;
    if (f.step !== undefined) base.step = f.step;
    if (f.default !== undefined) base.default = f.default;
  } else if (f.kind === 'segmented') {
    base.options = f.options.map((o) => ({ value: o.value, label: t(o.label) }));
    if (f.default !== undefined) base.default = f.default;
  } else if (f.kind === 'toggle') {
    if (f.default !== undefined) base.default = f.default;
  }
  return base;
}

function resolveAction(
  a: PluginActionDescriptor,
  t: (v: LocalizedString) => string,
): ResolvedPluginActionDescriptor {
  const desc: ResolvedPluginActionDescriptor = {
    id: a.id,
    kind: a.kind,
    label: t(a.label),
  };
  if (a.requires !== undefined) desc.requires = a.requires;
  if (a.errorMessages !== undefined) {
    desc.errorMessages = Object.fromEntries(
      Object.entries(a.errorMessages).map(([k, v]) => [k, t(v)]),
    );
  }
  if (a.timeoutMs !== undefined) desc.timeoutMs = a.timeoutMs;
  return desc;
}

function resolveSetupGuide(
  g: PluginSetupGuide,
  t: (v: LocalizedString) => string,
): ResolvedPluginSetupGuide {
  const resolved: ResolvedPluginSetupGuide = {
    steps: g.steps.map((s) => {
      const step: ResolvedPluginSetupStep = {
        id: s.id,
        title: t(s.title),
        desc: t(s.desc),
      };
      if (s.images !== undefined) step.images = s.images;
      if (s.externalLink !== undefined) {
        step.externalLink = { label: t(s.externalLink.label), href: s.externalLink.href };
      }
      if (s.code !== undefined) step.code = s.code;
      return step;
    }),
  };
  if (g.allDoneTitle !== undefined) resolved.allDoneTitle = t(g.allDoneTitle);
  return resolved;
}
