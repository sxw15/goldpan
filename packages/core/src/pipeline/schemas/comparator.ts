import { z } from 'zod';

/** Comparing step LLM output (per-entity call) */
export const comparingLlmSchema = z.object({
  summary: z.string().max(2000).optional(),
  pointJudgments: z
    .array(
      z.object({
        pointKey: z.string().min(1),
        judgment: z.enum(['new', 'skipped']),
        matchedPointId: z.preprocess((v) => {
          if (v == null || v === '' || (typeof v === 'string' && v.trim() === '')) return null;
          const num = Number(v);
          return Number.isNaN(num) ? null : num;
        }, z.number().nullable()),
        matchedContent: z.string().max(2000).nullable(),
      }),
    )
    .min(1)
    .max(50),
});

export type ComparingLlmOutput = z.infer<typeof comparingLlmSchema>;

/*
comparingLlmSchema → JSON Schema:
{
  "type": "object",
  "properties": {
    "summary": { "type": "string", "maxLength": 2000 },                                                      // optional
    "pointJudgments": {
      "type": "array",
      "maxItems": 50,
      "items": {
        "type": "object",
        "properties": {
          "pointKey":       { "type": "string", "minLength": 1 },
          "judgment":       { "type": "string", "enum": ["new", "skipped"] },
          "matchedPointId": { "anyOf": [{ "type": "number" }, { "type": "null" }] },
          "matchedContent": { "anyOf": [{ "type": "string", "maxLength": 2000 }, { "type": "null" }] }
        },
        "required": ["pointKey", "judgment", "matchedPointId", "matchedContent"],
        "additionalProperties": false
      }
    }
  },
  "required": ["pointJudgments"],
  "additionalProperties": false
}
*/
