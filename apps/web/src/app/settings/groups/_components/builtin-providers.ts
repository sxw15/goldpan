/**
 * Builtin LLM provider metadata — a single source of truth shared by:
 *   - llm.tsx：渲染已配置 builtin 的 row（label / 状态 tag）
 *   - add-builtin-provider-modal.tsx：弹 add/edit 时根据 id 拿 apiKeyEnv / 显示名
 *   - add-provider-card.tsx：列出未配置的 builtin 作为可添加项
 *
 * Mirrors the server-side `BUILTIN_KEY_ENV` map in
 * `apps/server/src/routes/llm-providers.ts`. Keep the keys in sync — the
 * server returns `apiKeyEnv` per provider, so we can also derive at runtime,
 * but having a frontend-side map saves us from "loading" states for static
 * info (display label, secret placeholder).
 *
 * Ollama is special: no API key, controlled by an enable toggle + base URL.
 * `apiKeyEnv` is intentionally empty — call sites must special-case ollama.
 */
export interface BuiltinProviderMeta {
  /** lowercase id matching server BUILTIN_KEY_ENV — anthropic / openai / etc. */
  id: string;
  /** Display name shown in headers / buttons; not localized — these are brand names. */
  label: string;
  /** Env var holding the API key. Empty string for ollama (no key needed). */
  apiKeyEnv: string;
  /** Placeholder shown in the api-key input when adding. */
  apiKeyPlaceholder?: string;
}

export const BUILTIN_PROVIDERS: ReadonlyArray<BuiltinProviderMeta> = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    apiKeyPlaceholder: 'sk-ant-…',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    apiKeyEnv: 'OPENAI_API_KEY',
    apiKeyPlaceholder: 'sk-…',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    apiKeyPlaceholder: 'sk-…',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    apiKeyPlaceholder: 'sk-or-…',
  },
  {
    id: 'google',
    label: 'Google',
    apiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
    apiKeyPlaceholder: 'AI…',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    apiKeyEnv: '',
  },
];

export function findBuiltinMeta(id: string): BuiltinProviderMeta | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.id === id);
}
