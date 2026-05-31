// apps/server/src/routes/onboarding/state.ts
import type http from 'node:http';
import { parseJsonBody, respond, respondError } from '../types.js';
import { readJsonBody } from './_body.js';

export interface WizardState {
  language?: 'en' | 'zh';
  timezone?: string;
  webEnabled?: boolean;
  authPassword?: string;
  providers: Record<
    string,
    {
      apiKey?: string;
      baseUrl?: string;
      /** Chat / completion model ids — emitted as `<ID>_MODELS` env on commit. */
      models?: string[];
      /**
       * Embedding model ids — emitted as `<ID>_EMBEDDING_MODELS` env on commit.
       * UI 上和 `models` 共用一份 row 列表，每行的 toggle 决定 model id 落到
       * 哪一栏（chat default / embedding when toggled）。chat 和 embedding 在真
       * 实模型层面集合互斥（OpenAI / Google / Ollama 各家如此），所以 toggle
       * 是单选语义就足够。
       */
      embeddingModels?: string[];
      /**
       * For OpenAI-compatible custom providers (id not in the BUILTIN list),
       * the env-var **name** that will hold the secret on commit. e.g. id
       * `together` → `apiKeyEnv = 'TOGETHER_API_KEY'`. Builtin providers don't
       * use this field — their secret env names are hardcoded in commit.ts.
       */
      apiKeyEnv?: string;
    }
  >;
  steps: Record<string, { model?: string; enabled?: boolean }>;
  digest?: {
    enabled: boolean;
    dailyTime?: string;
    maxItemsPerModule?: number;
    summaryModel?: string;
    actionModel?: string;
    modules: string[];
  };
  tracking?: {
    enabled: boolean;
    pollInterval?: number;
    dailyLimit?: number;
    searchProviders: string[];
    rules: Array<{
      name: string;
      searchQueries: string[];
      intervalMinutes: number;
      domains?: string[];
    }>;
  };
  /** Search-tool API keys (Tavily / Serper) collected on the tracking page. */
  searchKeys?: { tavily?: string; serper?: string };
  embedding?: {
    enabled: boolean;
    model?: string;
    dimensions?: number;
    batchSize?: number;
  };
  /**
   * IM channel configuration, keyed by channelId. Field shapes are determined
   * at commit time by walking the manifest registered for each channel —
   * here we only require that each value be a plain object with `enabled?`
   * and `fields?: Record<string, string>` (see PATCH validator below).
   */
  im?: Record<string, ImChannelWizardState | undefined>;
}

export interface ImChannelWizardState {
  enabled?: boolean;
  fields?: Record<string, string | undefined>;
}

type PrimitivePatch<T> = T | null | undefined;
type ProviderPatch = {
  apiKey?: PrimitivePatch<string>;
  baseUrl?: PrimitivePatch<string>;
  models?: string[] | null;
  embeddingModels?: string[] | null;
  apiKeyEnv?: PrimitivePatch<string>;
} | null;
type StepPatch = { model?: PrimitivePatch<string>; enabled?: PrimitivePatch<boolean> } | null;
type DigestPatch = {
  enabled?: PrimitivePatch<boolean>;
  dailyTime?: PrimitivePatch<string>;
  maxItemsPerModule?: PrimitivePatch<number>;
  summaryModel?: PrimitivePatch<string>;
  actionModel?: PrimitivePatch<string>;
  modules?: string[] | null;
} | null;
type EmbeddingPatch = {
  enabled?: PrimitivePatch<boolean>;
  model?: PrimitivePatch<string>;
  dimensions?: PrimitivePatch<number>;
  batchSize?: PrimitivePatch<number>;
} | null;

export interface WizardStatePatch {
  language?: PrimitivePatch<'en' | 'zh'>;
  timezone?: PrimitivePatch<string>;
  webEnabled?: PrimitivePatch<boolean>;
  authPassword?: PrimitivePatch<string>;
  providers?: Record<string, ProviderPatch>;
  steps?: Record<string, StepPatch>;
  digest?: DigestPatch;
  tracking?: Partial<WizardState['tracking']> | null;
  searchKeys?: { tavily?: PrimitivePatch<string>; serper?: PrimitivePatch<string> } | null;
  embedding?: EmbeddingPatch;
  im?: Record<
    string,
    { enabled?: boolean | null; fields?: Record<string, string | null | undefined> } | null
  > | null;
}

let state: WizardState = freshState();

function freshState(): WizardState {
  return { providers: {}, steps: {} };
}

export function getWizardState(): WizardState {
  return state;
}

export function patchWizardState(patch: WizardStatePatch): WizardState {
  validateWizardPatch(patch);
  state = mergeDeep(state, patch as Record<string, unknown>);
  return state;
}

export function resetWizardState(): void {
  state = freshState();
}

/**
 * Deep-merge `b` into `a` for plain-object fields. Arrays and primitives
 * replace whole-cloth — patching `tracking.rules` overwrites the array, not
 * appends. The `existing && typeof existing === 'object'` guard avoids
 * crashing when patching a previously-undefined nested object (e.g. patching
 * `providers.openai = {...}` when state had no `providers.openai` key).
 */
function mergeDeep<T>(a: T, b: Record<string, unknown>): T {
  const out = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b)) {
    if (v === null) {
      delete out[k];
      continue;
    }
    const existing = (a as Record<string, unknown>)[k];
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[k] = mergeDeep(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Top-level fields that accept `null` to clear (matched by mergeDeep, see line above).
 * Inner provider/step entries also use null-to-clear; that's enforced separately below.
 */
function validateNullableObject(name: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (!isPlainObject(value)) {
    throw new Error(`${name} must be an object or null`);
  }
}

function validateRecordObject(name: string, value: unknown): void {
  if (value !== undefined && !isPlainObject(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function validateWizardPatch(patch: WizardStatePatch): void {
  // providers / steps are Record<string, ...>: top-level must be a plain object,
  // entries can be null (deletes that provider / step). Top-level null is not
  // meaningful (replace whole map by sending {} or omit the key).
  validateRecordObject('providers', patch.providers);
  validateRecordObject('steps', patch.steps);
  // digest / tracking / searchKeys / embedding / im are nullable single objects:
  // null clears the whole subtree (mergeDeep deletes the key).
  validateNullableObject('digest', patch.digest);
  validateNullableObject('tracking', patch.tracking);
  validateNullableObject('searchKeys', patch.searchKeys);
  validateNullableObject('embedding', patch.embedding);
  validateNullableObject('im', patch.im);
  if (patch.providers) {
    for (const [provider, cfg] of Object.entries(patch.providers)) {
      if (cfg !== null && !isPlainObject(cfg)) {
        throw new Error(`providers.${provider} must be an object or null`);
      }
    }
  }
  if (patch.steps) {
    for (const [step, cfg] of Object.entries(patch.steps)) {
      if (cfg !== null && !isPlainObject(cfg)) {
        throw new Error(`steps.${step} must be an object or null`);
      }
    }
  }
  // 注意：`im` 的契约**不是** providers/steps 那种 Record（top-level 不能 null）。
  // 这里 top-level 通过 validateNullableObject — 即接受 `patch.im = null` 整体清
  // 空所有 channel 配置（mergeDeep 会 delete im 整个 key）。这是有意 deviation：
  // wizard 重置 IM 步骤需要"清空所有 channel"的语义，providers/steps 没有这个
  // 用例（重置语义走 step-level null）。
  //
  // 但 inner-entry shape 仍要校：a `PATCH {im: {feishu: "string"}}` 必须 reject —
  // mergeDeep 会写字符串当 channelState，下游 `state.im[channel].enabled` 读
  // undefined 静默失败。
  if (patch.im) {
    for (const [channelId, cfg] of Object.entries(patch.im)) {
      if (cfg !== null && !isPlainObject(cfg)) {
        throw new Error(`im.${channelId} must be an object or null`);
      }
    }
  }
}

export async function handleStateRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method === 'GET') {
    respond(res, 200, getWizardState());
    return;
  }
  if (req.method === 'PATCH') {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const parsed = parseJsonBody<WizardStatePatch>(res, body);
    if (parsed === null) return;
    try {
      patchWizardState(parsed);
    } catch (err) {
      respondError(
        res,
        400,
        'invalid_state_patch',
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    respond(res, 200, getWizardState());
    return;
  }
  respondError(res, 405, 'method_not_allowed', 'Use GET or PATCH');
}
