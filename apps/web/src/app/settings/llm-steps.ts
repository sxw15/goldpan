import type { ManagedEnvKey } from '@goldpan/web-sdk';

/**
 * One pipeline step that the settings UI exposes for editing. `LLM_STEPS`
 * is consumed by the LLM settings card matrix (data-driven row rendering),
 * and `defaultProviderModel` must stay in lockstep with the zod schema
 * default in `packages/core/src/config/index.ts` — a `sync-llm-steps.mjs`
 * lint guard checks this on every `pnpm lint`.
 */
/** Where this LLM call sits in the system — drives section grouping in the
 * settings UI. The old tab name "Pipeline 模型分配" mixed pipeline / query /
 * digest into one list, which read as a flat dump; splitting by category lets
 * each section get its own short description ("内容入库" / "用户问答" /
 * "日报调度") instead of cramming all 10 rows under one heading. */
export type LlmStepCategory = 'pipeline' | 'query' | 'digest';

export interface LlmStepDef {
  /** Stable id used as i18n key suffix (`settings.llm.steps.<id>.{label,hint}`). */
  id: string;
  /** Semantic grouping; same `category` rows render together with one heading. */
  category: LlmStepCategory;
  /** Managed env key holding the `<provider>:<model>` value. */
  envKey: ManagedEnvKey;
  /**
   * Managed env key holding the per-step timeout override (seconds, integer).
   * Empty / unset → falls back to the global `GOLDPAN_LLM_TIMEOUT`. UI uses the
   * global value as the input placeholder so users see what the current
   * effective fallback is.
   */
  timeoutEnvKey: ManagedEnvKey;
  /** zod schema default — must equal the value in core config. */
  defaultProviderModel: string;
  /** Present when the step is gated by an enabled flag. */
  conditional?: {
    /** The boolean env key controlling this step. */
    enabledEnvKey: ManagedEnvKey;
    /**
     * `true` for verifier / relator — toggle UI lives inline on this row.
     * `false` for digest_summary / digest_action — toggle lives in the digest
     * group; this row only shows a disabled hint pointing the user there.
     */
    inlineToggle: boolean;
    /**
     * `true` when toggling the enable flag on requires a server restart
     * (digest_*: GOLDPAN_DIGEST_ENABLED is in STATIC_RESTART_REQUIRED_KEYS).
     * `false` for verifier / relator — pipeline reads `ctx.config` per task,
     * so the new effective snapshot kicks in on the next pipeline run.
     */
    restartOnEnable: boolean;
  };
}

/** Definition order matters: rendered top-to-bottom within each category so
 * the pipeline section follows the actual 9-step pipeline order (classify →
 * extract → match → relate → compare → verify). Don't reshuffle without
 * checking that the natural narrative still reads correctly. */
export const LLM_STEPS: ReadonlyArray<LlmStepDef> = [
  {
    id: 'classifier',
    category: 'pipeline',
    envKey: 'GOLDPAN_LLM_CLASSIFIER',
    timeoutEnvKey: 'GOLDPAN_LLM_CLASSIFIER_TIMEOUT',
    defaultProviderModel: 'openai:gpt-4o-mini',
  },
  {
    id: 'extractor',
    category: 'pipeline',
    envKey: 'GOLDPAN_LLM_EXTRACTOR',
    timeoutEnvKey: 'GOLDPAN_LLM_EXTRACTOR_TIMEOUT',
    defaultProviderModel: 'anthropic:claude-sonnet-4-20250514',
  },
  {
    id: 'matcher',
    category: 'pipeline',
    envKey: 'GOLDPAN_LLM_MATCHER',
    timeoutEnvKey: 'GOLDPAN_LLM_MATCHER_TIMEOUT',
    defaultProviderModel: 'anthropic:claude-sonnet-4-20250514',
  },
  {
    id: 'relator',
    category: 'pipeline',
    envKey: 'GOLDPAN_LLM_RELATOR',
    timeoutEnvKey: 'GOLDPAN_LLM_RELATOR_TIMEOUT',
    defaultProviderModel: 'openai:gpt-4o-mini',
    conditional: {
      enabledEnvKey: 'GOLDPAN_RELATION_ENABLED',
      inlineToggle: true,
      restartOnEnable: false,
    },
  },
  {
    id: 'comparator',
    category: 'pipeline',
    envKey: 'GOLDPAN_LLM_COMPARATOR',
    timeoutEnvKey: 'GOLDPAN_LLM_COMPARATOR_TIMEOUT',
    defaultProviderModel: 'anthropic:claude-sonnet-4-20250514',
  },
  {
    id: 'verifier',
    category: 'pipeline',
    envKey: 'GOLDPAN_LLM_VERIFIER',
    timeoutEnvKey: 'GOLDPAN_LLM_VERIFIER_TIMEOUT',
    defaultProviderModel: 'openai:gpt-4o-mini',
    conditional: {
      enabledEnvKey: 'GOLDPAN_LLM_VERIFIER_ENABLED',
      inlineToggle: true,
      restartOnEnable: false,
    },
  },
  {
    id: 'translator',
    category: 'pipeline',
    envKey: 'GOLDPAN_LLM_TRANSLATOR',
    timeoutEnvKey: 'GOLDPAN_LLM_TRANSLATOR_TIMEOUT',
    defaultProviderModel: 'openai:gpt-4o-mini',
    conditional: {
      enabledEnvKey: 'GOLDPAN_TRANSLATE_PIPELINE_OUTPUT',
      // 同时也在「外观与语言」组里有一个开关 —— 两处共用同一个 envKey，dirty
      // state 自动同步。让 LLM 设置页能就地切换（与 verifier / relator 一致），
      // 外观页保留入口是因为「语言 + 翻译」对用户心智更近。
      inlineToggle: true,
      restartOnEnable: false,
    },
  },
  {
    id: 'intent',
    category: 'query',
    envKey: 'GOLDPAN_LLM_INTENT',
    timeoutEnvKey: 'GOLDPAN_LLM_INTENT_TIMEOUT',
    defaultProviderModel: 'openai:gpt-4o-mini',
  },
  {
    id: 'query',
    category: 'query',
    envKey: 'GOLDPAN_LLM_QUERY',
    timeoutEnvKey: 'GOLDPAN_LLM_QUERY_TIMEOUT',
    defaultProviderModel: 'anthropic:claude-sonnet-4-20250514',
  },
  {
    id: 'digest_summary',
    category: 'digest',
    envKey: 'GOLDPAN_LLM_DIGEST_SUMMARY',
    timeoutEnvKey: 'GOLDPAN_LLM_DIGEST_SUMMARY_TIMEOUT',
    defaultProviderModel: 'anthropic:claude-sonnet-4-20250514',
    conditional: {
      enabledEnvKey: 'GOLDPAN_DIGEST_ENABLED',
      inlineToggle: false,
      restartOnEnable: true,
    },
  },
  {
    id: 'digest_action',
    category: 'digest',
    envKey: 'GOLDPAN_LLM_DIGEST_ACTION',
    timeoutEnvKey: 'GOLDPAN_LLM_DIGEST_ACTION_TIMEOUT',
    defaultProviderModel: 'openai:gpt-4o-mini',
    conditional: {
      enabledEnvKey: 'GOLDPAN_DIGEST_ENABLED',
      inlineToggle: false,
      restartOnEnable: true,
    },
  },
];

/** Stable iteration order for the matrix sections — drives both the rendered
 * order in llm.tsx and the type of the section description i18n keys. */
export const LLM_STEP_CATEGORY_ORDER: ReadonlyArray<LlmStepCategory> = [
  'pipeline',
  'query',
  'digest',
];
