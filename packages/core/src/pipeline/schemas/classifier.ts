import { z } from 'zod';

/** URL input classification (inputType already known from rule detection) */
export const urlClassificationSchema = z.object({
  categoryPath: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1).max(5),
});

/** Non-URL input classification (LLM determines inputType) */
export const textClassificationSchema = z.object({
  inputType: z.enum(['text', 'opinion']),
  categoryPath: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1).max(5),
});

export type UrlClassification = z.infer<typeof urlClassificationSchema>;
export type TextClassification = z.infer<typeof textClassificationSchema>;

/*
urlClassificationSchema → JSON Schema:
{
  "type": "object",
  "properties": {
    "categoryPath":  { "type": "string", "minLength": 1 },
    "keywords":      { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1, "maxItems": 5 }
  },
  "required": ["categoryPath", "keywords"],
  "additionalProperties": false
}

textClassificationSchema → JSON Schema:
{
  "type": "object",
  "properties": {
    "inputType":     { "type": "string", "enum": ["text", "opinion"] },
    "categoryPath":  { "type": "string", "minLength": 1 },
    "keywords":      { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1, "maxItems": 5 }
  },
  "required": ["inputType", "categoryPath", "keywords"],
  "additionalProperties": false
}
*/
