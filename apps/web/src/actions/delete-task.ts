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

export type DeleteTaskState = {
  success?: boolean;
  error?: string;
};

export async function deleteTaskAction(
  _prevState: DeleteTaskState,
  formData: FormData,
): Promise<DeleteTaskState> {
  await requireAuth();
  const t = await getTranslations('actions');

  const taskId = parsePositiveIntField(formData, 'taskId');
  if (taskId === null) return { error: t('delete_task_invalid_id') };

  try {
    const client = await createServerClient();
    await client.deleteTask(taskId);
  } catch (err) {
    rethrowNextErrors(err);
    const key = pickApiErrorKey(err, [
      { status: 404, key: 'delete_task_not_found' },
      { code: 'is_processing', key: 'delete_task_is_processing' },
      { code: 'is_done', key: 'delete_task_is_done' },
    ] as const);
    if (key) return { error: t(key) };
    console.error('deleteTaskAction failed:', err);
    return { error: t('delete_task_failed') };
  }

  revalidatePath('/');
  return { success: true };
}
