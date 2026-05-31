// monorepo/packages/im-runtime/src/contribution-adapter.ts
//
// Bridge: convert legacy ImSettingsManifest into the generic
// PluginSettingsContribution protocol from @goldpan/core. Used during
// the IM → unified-contribution migration so the server can expose every
// IM channel through /settings/contributions without each IM plugin
// rewriting its own manifest declaration.
//
// Future: IM plugins should export `goldpanSettingsContribution` directly
// once we want them to own contribution-shaped declarations. Until then,
// the existing `goldpanIMSettings.manifest` (with all its strict-double-
// locale strings and `ImChannelEnvSpec` co-declarations) keeps working
// untouched, and this adapter produces an equivalent contribution
// programmatically.

import type {
  LocalizedString,
  PluginActionDescriptor,
  PluginActionHandler,
  PluginSettingsContribution,
  PluginSetupStep,
  SettingsField,
  SettingsSegmentedField,
  SettingsTextField,
  SettingsToggleField,
} from '@goldpan/core';
import { z } from 'zod';
import type { ImSettingsActionHandler, ImSettingsField, ImSettingsManifest } from './settings.js';

type ImActionValues = Record<string, string | boolean | undefined>;

export interface AdaptImHandlersToContributionOptions {
  /**
   * Lazily resolves env-derived field values. The adapter calls
   * `resolveEnvValue` only when the generic route forwarded an unchanged env
   * value, so a stale/missing env:// ref cannot block a dirty form override.
   */
  getRawEnvValue?: (fieldName: string) => string | boolean | undefined;
  resolveEnvValue?: (fieldName: string) => string | boolean | undefined;
}

/**
 * Convert an IM channel's settings manifest to a PluginSettingsContribution.
 *
 * The generated `schema` is intentionally permissive — it's only used for
 * UI-level input validation (non-empty when `required`, segmented values
 * inside `options`). Authoritative env→slice parsing still lives in the
 * plugin's `ImChannelEnvSpec.parse` and we never replace it.
 */
export function convertImManifestToContribution(
  manifest: ImSettingsManifest,
): PluginSettingsContribution {
  const shape: Record<string, z.ZodTypeAny> = {};
  const fields: SettingsField[] = [];

  for (const f of manifest.fields) {
    shape[f.name] = fieldToZodValidator(f);
    fields.push(convertField(f));
  }

  const contribution: PluginSettingsContribution = {
    pluginId: manifest.channelId,
    // IM channels live under the "notify" group — this matches the current
    // settings page layout (see apps/web/src/app/settings/groups/notify.tsx).
    group: 'notify',
    branding: {
      name: manifest.branding.name as LocalizedString,
      ...(manifest.branding.tagline !== undefined
        ? { tagline: manifest.branding.tagline as LocalizedString }
        : {}),
    },
    enable: {
      envKey: manifest.enable.envKey,
      label: manifest.enable.label as LocalizedString,
      default: manifest.enable.default,
    },
    schema: z.object(shape),
    fields,
    actions: manifest.actions.map(convertAction),
    setupGuide: {
      allDoneTitle: manifest.setupGuide.allDoneTitle as LocalizedString,
      steps: manifest.setupGuide.steps.map(convertSetupStep),
    },
  };

  return contribution;
}

function fieldToZodValidator(f: ImSettingsField): z.ZodTypeAny {
  if (f.kind === 'toggle') {
    const base = z.boolean();
    return f.required ? base : base.optional();
  }
  if (f.kind === 'segmented') {
    const values = f.options.map((o) => o.value) as [string, ...string[]];
    if (values.length === 0) return z.string();
    const enumeration = z.enum(values as [string, ...string[]]);
    return f.required ? enumeration : enumeration.optional();
  }
  // text | secret
  const base = f.required ? z.string().min(1) : z.string().optional();
  return base;
}

function convertField(f: ImSettingsField): SettingsField {
  const baseCommon = {
    name: f.name,
    envKey: f.envKey,
    label: f.label as LocalizedString,
    ...(f.hint !== undefined ? { hint: f.hint as LocalizedString } : {}),
    ...(f.required !== undefined ? { required: f.required } : {}),
    ...(f.requiresRestart !== undefined ? { requiresRestart: f.requiresRestart } : {}),
  };

  switch (f.kind) {
    case 'text':
    case 'secret': {
      const field: SettingsTextField = {
        ...baseCommon,
        kind: f.kind,
        ...(f.placeholder !== undefined ? { placeholder: f.placeholder as LocalizedString } : {}),
      };
      return field;
    }
    case 'segmented': {
      const field: SettingsSegmentedField = {
        ...baseCommon,
        kind: 'segmented',
        options: f.options.map((o) => ({
          value: o.value,
          label: o.label as LocalizedString,
        })),
        ...(f.default !== undefined ? { default: f.default } : {}),
      };
      return field;
    }
    case 'toggle': {
      const field: SettingsToggleField = {
        ...baseCommon,
        kind: 'toggle',
        ...(f.default !== undefined ? { default: f.default } : {}),
      };
      return field;
    }
    default: {
      const _exhaustive: never = f;
      throw new Error(`unknown ImSettingsField kind: ${(_exhaustive as { kind: string }).kind}`);
    }
  }
}

function convertAction(a: ImSettingsManifest['actions'][number]): PluginActionDescriptor {
  return {
    id: a.id,
    kind: a.kind,
    label: a.label as LocalizedString,
    requires: a.requires,
    ...(a.errorMessages !== undefined
      ? {
          errorMessages: Object.fromEntries(
            Object.entries(a.errorMessages).map(([k, v]) => [k, v as LocalizedString]),
          ),
        }
      : {}),
  };
}

/**
 * Wrap each ImSettingsActionHandler so it implements the generic
 * PluginActionHandler contract. ImSettingsActionContext.language and
 * PluginActionContext.locale are name-only different (both `'en' | 'zh'`),
 * and the IM handlers expect `values: Record<string, string | boolean |
 * undefined>` while the generic protocol allows `number` too — IM handlers
 * never see number values from the IM side, so the cast is safe.
 */
export function adaptImHandlersToContribution(
  imHandlers: Record<string, ImSettingsActionHandler> | undefined,
  options: AdaptImHandlersToContributionOptions = {},
): Record<string, PluginActionHandler> {
  if (imHandlers === undefined) return {};
  const out: Record<string, PluginActionHandler> = {};
  for (const [id, handler] of Object.entries(imHandlers)) {
    out[id] = async (ctx) => {
      const values = resolveImActionValues(
        ctx.values as Record<string, string | boolean | number | undefined>,
        options,
      );
      return handler({
        values,
        language: ctx.locale,
        logger: ctx.logger,
        signal: ctx.signal,
      });
    };
  }
  return out;
}

function resolveImActionValues(
  current: Record<string, string | boolean | number | undefined>,
  options: AdaptImHandlersToContributionOptions,
): ImActionValues {
  const values = current as ImActionValues;
  if (options.getRawEnvValue === undefined || options.resolveEnvValue === undefined) {
    return values;
  }

  const merged: ImActionValues = { ...values };
  for (const name of Object.keys(merged)) {
    const rawValue = options.getRawEnvValue(name);
    if (rawValue !== undefined && (merged[name] === undefined || merged[name] === rawValue)) {
      merged[name] = options.resolveEnvValue(name);
    }
  }
  return merged;
}

function convertSetupStep(s: ImSettingsManifest['setupGuide']['steps'][number]): PluginSetupStep {
  const step: PluginSetupStep = {
    id: s.id,
    title: s.title as LocalizedString,
    desc: s.desc as LocalizedString,
  };
  if (s.images !== undefined) step.images = s.images;
  if (s.externalLink !== undefined) {
    step.externalLink = {
      label: s.externalLink.label as LocalizedString,
      href: s.externalLink.href,
    };
  }
  if (s.code !== undefined) step.code = s.code;
  return step;
}
