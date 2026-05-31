import type { ImChannelEnvSpec } from '@goldpan/im-runtime';
import { z } from 'zod';

/**
 * Merge each plugin's `envSchema` fragment into a single zod object, parse the
 * env once, then dispatch each plugin's `parse` to produce its private slice.
 *
 * Returns a `Map<channelId, slice>`. Server passes these slices into each
 * plugin's `goldpanIMRegistration(slice, resolver)`.
 *
 * Throws if zod parsing fails — boot must surface env mistakes loudly.
 */
export function loadImChannelConfigs(
  env: NodeJS.ProcessEnv,
  envSpecs: ReadonlyArray<ImChannelEnvSpec<unknown>>,
): Map<string, unknown> {
  const shape: z.ZodRawShape = {};
  for (const s of envSpecs) Object.assign(shape, s.envSchema);
  const parsed = z.object(shape).parse(env) as Record<string, unknown>;
  return new Map(envSpecs.map((s) => [s.channelId, s.parse(parsed)]));
}
