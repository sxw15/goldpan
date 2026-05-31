import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { createServerClient } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { DebugClient } from './debug-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return { title: t('page_debug') };
}

export default async function DebugPage() {
  await requireAuth();
  const client = await createServerClient();
  const { data: tasks } = await client.getTasks({ limit: 50 });
  return <DebugClient initialTasks={tasks} />;
}
