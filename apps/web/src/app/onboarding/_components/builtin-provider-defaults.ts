// apps/web/src/app/onboarding/_components/builtin-provider-defaults.ts
//
// Metadata for the 6 builtin LLM providers we surface in the onboarding
// wizard. Imported by:
//
// - WizardProviderList — render order for the «Add Provider» buttons + the
//   `BUILTIN_ID_SET` membership test that distinguishes builtin from custom
//   rows in the configured-providers list. In `context='embedding'` it also
//   sorts buttons so providers with `embeddingSupported: true` come first
//   and tags the unsupported ones.
// - StepCard — same membership test for tagging provider options as
//   `'builtin' | 'custom'` in the dropdown source label.
// - AddBuiltinProviderModal — `context='embedding'` reads `embeddingExamples`
//   to render an inline hint guiding users on which model ids to enter.
//
// Why we ship `embeddingSupported` but NOT a chat-model catalog:
//   chat-model lineups change every few months (new flagship, deprecation,
//   rename) — a hardcoded list rots fast and confuses users into picking
//   models that no longer exist. Whether a provider exposes any embedding
//   endpoint at all is much more stable: it's an API-surface fact, not a
//   model-catalog fact. The 1–2 `embeddingExamples` are placeholder hints
//   only — never written to wizard state without the user entering them.

export interface BuiltinProviderMeta {
  id: BuiltinId;
  /** Whether the provider exposes an embedding endpoint at all. False here
   *  doesn't mean «can't be used» — users can still configure it for chat;
   *  the embedding step just sorts these to the back and tags them so users
   *  don't waste a click discovering they have to pick a different one. */
  embeddingSupported: boolean;
  /** 1–2 well-known embedding model ids used as placeholder/hint copy in
   *  the AddBuiltinProviderModal when opened from the embedding step. The
   *  hint also tells users to consult official docs, so a stale entry here
   *  degrades to «slightly outdated example» rather than a broken default. */
  embeddingExamples?: readonly string[];
}

export const BUILTIN_PROVIDERS: readonly BuiltinProviderMeta[] = [
  {
    id: 'openai',
    embeddingSupported: true,
    embeddingExamples: ['text-embedding-3-small', 'text-embedding-3-large'],
  },
  { id: 'anthropic', embeddingSupported: false },
  { id: 'deepseek', embeddingSupported: false },
  { id: 'openrouter', embeddingSupported: false },
  {
    id: 'google',
    embeddingSupported: true,
    embeddingExamples: ['text-embedding-004', 'gemini-embedding-001'],
  },
  {
    id: 'ollama',
    embeddingSupported: true,
    embeddingExamples: ['nomic-embed-text', 'mxbai-embed-large'],
  },
] as const;

export const BUILTIN_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'deepseek',
  'openrouter',
  'google',
  'ollama',
] as const;

export type BuiltinId = (typeof BUILTIN_PROVIDER_IDS)[number];

const META_BY_ID: ReadonlyMap<BuiltinId, BuiltinProviderMeta> = new Map(
  BUILTIN_PROVIDERS.map((p) => [p.id, p]),
);

export function builtinMeta(id: BuiltinId): BuiltinProviderMeta {
  // Safe: BUILTIN_PROVIDERS is keyed by every BuiltinId at module init.
  return META_BY_ID.get(id) as BuiltinProviderMeta;
}
