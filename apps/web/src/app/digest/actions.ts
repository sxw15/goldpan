'use server';
import { type DigestSnapshotResponse, GoldpanApiError } from '@goldpan/web-sdk';
import { createServerClient, isPluginDisabled, rethrowNextErrors } from '@/lib/api';

export type DigestPreviewActionResult =
  | { ok: true; preview: DigestSnapshotResponse | null }
  | { ok: false; code: string; message: string };

async function requestDigestPreview(params: {
  channel: string;
  presetId?: number;
  date?: string | null;
  forceRegenerate?: boolean;
}): Promise<DigestPreviewActionResult> {
  const client = await createServerClient();
  try {
    const preview = await client.getDigestPreview({
      channel: params.channel,
      ...(params.presetId !== undefined ? { presetId: params.presetId } : {}),
      ...(params.date ? { date: params.date } : {}),
      ...(params.forceRegenerate ? { forceRegenerate: true } : {}),
    });
    return { ok: true, preview };
  } catch (err) {
    rethrowNextErrors(err);
    if (err instanceof GoldpanApiError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return {
      ok: false,
      code: 'unknown',
      message: err instanceof Error ? err.message : 'Failed to load digest preview',
    };
  }
}

/**
 * Cached preview read — used by the preset dropdown. Re-renders the same
 * stored snapshot with the new preset's slot order / skipEmpty policy,
 * without re-running module collection or the AI-summary LLM call. Preset
 * switches that forced regeneration were burning one LLM call per dropdown
 * change, multiplying cost without giving the user new data.
 */
export async function previewDigest(
  channel: string,
  presetId?: number,
  date?: string | null,
): Promise<DigestPreviewActionResult> {
  return requestDigestPreview({ channel, presetId, date });
}

/**
 * Force a fresh snapshot + preview render on the server. Passes
 * `forceRegenerate=true` so the digest engine re-collects modules and
 * re-writes `daily_reports` instead of returning the cached snapshot.
 * Bound to the explicit "Regenerate" button only — preset switching goes
 * through {@link previewDigest} above so dropdown interactions do not
 * trigger repeated LLM calls.
 *
 * `date` is threaded through so the historical-view stays pinned on
 * regenerate. Passing `null` (or omitting) falls back to the server-side
 * "yesterday UTC" default, matching the initial page load. Re-throws Next
 * internal errors (redirect/notFound) so auth failures still trigger
 * `/login` instead of silently degrading to an empty preview.
 */
export async function regenerateDigest(
  channel: string,
  presetId?: number,
  date?: string | null,
): Promise<DigestPreviewActionResult> {
  return requestDigestPreview({ channel, presetId, date, forceRegenerate: true });
}

export type DigestStatusActionResult =
  | { ok: true; enabled: true }
  | { ok: true; enabled: false; code: string; message: string }
  | { ok: false; code: string; message: string };

export type DigestShareLinkActionResult =
  | { ok: true; url: string; ttlDays: number }
  | { ok: false; code: string; message: string };

/**
 * Mint a signed read-only share URL on the server. The route returns 503
 * `share_link_disabled` when `GOLDPAN_DIGEST_LINK_SIGNING_KEY` /
 * `GOLDPAN_DIGEST_PUBLIC_BASE_URL` are not configured; the UI maps that to a
 * dedicated "set these env vars" message instead of a generic failure toast.
 */
export async function createDigestShareLink(input: {
  channel: string;
  date: string;
  presetId: number | null;
}): Promise<DigestShareLinkActionResult> {
  const client = await createServerClient();
  try {
    const res = await client.createDigestShareLink({
      channel: input.channel,
      date: input.date,
      presetId: input.presetId,
    });
    return { ok: true, url: res.url, ttlDays: res.ttlDays };
  } catch (err) {
    rethrowNextErrors(err);
    if (err instanceof GoldpanApiError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return {
      ok: false,
      code: 'unknown',
      message: err instanceof Error ? err.message : 'Failed to create share link',
    };
  }
}

/**
 * Probe whether the digest plugin is enabled by attempting to list presets.
 * Used by the disabled-state "Re-check" button so users can test their
 * .env edits without a manual page reload. 503 plugin_disabled → enabled:
 * false (expected); other errors bubble as ok:false so the UI can show an
 * unexpected-failure state.
 */
export async function probeDigestStatus(channel: string): Promise<DigestStatusActionResult> {
  const client = await createServerClient();
  try {
    await client.listDigestPresets(channel);
    return { ok: true, enabled: true };
  } catch (err) {
    rethrowNextErrors(err);
    if (isPluginDisabled(err)) {
      return { ok: true, enabled: false, code: err.code, message: err.message };
    }
    if (err instanceof GoldpanApiError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return {
      ok: false,
      code: 'unknown',
      message: err instanceof Error ? err.message : 'Failed to probe digest status',
    };
  }
}
