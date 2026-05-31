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

export type ClearLogsState = {
  success?: boolean;
  error?: string;
};

export async function clearLogsAction(
  _prevState: ClearLogsState,
  formData: FormData,
): Promise<ClearLogsState> {
  await requireAuth();
  const t = await getTranslations('actions');

  const taskId = parsePositiveIntField(formData, 'taskId');
  if (taskId === null) return { error: t('clear_logs_invalid_id') };

  try {
    const client = await createServerClient();
    await client.clearTaskLogs(taskId);
  } catch (err) {
    rethrowNextErrors(err);
    const key = pickApiErrorKey(err, [{ status: 404, key: 'clear_logs_not_found' }] as const);
    if (key) return { error: t(key) };
    console.error('clearLogs failed:', err);
    return { error: t('clear_logs_failed') };
  }

  revalidatePath(`/tasks/${taskId}`);
  return { success: true };
}
