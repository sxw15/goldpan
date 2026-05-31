'use server';

import { type GithubRefreshResult, GoldpanApiError } from '@goldpan/web-sdk';
import { createServerClient, rethrowNextErrors } from '@/lib/api';
import { requireAuth } from '@/lib/auth';

export type RefreshGithubActionResult =
  | { ok: true; result: GithubRefreshResult }
  | { ok: false; code: string; message: string };

export async function refreshGithubByUrl(
  normalizedUrl: string,
): Promise<RefreshGithubActionResult> {
  await requireAuth();
  try {
    const client = await createServerClient();
    const result = await client.refreshGithubByUrl(normalizedUrl);
    return { ok: true, result };
  } catch (err) {
    rethrowNextErrors(err);
    if (err instanceof GoldpanApiError) {
      return { ok: false, code: err.code, message: err.message };
    }
    console.error('refreshGithubByUrl failed:', err);
    return { ok: false, code: 'unknown', message: (err as Error).message ?? 'Refresh failed' };
  }
}
