import { z } from 'zod';

// Single source of truth for builtin provider ids — `registry.ts`
// imports this set so its `BUILTIN_PROVIDER_FACTORIES` keys cannot drift
// from the collision-check used by `parseCustomLlmProviders`.
export const BUILTIN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'ollama',
  'openrouter',
]);

const customProviderSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(
      /^[a-z][a-z0-9_]*$/,
      'id must be lowercase alphanumeric / underscore, starting with letter',
    ),
  baseUrl: z.url(),
  apiKeyEnv: z
    .string()
    .min(1)
    .regex(/^[A-Z_][A-Z0-9_]*$/, 'apiKeyEnv must be a valid env var name (uppercase + underscore)'),
  /**
   * 用户预录的 model id 列表（来自 `GOLDPAN_LLM_PROVIDER_<ID>_MODELS` 逗号分隔）。
   * 仅供前端 Pipeline 下拉选择，运行期实际调模型用的是 step 配置里的
   * `<provider>:<model>` 字符串，这里**不**做后端校验 —— 用户写错 model id
   * 在第一次调用时由 LLM SDK 报错（同 add provider 之前的体验）。
   * 可空（用户没预录就让前端走「自定义」退路即可）。
   */
  models: z.array(z.string().min(1)).default([]),
});

export type CustomLlmProvider = z.infer<typeof customProviderSchema>;

const ID_KEY_RE = /^GOLDPAN_LLM_PROVIDER_([A-Z][A-Z0-9_]*)_BASE_URL$/;
// `_EMBEDDING_MODELS` 必须先匹配 —— `_MODELS` 正则不带 `(?<!EMBEDDING_)` 否定前
// 视，会同时吞掉 `_EMBEDDING_MODELS` 这条 key。两个正则保持互斥（`MODELS_KEY_RE`
// 显式拒绝 `_EMBEDDING_MODELS` 后缀）。
const EMBEDDING_MODELS_KEY_RE = /^GOLDPAN_LLM_PROVIDER_([A-Z][A-Z0-9_]*)_EMBEDDING_MODELS$/;
const MODELS_KEY_RE = /^GOLDPAN_LLM_PROVIDER_([A-Z][A-Z0-9_]*)_MODELS$/;

function splitModels(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

/**
 * 扫所有 `GOLDPAN_LLM_PROVIDER_<ID>_MODELS` env（chat 用），返回 `lower(id) →
 * models[]` map。不分 builtin / custom — 用户把 anthropic、openai 这类内置
 * provider 的可用 chat model 列表也写到 env 里，让前端 Pipeline 下拉直接读这
 * 一份。**不**校验 id 是否真的是已注册 provider（builtin 或 custom 或 plugin），
 * 未来加新 provider 类型时不会因为这层校验返工。
 *
 * 形态校验也宽松：model id 形式因 provider 而异（`gpt-4o-mini` /
 * `meta-llama/Llama-3-70b-instruct-turbo` / `qwen2.5:7b` 等），让真正调用时
 * 由 LLM SDK 兜错。
 *
 * `_EMBEDDING_MODELS` 走另一个 parser，**不**收进这里 —— chat 和 embedding 在
 * 真实模型层面集合互斥（`gpt-4o` 没有 embedding endpoint、`text-embedding-3-small`
 * 没有 chat endpoint），分两份让 Pipeline 下拉只看 chat、Embedding 设置只看
 * embedding，user 选错的可能性最小化。
 */
export function parseProviderModels(env: NodeJS.ProcessEnv): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(env)) {
    // `_EMBEDDING_MODELS` 也匹配 MODELS_KEY_RE（id 段会被吞成 `<ID>_EMBEDDING`），
    // 必须显式排除以免污染 chat list。
    if (EMBEDDING_MODELS_KEY_RE.test(key)) continue;
    const match = MODELS_KEY_RE.exec(key);
    if (!match) continue;
    const id = match[1].toLowerCase();
    const models = splitModels(env[key]);
    if (models.length > 0) out[id] = models;
  }
  return out;
}

/**
 * 镜像 `parseProviderModels`，但只扫 `GOLDPAN_LLM_PROVIDER_<ID>_EMBEDDING_MODELS`。
 * 让 Embedding 设置 / onboarding embedding 步骤的 model 下拉只看到「user 标记
 * 为 embedding 角色」的 model id —— 不会把 `gpt-4o` 这种 chat-only model 误列
 * 进 embedding 选项。
 */
export function parseProviderEmbeddingModels(env: NodeJS.ProcessEnv): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(env)) {
    const match = EMBEDDING_MODELS_KEY_RE.exec(key);
    if (!match) continue;
    const id = match[1].toLowerCase();
    const models = splitModels(env[key]);
    if (models.length > 0) out[id] = models;
  }
  return out;
}

export function parseCustomLlmProviders(env: NodeJS.ProcessEnv): CustomLlmProvider[] {
  const ids: string[] = [];
  for (const key of Object.keys(env)) {
    const match = ID_KEY_RE.exec(key);
    if (match) ids.push(match[1]);
  }
  ids.sort();

  const allModels = parseProviderModels(env);

  return ids.map((rawId) => {
    const id = rawId.toLowerCase();
    if (BUILTIN_PROVIDER_IDS.has(id)) {
      throw new Error(
        `GOLDPAN_LLM_PROVIDER_${rawId}_*: id "${id}" is reserved by a builtin provider`,
      );
    }
    const baseUrl = env[`GOLDPAN_LLM_PROVIDER_${rawId}_BASE_URL`];
    const apiKeyEnv = env[`GOLDPAN_LLM_PROVIDER_${rawId}_API_KEY_ENV`];
    if (!apiKeyEnv) {
      throw new Error(
        `GOLDPAN_LLM_PROVIDER_${rawId}_BASE_URL is set but GOLDPAN_LLM_PROVIDER_${rawId}_API_KEY_ENV is missing`,
      );
    }
    const parsed = customProviderSchema.parse({
      id,
      baseUrl,
      apiKeyEnv,
      models: allModels[id] ?? [],
    });
    if (!env[apiKeyEnv]) {
      throw new Error(
        `Custom LLM provider "${id}" references env var "${apiKeyEnv}" but it is not set`,
      );
    }
    return parsed;
  });
}
