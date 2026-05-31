import type { ILogObj, Logger } from 'tslog';
import { type ZodRawShape, z } from 'zod';
import type { SecretResolver } from './secrets/resolver.js';

/**
 * Plugin-supplied i18n strings. Strict shape — both `en` and `zh` required.
 * If a plugin author hasn't translated a string, repeat the en value rather
 * than making `zh` optional (avoids fallback ambiguity).
 *
 * Versioning contract: this type evolves alongside host's i18n scope. If
 * goldpan-host adds a third language (e.g. `ja`), this type extends to require
 * `ja` too, and all plugins must update.
 */
export type LocalizedString = { en: string; zh: string };

export type ImSettingsFieldKind = 'text' | 'secret' | 'segmented' | 'toggle';

export interface ImSettingsFieldBase {
  /** Stable name within this plugin. Also the wizard-state key. */
  name: string;
  kind: ImSettingsFieldKind;
  label: LocalizedString;
  hint?: LocalizedString;
  /** Maps to the .env key for this field. Required for fields that persist. */
  envKey: string;
  required?: boolean;
  /** Restart hint shown in settings UI ("requires restart" tag). Default: true. */
  requiresRestart?: boolean;
}

export interface ImSettingsTextField extends ImSettingsFieldBase {
  kind: 'text' | 'secret';
  placeholder?: LocalizedString;
}

export interface ImSettingsSegmentedField<V extends string = string> extends ImSettingsFieldBase {
  kind: 'segmented';
  options: ReadonlyArray<{ value: V; label: LocalizedString }>;
  default?: V;
}

export interface ImSettingsToggleField extends ImSettingsFieldBase {
  kind: 'toggle';
  default?: boolean;
}

export type ImSettingsField =
  | ImSettingsTextField
  | ImSettingsSegmentedField
  | ImSettingsToggleField;

/** A server-side action the channel exposes (e.g. "send test message"). */
export interface ImSettingsActionDescriptor {
  /** Stable id within the plugin (`test`, `list_chats`). Routed via URL. */
  id: string;
  /**
   * v1 only implements `test` (button → invoke handler → toast result). The
   * old enum included `lookup` (return a list of pickable items, render via a
   * future picker UI) but neither the server route nor `<ImChannelCard>`
   * actually distinguishes it from `test`, so accepting it would silently
   * mis-render. Restore when there is a real picker consumer + handler
   * dispatch path.
   */
  kind: 'test';
  label: LocalizedString;
  /** When all listed field names are configured (non-empty), button is enabled. */
  requires: ReadonlyArray<string>;
  /** Maps server-returned `errorCode` → localized message. Fallback chain in spec §5.1. */
  errorMessages?: Record<string, LocalizedString>;
}

export interface ImSetupGuideStep {
  id: string;
  title: LocalizedString;
  desc: LocalizedString;
  /**
   * Plugin-relative paths to images. Resolved against the plugin's static
   * mount: `/settings/im/:channelId/assets/<path>`. Empty array allowed.
   */
  images: ReadonlyArray<string>;
  externalLink?: { label: LocalizedString; href: string };
  code?: { language: string; text: string };
}

export interface ImSettingsManifest {
  /** Must equal `ChannelAdapter.channelId`. */
  channelId: string;
  branding: {
    name: LocalizedString;
    tagline?: LocalizedString;
  };
  enable: {
    envKey: string;
    label: LocalizedString;
    default: boolean;
  };
  fields: ReadonlyArray<ImSettingsField>;
  actions: ReadonlyArray<ImSettingsActionDescriptor>;
  setupGuide: {
    allDoneTitle: LocalizedString;
    steps: ReadonlyArray<ImSetupGuideStep>;
  };
}

export interface ImSettingsActionContext {
  /**
   * Resolved field values (secrets included). Read-only snapshot of fresh .env.
   * Keys correspond to `manifest.fields[i].name`; runtime-validated by the
   * dispatcher, not enforced at the type level.
   */
  values: Record<string, string | boolean | undefined>;
  language: 'en' | 'zh';
  logger: Logger<ILogObj>;
  /**
   * Aborted by the host when the action's deadline elapses. Pass to any
   * outbound `fetch(..., { signal })` so timeout actually cancels the request.
   * Always present even outside a timeout scenario, because the legacy
   * `/settings/im/*` route now wires up a fresh AbortController per dispatch
   * to align with the generic contribution route.
   */
  signal: AbortSignal;
}

/**
 * Reserved key in `data` for "I've produced env values that should be persisted".
 * Web extracts `envPatch` and pushes them into dirty state — single .env writer
 * stays the existing commitEnv flow (spec §11 decision #2). v1 unused.
 */
export interface ImActionEnvPatch {
  envPatch?: Record<string, string>;
}

export type ImSettingsActionResult =
  | { ok: true; data?: Record<string, unknown> & ImActionEnvPatch }
  | {
      ok: false;
      code: string;
      message?: string;
      data?: Record<string, unknown> & ImActionEnvPatch;
    };

export type ImSettingsActionHandler = (
  ctx: ImSettingsActionContext,
) => Promise<ImSettingsActionResult>;

/** What plugins export alongside the manifest. */
export interface ImSettingsModule {
  manifest: ImSettingsManifest;
  handlers: Record<string, ImSettingsActionHandler>;
}

/**
 * Plugin describes its env contribution: a zod schema fragment + a `parse`
 * producing the channel-specific config slice + a `toValues` projector that
 * turns the slice into manifest-field-keyed values for action handler
 * dispatch.
 *
 * Why both `parse` and `toValues`:
 * - `parse` produces `T` — the slice's shape suits the channel adapter
 *   (e.g. Telegram `.botTokenRef` / `.allowedChatIds: ReadonlyArray`).
 * - `toValues` bridges that internal shape to manifest field names
 *   (`botToken` / `allowedChatIds: string`), so the dispatcher can hand
 *   `ctx.values[fieldName]` to handlers without guessing slice property
 *   names. Each plugin owns this mapping explicitly — no host-side heuristic.
 *
 * `toValues` is also the only place where secret refs are resolved: server
 * provides a `SecretResolver` (env-backed for v1) and the plugin chooses
 * per-field whether to call `.resolve()`.
 */
export interface ImChannelEnvSpec<T> {
  channelId: string;
  envSchema: ZodRawShape;
  parse: (parsed: Record<string, unknown>) => T;
  toValues: (slice: T, resolver: SecretResolver) => Record<string, string | boolean | undefined>;
}

const localizedString = z.object({ en: z.string(), zh: z.string() });

const fieldBase = {
  name: z.string().min(1),
  label: localizedString,
  hint: localizedString.optional(),
  envKey: z.string().min(1),
  required: z.boolean().optional(),
  requiresRestart: z.boolean().optional(),
};

const textField = z.object({
  ...fieldBase,
  kind: z.enum(['text', 'secret']),
  placeholder: localizedString.optional(),
});

const segmentedField = z.object({
  ...fieldBase,
  kind: z.literal('segmented'),
  options: z.array(z.object({ value: z.string(), label: localizedString })).min(1),
  default: z.string().optional(),
});

const toggleField = z.object({
  ...fieldBase,
  kind: z.literal('toggle'),
  default: z.boolean().optional(),
});

const field = z.discriminatedUnion('kind', [textField, segmentedField, toggleField]);

const action = z.object({
  id: z.string().min(1),
  // v1: only 'test'. See ImSettingsActionDescriptor JSDoc for why lookup
  // is rejected at the schema layer rather than warned at runtime.
  kind: z.literal('test'),
  label: localizedString,
  requires: z.array(z.string()),
  errorMessages: z.record(z.string(), localizedString).optional(),
});

const setupStep = z.object({
  id: z.string().min(1),
  title: localizedString,
  desc: localizedString,
  images: z.array(z.string()),
  externalLink: z.object({ label: localizedString, href: z.url() }).optional(),
  code: z.object({ language: z.string(), text: z.string() }).optional(),
});

export const imSettingsManifestSchema = z.object({
  channelId: z.string().min(1),
  branding: z.object({
    name: localizedString,
    tagline: localizedString.optional(),
  }),
  enable: z.object({
    envKey: z.string().min(1),
    label: localizedString,
    default: z.boolean(),
  }),
  fields: z.array(field),
  actions: z.array(action),
  setupGuide: z.object({
    allDoneTitle: localizedString,
    steps: z.array(setupStep),
  }),
});

/**
 * Validate a candidate manifest. Returns `{ ok: true, manifest }` on success,
 * `{ ok: false, errors }` on failure. Errors include zod's detailed paths so
 * the loader can log "plugin X: fields[2].label.zh is missing".
 */
export function validateImSettingsManifest(
  candidate: unknown,
): { ok: true; manifest: ImSettingsManifest } | { ok: false; errors: z.core.$ZodIssue[] } {
  const result = imSettingsManifestSchema.safeParse(candidate);
  if (!result.success) return { ok: false, errors: result.error.issues };

  // Cross-field check 1: no duplicate envKey across fields.
  const envKeys = new Set<string>();
  for (const f of result.data.fields) {
    if (envKeys.has(f.envKey)) {
      return {
        ok: false,
        errors: [
          {
            code: 'custom',
            path: ['fields'],
            message: `duplicate envKey: ${f.envKey}`,
          } as z.core.$ZodIssue,
        ],
      };
    }
    envKeys.add(f.envKey);
  }

  // Cross-field check 2: every action.requires[] entry must reference an
  // existing field.name. Without this, `<ImChannelCard>` shows the action
  // button permanently disabled with no diagnostic — silent plugin-author bug.
  const fieldNames = new Set(result.data.fields.map((f) => f.name));
  for (const a of result.data.actions) {
    for (const r of a.requires) {
      if (!fieldNames.has(r)) {
        return {
          ok: false,
          errors: [
            {
              code: 'custom',
              path: ['actions', a.id, 'requires'],
              message: `unknown field name in requires: ${r}`,
            } as z.core.$ZodIssue,
          ],
        };
      }
    }
  }

  return { ok: true, manifest: result.data as ImSettingsManifest };
}
