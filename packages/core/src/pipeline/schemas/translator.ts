import { z } from 'zod';

/**
 * Translator step output. Each input item carries an `id` (assigned by the
 * pipeline) and the LLM returns translations keyed by the same `id`. Items
 * with no translation back are quietly dropped — the storing step keeps the
 * original in those slots.
 */
export const translatingSchema = z.object({
  translations: z
    .array(
      z.object({
        id: z.string().min(1),
        translated: z.string().min(1),
      }),
    )
    .max(500),
});

export type TranslatingOutput = z.infer<typeof translatingSchema>;
