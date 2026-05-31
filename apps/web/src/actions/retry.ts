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

export type RetryState = {
  success?: boolean;
  error?: string;
};

export async function retryAction(_prevState: RetryState, formData: FormData): Promise<RetryState> {
  await requireAuth();
  const t = await getTranslations('actions');

  const taskId = parsePositiveIntField(formData, 'taskId');
  if (taskId === null) return { error: t('retry_invalid_id') };

  try {
    const client = await createServerClient();
    await client.retryTask(taskId);
  } catch (err) {
    rethrowNextErrors(err);
    const key = pickApiErrorKey(err, [
      { status: 404, key: 'retry_not_found' },
      { code: 'not_found', key: 'retry_not_found' },
      { code: 'not_failed', key: 'retry_not_failed' },
      { code: 'not_retryable', key: 'retry_not_retryable' },
      { code: 'source_not_found', key: 'retry_source_not_found' },
      { code: 'source_conflict', key: 'retry_source_conflict' },
    ] as const);
    if (key) return { error: t(key) };
    console.error('retryTask failed:', err);
    return { error: t('retry_failed') };
  }

  revalidatePath('/');
  return { success: true };
}
