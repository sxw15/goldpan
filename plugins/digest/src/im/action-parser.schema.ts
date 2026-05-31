import { z } from 'zod';

/**
 * UTC HH:MM (24h). Hours 00–23, minutes 00–59. See comment in
 * `apps/server/src/routes/digest.ts` for why the naive `^\d{2}:\d{2}$` is
 * unsafe (silently normalizes into a different UTC day).
 */
const TIME_HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const ParsedActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('subscribe'),
    presetName: z.string().min(1),
    // 可选:用户没显式说"08:30 推送"时,handler 回退到 preset.pushTime。
    pushTime: z.string().regex(TIME_HHMM_RE).optional(),
  }),
  z.object({
    kind: z.literal('unsubscribe'),
    presetName: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal('list') }),
  z.object({
    kind: z.literal('pause'),
    presetName: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('resume'),
    presetName: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('set_push_time'),
    presetName: z.string().min(1).optional(),
    pushTime: z.string().regex(TIME_HHMM_RE),
  }),
]);

export type ParsedAction = z.infer<typeof ParsedActionSchema>;
