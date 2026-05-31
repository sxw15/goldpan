import { z } from 'zod';

/** Extracting step output. Tags are only populated for opinion points (the
 * NoteBubbleCard surfaces them as hashtag chips) — fact extraction returns
 * empty arrays. The prompt enforces this, but tolerating tags on fact points
 * keeps the schema permissive against minor LLM drift. */
export const extractingSchema = z.object({
  points: z
    .array(
      z.object({
        content: z.string().min(1),
        type: z.enum(['fact', 'opinion']),
        tags: z.array(z.string().min(1).max(40)).max(8).optional().default([]),
      }),
    )
    .max(50),
});

export type ExtractingOutput = z.infer<typeof extractingSchema>;
