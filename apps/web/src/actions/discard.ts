'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import {
  createServerClient,
  parsePositiveIntField,
  pickApiErrorKey,
  rethrowNextErrors,
} from '@/lib/api';
import { requireAuth } from '@/lib/auth';

export type DiscardState = {
  success?: boolean;
  error?: string;
};

export async function discardAction(
  _prevState: DiscardState,
  formData: FormData,
): Promise<DiscardState> {
  await requireAuth();
  const t = await getTranslations('actions');

  const sourceId = parsePositiveIntField(formData, 'sourceId');
  if (sourceId === null) return { error: t('discard_invalid_id') };

  try {
    const client = await createServerClient();
    await client.discardSource(sourceId);
  } catch (err) {
    rethrowNextErrors(err);
    const key = pickApiErrorKey(err, [
      { code: 'invalid_status', key: 'discard_wrong_status' },
      { status: 404, key: 'discard_invalid_id' },
    ] as const);
    if (key) return { error: t(key) };
    console.error('discardAction failed:', err);
    return { error: t('discard_failed') };
  }

  revalidatePath('/');
  return { success: true };
}
