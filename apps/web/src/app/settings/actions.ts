'use server';
import type { CommitEnvResult, DigestPreset, ImActionResult } from '@goldpan/web-sdk';
import { createServerClient } from '@/lib/api';

export async function createPreset(
  channel: string,
  input: Omit<DigestPreset, 'id' | 'channel'>,
): Promise<{ preset: DigestPreset }> {
  const client = await createServerClient();
  return await client.createDigestPreset(channel, input);
}

export async function updatePreset(
  id: number,
  patch: Partial<Omit<DigestPreset, 'id' | 'channel'>>,
): Promise<{ preset: DigestPreset }> {
  const client = await createServerClient();
  return await client.updateDigestPreset(id, patch);
}

export async function deletePreset(
  id: number,
): Promise<{ ok: true } | { error: { code: 'preset_in_use'; usages: unknown[] } }> {
  const client = await createServerClient();
  return await client.deleteDigestPreset(id);
}

export async function commitEnv(patch: Record<string, string | null>): Promise<CommitEnvResult> {
  const client = await createServerClient();
  return await client.commitEnv(patch);
}

export async function runImAction(channelId: string, actionId: string): Promise<ImActionResult> {
  const client = await createServerClient();
  return await client.runImAction(channelId, actionId);
}
