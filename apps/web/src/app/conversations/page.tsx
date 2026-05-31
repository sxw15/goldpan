import type { ConversationSummary } from '@goldpan/web-sdk';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ConversationsListClient } from '@/components/conversations/conversations-list-client';
import { createServerClient, rethrowNextErrors } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { parseFocusId } from '@/lib/url';

const PAGE_SIZE = 20;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return { title: t('page_conversations') };
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requireAuth();
  const { page: pageStr } = await searchParams;
  const page = parseFocusId(pageStr) ?? 1;
  const offset = (page - 1) * PAGE_SIZE;

  const client = await createServerClient();
  let items: ConversationSummary[] = [];
  let total = 0;
  try {
    const res = await client.listConversations({
      channelId: 'web',
      limit: PAGE_SIZE,
      offset,
      includeActive: false,
    });
    items = res.items;
    total = res.total;
  } catch (err) {
    rethrowNextErrors(err);
    console.error('[conversations] list failed:', err);
  }

  const tMeta = await getTranslations('metadata');
  return (
    <main className="gp-conversations">
      <h1 className="gp-conversations__title">{tMeta('page_conversations')}</h1>
      <ConversationsListClient items={items} total={total} page={page} pageSize={PAGE_SIZE} />
    </main>
  );
}
