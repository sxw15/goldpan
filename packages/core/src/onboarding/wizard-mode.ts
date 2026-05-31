import { lenientLoadConfig } from '../config';
import { parseCustomLlmProviders } from '../config/llm-providers';
import { missingKeyedProviders } from './provider-keys';

export type WizardReason =
  | { kind: 'forced' }
  | { kind: 'config_invalid'; errors: { path: (string | number)[]; message: string }[] }
  | { kind: 'missing_auth_password' }
  | { kind: 'no_provider_key'; referenced: string[] };

export function detectWizardMode(env: NodeJS.ProcessEnv = process.env): WizardReason | null {
  if (env.GOLDPAN_FORCE_WIZARD === 'true') {
    return { kind: 'forced' };
  }
  // 1. Try lenient (catches format errors)
  const lenient = lenientLoadConfig(env);
  if (!lenient.ok) {
    return {
      kind: 'config_invalid',
      errors: lenient.errors.map((e) => ({
        path: e.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
        message: e.message,
      })),
    };
  }
  // 2. Production must have auth password
  if (lenient.parsed.NODE_ENV === 'production' && !lenient.parsed.GOLDPAN_AUTH_PASSWORD) {
    return { kind: 'missing_auth_password' };
  }
  // 3. Every keyed provider referenced by the config must have its own key.
  // Use parsed values so envSchema defaults (including optional features when
  // enabled) are counted exactly as normal mode will see them.
  const parsed = lenient.parsed;
  const modelIds = [
    parsed.GOLDPAN_LLM_CLASSIFIER,
    parsed.GOLDPAN_LLM_EXTRACTOR,
    parsed.GOLDPAN_LLM_MATCHER,
    parsed.GOLDPAN_LLM_COMPARATOR,
    parsed.GOLDPAN_LLM_INTENT,
    parsed.GOLDPAN_LLM_QUERY,
    ...(parsed.GOLDPAN_LLM_VERIFIER_ENABLED === 'true' ? [parsed.GOLDPAN_LLM_VERIFIER] : []),
    ...(parsed.GOLDPAN_RELATION_ENABLED === 'true' ? [parsed.GOLDPAN_LLM_RELATOR] : []),
    ...(parsed.GOLDPAN_DIGEST_ENABLED === 'true'
      ? [parsed.GOLDPAN_LLM_DIGEST_SUMMARY, parsed.GOLDPAN_LLM_DIGEST_ACTION]
      : []),
    ...(parsed.GOLDPAN_EMBEDDING_ENABLED === 'true' ? [parsed.GOLDPAN_EMBEDDING_MODEL] : []),
  ];
  // 自定义 provider 走 GOLDPAN_LLM_PROVIDER_<ID>_* env（base url + api key env
  // name + 实际 key）。不解析这些就把 sensenova 这类 fully-configured 的自定义
  // provider 误判为 missing —— wizard commit 落库后重启又会再次进 wizard，死循环。
  // parseCustomLlmProviders 在 env 部分声明（BASE_URL 没配 API_KEY_ENV、或引用
  // 的 key var 没值）时 throw —— 此时留空数组，让 missingKeyedProviders 把对应
  // provider 报为 missing，wizard 重新渲染让用户修。
  let customProviders: ReturnType<typeof parseCustomLlmProviders> = [];
  try {
    customProviders = parseCustomLlmProviders(env);
  } catch {
    // intentional fallthrough — see comment above
  }
  const missing = missingKeyedProviders(modelIds, env, { customProviders });
  if (missing.length > 0) {
    return { kind: 'no_provider_key', referenced: missing };
  }
  return null;
}
