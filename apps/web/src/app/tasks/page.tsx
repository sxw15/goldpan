import {
  GoldpanApiError,
  type Task,
  type TaskStatus,
  type TaskStatusCounts,
} from '@goldpan/web-sdk';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { createServerClient } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { TasksPageClient } from './tasks-page-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('tasks');
  return { title: t('list_page_title') };
}

const TASKS_LIMIT = 100;
const ZERO_COUNTS: TaskStatusCounts = { pending: 0, processing: 0, done: 0, error: 0 };
const VALID_STATUSES = new Set<TaskStatus>(['pending', 'processing', 'done', 'error']);

function parseStatusParam(raw: string | undefined): TaskStatus | undefined {
  if (!raw) return undefined;
  return VALID_STATUSES.has(raw as TaskStatus) ? (raw as TaskStatus) : undefined;
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAuth();
  const { status: statusRaw } = await searchParams;
  const initialFilter = parseStatusParam(statusRaw);

  const client = await createServerClient();
  let initialTasks: Task[] = [];
  let initialCounts: TaskStatusCounts = ZERO_COUNTS;
  let initialError: string | null = null;
  try {
    const result = await client.getTasks({
      limit: TASKS_LIMIT,
      status: initialFilter ? [initialFilter] : undefined,
    });
    initialTasks = result.data;
    initialCounts = result.counts;
  } catch (err) {
    initialError = err instanceof GoldpanApiError ? err.message : 'load_failed';
  }

  return (
    <TasksPageClient
      initialTasks={initialTasks}
      initialCounts={initialCounts}
      initialError={initialError}
      limit={TASKS_LIMIT}
    />
  );
}
