import type { ConversationMessage } from '@goldpan/web-sdk';
import { GoldpanApiError } from '@goldpan/web-sdk';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ChatView } from '@/components/chat/chat-view';
import { PrivacyNotice } from '@/components/privacy-notice';
import { createServerClient } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { parseConversationId } from '@/lib/url';

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; deleted?: string; q?: string; reclassifyFallback?: string }>;
}) {
  await requireAuth();
  const tMeta = await getTranslations('metadata');
  const { c, deleted, q, reclassifyFallback } = await searchParams;
  const convId = parseConversationId(c);
  const showDeletedNotice = deleted === '1';
  const showReclassifyFallbackNotice = reclassifyFallback === '1';

  const client = await createServerClient();

  let initialConversation: {
    id: number;
    messages: ConversationMessage[];
    archived: boolean;
  } | null = null;
  let status: Awaited<ReturnType<typeof client.getStatus>>;

  if (convId !== null) {
    // Conversation fetch + status are independent — fire concurrently. allSettled
    // so a 404/403 on the conversation can be redirected to '/' without losing
    // the (possibly already in-flight) status response on the success branch.
    const [convResult, statusResult] = await Promise.allSettled([
      client.getConversation(convId),
      client.getStatus(),
    ]);
    if (convResult.status === 'rejected') {
      const err = convResult.reason;
      if (err instanceof GoldpanApiError && (err.status === 404 || err.status === 403)) {
        redirect('/');
      }
      throw err;
    }
    if (statusResult.status === 'rejected') throw statusResult.reason;
    const detail = convResult.value;
    initialConversation = {
      id: detail.id,
      messages: detail.messages,
      archived: detail.archivedAt !== null,
    };
    status = statusResult.value;
  } else {
    // Sequence active-id then status: the redirect path is the common case
    // (user lands on / with an existing conversation), and parallelizing
    // would burn one /status RPC per redirected page load. Only fetch
    // status when we actually need it for the empty-state render below.
    const active = await client.getActiveConversationId('web');
    if (active.id !== null) {
      // Active-conversation redirect must preserve the prefill query string —
      // otherwise the `?q=` from a Library suggestion card gets dropped on
      // the way home and the textarea ends up empty.
      const params = new URLSearchParams();
      params.set('c', String(active.id));
      if (showDeletedNotice) params.set('deleted', '1');
      if (showReclassifyFallbackNotice) params.set('reclassifyFallback', '1');
      if (q) params.set('q', q);
      redirect(`/?${params.toString()}`);
    }
    status = await client.getStatus();
  }

  // Cap server-side too — even though the client also caps, an oversized URL
  // wastes bandwidth + adds attack surface. Match the runtime limit so the
  // suggestion-card prefills can never trigger client-side rejection.
  const prefillQuery =
    q && typeof q === 'string' ? q.slice(0, status.config.maxTextInputLength) : undefined;

  return (
    <div className="gp-feed-page gp-feed-stack">
      <h1 className="gp-sr-only">{tMeta('app_title')}</h1>
      <PrivacyNotice />
      <ChatView
        key={initialConversation?.id ?? 'empty'}
        maxInputLength={status.config.maxTextInputLength}
        initialConversation={initialConversation}
        showDeletedNotice={showDeletedNotice}
        showReclassifyFallbackNotice={showReclassifyFallbackNotice}
        prefillQuery={prefillQuery}
      />
    </div>
  );
}
