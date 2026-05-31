import { z } from 'zod';
import {
  FALLBACK_INTENTS,
  INTENT_NOTE_SUBTYPES,
  LLM_CLARIFY_OPTION_KEYS,
  LLM_CLARIFY_QUESTIONS,
  WAIT_REASONS,
} from './types';

/**
 * Create a dynamic Zod schema for intent classification based on registered intent names.
 * Throws if intentNames is empty — at least one IntentPlugin must be loaded.
 *
 * v2: returns a discriminatedUnion on `decision` (execute / wait / clarify).
 * See ./types.ts for the TS-level type expressing the same shape.
 */
export function createIntentSchema(intentNames: string[]) {
  if (intentNames.length === 0) {
    throw new Error('No intent names registered — at least one IntentPlugin must be loaded');
  }

  // 任意 decision 都可携带的关联字段
  const LinkedFields = z.object({
    linkedSourceId: z.number().int().positive().nullable().optional(),
    relatedTo: z
      .object({
        messageId: z.number().int().positive(),
        hintKey: z.enum(['comment', 'followup', 'quotation', 'correction', 'other']).optional(),
      })
      .nullable()
      .default(null),
  });

  // B3 修复：每个 variant 加 .strict() —— LLM 把 fallbackIntent 输出到 execute
  // 分支（或反过来）会被 schema reject 而不是 silent strip。clarifyOptions 内层
  // 的 option 对象也加 .strict() 防 LLM 多输出 'label' 等字段。
  return z.discriminatedUnion('decision', [
    z
      .object({
        decision: z.literal('execute'),
        intent: z.enum(intentNames as [string, ...string[]]),
        noteSubtype: z.enum(INTENT_NOTE_SUBTYPES).optional(),
        deferredEntityResolution: z.boolean().optional(),
        ...LinkedFields.shape,
      })
      .strict(),

    z
      .object({
        decision: z.literal('wait'),
        intent: z.enum(intentNames as [string, ...string[]]),
        fallbackIntent: z.enum(FALLBACK_INTENTS),
        maxWaitMs: z.number().int().positive().max(120000).default(30000),
        waitReason: z.enum(WAIT_REASONS),
        ...LinkedFields.shape,
      })
      .strict(),

    z
      .object({
        decision: z.literal('clarify'),
        // LLM 只能输出原 3 个分歧 key；P4 的 tracking_resolve_entity 仅 deferredResolver
        // 内部用，schema 这里拒绝让幻觉漏到 classifier 路径。
        clarifyQuestionKey: z.enum(LLM_CLARIFY_QUESTIONS),
        clarifyOptions: z
          .array(
            z
              .object({
                // 同上：LLM 不能选 resolve_tracking_entity，只能是 6 个 user-driven intent。
                intentKey: z.enum(LLM_CLARIFY_OPTION_KEYS),
                payload: z.string().optional(),
              })
              .strict(),
          )
          .min(2)
          .max(4),
        ...LinkedFields.shape,
      })
      .strict(),
  ]);
}

// IntentResult 旧名保留以减少调用方 import diff；新代码用 IntentDecision 名（在 types.ts）
export type IntentResult = z.infer<ReturnType<typeof createIntentSchema>>;
