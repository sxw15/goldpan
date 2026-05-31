import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const SiteSchema = z.object({
  name: z.string().min(1),
  hosts: z.array(z.string().min(1)).min(1).readonly(),
});
const ConfigSchema = z.object({ sites: z.array(SiteSchema).min(1) });

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, 'supported-sites.json'), 'utf-8');
const parsed = ConfigSchema.parse(JSON.parse(raw));

export type SupportedSite = z.infer<typeof SiteSchema>;
export const SUPPORTED_SITES: readonly SupportedSite[] = Object.freeze(parsed.sites);

export function findSupportedSite(host: string): SupportedSite | undefined {
  if (!host) return undefined;
  const lower = host.toLowerCase();
  for (const site of SUPPORTED_SITES) {
    for (const candidate of site.hosts) {
      if (lower === candidate) return site;
      if (lower.length > candidate.length + 1 && lower.endsWith(`.${candidate}`)) {
        return site;
      }
    }
  }
  return undefined;
}

export function isSupportedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return findSupportedSite(parsed.host) !== undefined;
  } catch {
    return false;
  }
}
