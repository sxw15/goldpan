import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAuth } from '@/lib/auth';
import { TaskDebugClient } from './task-debug-client';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ taskId: string }>;
}): Promise<Metadata> {
  const { taskId } = await params;
  const t = await getTranslations('metadata');
  return { title: t('page_debug_task', { id: taskId }) };
}

export default async function TaskDebugPage({ params }: { params: Promise<{ taskId: string }> }) {
  await requireAuth();
  const { taskId } = await params;
  const id = parseInt(taskId, 10);
  if (!Number.isInteger(id) || id <= 0) notFound();

  return (
    <div className="gp-debug">
      <TaskDebugClient taskId={id} />
    </div>
  );
}
