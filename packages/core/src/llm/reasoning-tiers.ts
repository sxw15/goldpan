/**
 * Provider IDs that accept per-step `providerOptions` (reasoning / thinking).
 * Owned here (not in `config/index.ts`) so that client-only consumers — like
 * the settings UI's `ReasoningAdvanced` row — can import it without dragging
 * `node:fs` (config/index.ts hits `onboarding/env-file.ts` which imports
 * `node:fs` at module top). `config/index.ts` re-exports for backend callers.
 *
 * Ollama excluded — no standard reasoning shape.
 */
export const PROVIDERS_WITH_OPTIONS = ['anthropic', 'openai', 'google', 'deepseek'] as const;
export type ProviderWithOptions = (typeof PROVIDERS_WITH_OPTIONS)[number];

/**
 * UI-facing thinking depth abstraction. The settings page presents these 5
 * tiers to users; each (tier, provider) pair translates into provider-native
 * AI SDK shape via {@link TIER_TO_PROVIDER_OPTIONS}. JSON is still the source
 * of truth in env / DB override — this module is the wrapper, not a replacement.
 *
 * 'off' is the default: env never set / DB override absent. UI translates 'off'
 * into a `null` patch (= delete-override marker).
 */
export const REASONING_TIERS = ['off', 'low', 'medium', 'high', 'max'] as const;
export type ReasoningTier = (typeof REASONING_TIERS)[number];

/**
 * (tier, provider) → AI SDK provider-native options object. `null` means
 * "unset / no options" — UI emits a delete-override patch. Non-null entries
 * are forwarded verbatim to `providerOptions[<provider>]`.
 *
 * Per-provider design notes (verified against ai-sdk.dev provider docs):
 * - **Anthropic** (`thinking: { type: 'enabled', budgetTokens }`): budget
 *   ladder 1k / 4k / 16k / 32k tokens for low / medium / high / max. Max uses
 *   a fixed 32k budget instead of `type: 'adaptive'` for portability —
 *   `adaptive` is only supported on `claude-opus-4-6+`, but the project's
 *   default models (sonnet-4-5 / haiku-4-5) need the explicit budget form.
 * - **OpenAI** (`reasoningEffort` + `reasoningSummary`): low/medium/high map
 *   directly to `reasoningEffort`. Max uses `'high' + reasoningSummary: 'detailed'`
 *   instead of `'xhigh'` — `'xhigh'` is only supported on GPT-5.1-Codex-Max;
 *   o-series / gpt-5 chat models reject it. The detailed summary surfaces
 *   more reasoning output, distinguishing max from high.
 * - **Google** (`thinkingConfig.thinkingLevel`): low/medium/high. Note that
 *   Gemini 3 Pro only supports low/high (no medium) — medium falls back
 *   server-side or fails per model. Max adds `includeThoughts: true` so the
 *   response surfaces the reasoning chain (depth ceiling is still 'high';
 *   Google's ladder is shallower than other providers' by design).
 * - **DeepSeek** (`thinking: { type: 'enabled' }` + `reasoningEffort`):
 *   contrary to early belief, DeepSeek does support a tiered `reasoningEffort`
 *   on top of binary `thinking.type`. Low/medium/high/max map directly.
 *   Supported by `deepseek-chat` (via providerOptions) and `deepseek-reasoner`.
 */
export const TIER_TO_PROVIDER_OPTIONS: Readonly<
  Record<
    ReasoningTier,
    Readonly<Record<ProviderWithOptions, Readonly<Record<string, unknown>> | null>>
  >
> = {
  off: {
    anthropic: null,
    openai: null,
    google: null,
    deepseek: null,
  },
  low: {
    anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 } },
    openai: { reasoningEffort: 'low' },
    google: { thinkingConfig: { thinkingLevel: 'low' } },
    deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'low' },
  },
  medium: {
    anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
    openai: { reasoningEffort: 'medium' },
    google: { thinkingConfig: { thinkingLevel: 'medium' } },
    deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'medium' },
  },
  high: {
    anthropic: { thinking: { type: 'enabled', budgetTokens: 16384 } },
    openai: { reasoningEffort: 'high' },
    google: { thinkingConfig: { thinkingLevel: 'high' } },
    deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'high' },
  },
  max: {
    anthropic: { thinking: { type: 'enabled', budgetTokens: 32000 } },
    openai: { reasoningEffort: 'high', reasoningSummary: 'detailed' },
    google: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } },
    deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'max' },
  },
};

/**
 * Reverse map: given a parsed options object, recover the tier label so UI
 * can show "current = Medium" in the dropdown. Returns 'unknown' when the
 * shape doesn't match any of our ladder rungs (e.g., user hand-edited env to
 * `budgetTokens: 8000` between low and high) — UI then disables the dropdown
 * with "Custom (set via env)" so a click doesn't silently overwrite their
 * tuned value.
 *
 * Empty / null / unset → 'off' (the natural default for unconfigured rows).
 */
export function inferTierFromOptions(
  options: Record<string, unknown> | null | undefined,
  provider: ProviderWithOptions,
): ReasoningTier | 'unknown' {
  if (options === null || options === undefined) return 'off';
  if (Object.keys(options).length === 0) return 'off';
  switch (provider) {
    case 'anthropic':
      return inferAnthropic(options);
    case 'openai':
      return inferOpenAI(options);
    case 'google':
      return inferGoogle(options);
    case 'deepseek':
      return inferDeepSeek(options);
  }
}

function inferAnthropic(o: Record<string, unknown>): ReasoningTier | 'unknown' {
  const t = o.thinking as Record<string, unknown> | undefined;
  if (t === undefined || typeof t !== 'object' || t === null) return 'unknown';
  if (t.type === 'disabled') return 'off';
  // `adaptive` predates the explicit max budget; still recognized so users who
  // hand-rolled the older shape see Max in the dropdown instead of Custom.
  if (t.type === 'adaptive') return 'max';
  if (t.type !== 'enabled') return 'unknown';
  const b = t.budgetTokens;
  if (typeof b !== 'number' || b <= 0) return 'unknown';
  if (b <= 1024) return 'low';
  if (b <= 4096) return 'medium';
  if (b <= 16384) return 'high';
  if (b <= 32000) return 'max';
  return 'unknown';
}

function inferOpenAI(o: Record<string, unknown>): ReasoningTier | 'unknown' {
  const e = o.reasoningEffort;
  const s = o.reasoningSummary;
  if (e === 'none') return 'off';
  if (e === 'minimal' || e === 'low') return 'low';
  if (e === 'medium') return 'medium';
  // 'high' alone → high; 'high' + reasoningSummary === 'detailed' → max (the
  // current Max-tier shape). Other summary values fall through to 'high'.
  if (e === 'high') return s === 'detailed' ? 'max' : 'high';
  // 'xhigh' is legacy / GPT-5.1-Codex-Max only — recognized so users with an
  // older config keep seeing Max in the dropdown.
  if (e === 'xhigh') return 'max';
  return 'unknown';
}

function inferGoogle(o: Record<string, unknown>): ReasoningTier | 'unknown' {
  const c = o.thinkingConfig as Record<string, unknown> | undefined;
  if (c === undefined || typeof c !== 'object' || c === null) return 'unknown';
  const level = c.thinkingLevel;
  const includeThoughts = c.includeThoughts === true;
  // Google's ladder caps at 'high'; the Max tier is signaled by adding
  // includeThoughts, since the SDK has no deeper level. 'minimal' (Flash only)
  // is treated as 'low' for parity with the 5-tier ladder.
  if (level === 'minimal' || level === 'low') return 'low';
  if (level === 'medium') return 'medium';
  if (level === 'high') return includeThoughts ? 'max' : 'high';
  return 'unknown';
}

function inferDeepSeek(o: Record<string, unknown>): ReasoningTier | 'unknown' {
  const t = o.thinking as Record<string, unknown> | undefined;
  if (t === undefined || typeof t !== 'object' || t === null) return 'unknown';
  if (t.type === 'disabled') return 'off';
  if (t.type !== 'enabled' && t.type !== 'adaptive') return 'unknown';
  // DeepSeek actually exposes a separate `reasoningEffort` ladder on top of
  // binary `thinking.type`. Older configs that set only `thinking.type:
  // 'enabled'` (no effort) snap to 'medium' as the neutral midpoint.
  const e = o.reasoningEffort;
  if (e === undefined) return 'medium';
  if (e === 'minimal' || e === 'low') return 'low';
  if (e === 'medium') return 'medium';
  if (e === 'high' || e === 'xhigh') return 'high';
  if (e === 'max') return 'max';
  return 'unknown';
}
