import { z } from 'zod';

export const RELATION_TYPES = [
  'organizational',
  'competitive',
  'collaborative',
  'technical',
  'causal',
  'general',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

/** Single relation between two entities — passthrough tolerates extra LLM fields */
export const relationItemSchema = z
  .object({
    sourceEntityKey: z.string().min(1),
    targetEntityKey: z.string().min(1),
    relationType: z.enum(RELATION_TYPES),
    description: z.string().min(1).max(500),
  })
  .passthrough();

export type RelationItem = z.infer<typeof relationItemSchema>;

/** Relating step complete output — passthrough tolerates extra top-level fields from LLM */
export const relatingSchema = z
  .object({
    relations: z.array(relationItemSchema).max(30),
  })
  .passthrough();

export type RelatingOutput = z.infer<typeof relatingSchema>;
