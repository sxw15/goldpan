/**
 * Builtin provider 的 model id 示例 —— **仅作为 textarea placeholder 使用**，
 * 让用户首次配置时知道这家 provider 的 model id 大致长啥样。**不**作为下拉
 * fallback：实际可选 model 完全由用户在 Provider 页自行编辑（写入
 * `GOLDPAN_LLM_PROVIDER_<ID>_MODELS` env），Pipeline 下拉只读这一份。
 *
 * 维护标准放低 —— 是 placeholder 不是真实清单：
 *  - 列 1-2 个当前主推就够，给用户复制思路；
 *  - 不必跟官方名录同步（user 觉得过时就自己改清单）；
 *  - ollama 留空（本地装了什么 placeholder 也没法猜）。
 */
export const BUILTIN_PROVIDER_MODEL_PLACEHOLDERS: Readonly<Record<string, string>> = {
  anthropic: 'claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001',
  openai: 'gpt-4o, gpt-4o-mini',
  google: 'gemini-2.0-flash, gemini-1.5-pro',
  deepseek: 'deepseek-v4-flash, deepseek-v4-pro',
  openrouter: 'anthropic/claude-sonnet-4, openai/gpt-4o-mini',
  ollama: 'llama3.2:8b, qwen2.5:7b',
};
