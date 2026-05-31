import { z } from 'zod';

export const AiSummaryPayload = z.object({
  headline: z.string().min(1).max(200),
  bullets: z.array(z.string().min(1).max(300)).min(1).max(5),
  closing: z.string().max(200).default(''),
});

export type AiSummaryPayloadT = z.infer<typeof AiSummaryPayload>;
