/**
 * `provider:model` 字符串完整性校验 —— 与 core/config 里 `modelIdSchema`
 * 的 zod refine 同款规则（colon 必须在中间，两边都非空）。pipeline /
 * embedding 步骤的 Next 按钮和 commit-time 校验复用，避免半成品 `'openai:'`
 * 这种字符串落到 `.env`（loadConfig 会因 zod parse 失败让 server 起不来）。
 */
export function hasCompleteModelId(model: string | undefined): boolean {
  if (!model) return false;
  const colonIdx = model.indexOf(':');
  return colonIdx > 0 && colonIdx < model.length - 1;
}
