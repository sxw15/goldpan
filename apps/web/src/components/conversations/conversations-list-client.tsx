'use client';

import type { ConversationSummary } from '@goldpan/web-sdk';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useConfirm } from '@/components/confirm-provider';
import { StateEmpty } from '@/components/state/state-empty';
import { useTz } from '@/components/tz-provider';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { formatRelativeTime } from '@/lib/format';

interface ConversationsListClientProps {
  items: ConversationSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export function ConversationsListClient({
  items,
  total,
  page,
  pageSize,
}: ConversationsListClientProps) {
  const t = useTranslations('conversations');
  const tCommon = useTranslations('common');
  const tTime = useTranslations('time');
  const tz = useTz();
  const router = useRouter();
  const confirm = useConfirm();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const handleContinue = (id: number) => {
    router.push(`/?c=${id}`);
  };

  const handleDelete = async (item: ConversationSummary) => {
    if (
      !(await confirm({
        message: t('delete_confirm'),
        confirmLabel: tCommon('delete'),
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await getBrowserApiClient().deleteConversation(item.id);
      router.refresh();
    } catch {
      setErrorMsg(t('delete_error'));
    }
  };

  if (items.length === 0) {
    if (page > 1) {
      return (
        <StateEmpty
          title={t('empty_later_page')}
          action={<Link href="/conversations?page=1">{t('back_to_first_page')}</Link>}
        />
      );
    }
    return <StateEmpty title={t('empty_title')} description={t('empty_description')} />;
  }

  return (
    <div>
      {errorMsg && <div className="gp-conversations__error">{errorMsg}</div>}
      <ul className="gp-conversations-list">
        {items.map((item) => {
          const title = item.title ?? t('list_title_fallback', { id: item.id });
          const timeStr = formatRelativeTime(item.lastMessageAt ?? item.updatedAt, tTime, tz);
          return (
            <li key={item.id} className="gp-conversations-list__item">
              <div className="gp-conversations-list__title">{title}</div>
              <div className="gp-conversations-list__meta">
                {t('row_meta', { count: item.messageCount, time: timeStr })}
              </div>
              <div className="gp-conversations-list__actions">
                <button
                  type="button"
                  className="gp-btn gp-conversations-list__continue-btn"
                  data-variant="ghost"
                  onClick={() => handleContinue(item.id)}
                >
                  {t('continue_button')}
                </button>
                <button
                  type="button"
                  className="gp-btn gp-conversations-list__delete-btn"
                  data-variant="ghost"
                  onClick={() => handleDelete(item)}
                >
                  {t('delete_button')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <nav className="gp-conversations-list__pagination" aria-label={t('pagination_aria')}>
        {page > 1 ? (
          <Link href={`/conversations?page=${page - 1}`}>{t('pagination_prev')}</Link>
        ) : (
          <span className="gp-conversations-list__pagination-disabled">{t('pagination_prev')}</span>
        )}
        <span>{t('pagination_info', { page, total: totalPages })}</span>
        {page < totalPages ? (
          <Link href={`/conversations?page=${page + 1}`}>{t('pagination_next')}</Link>
        ) : (
          <span className="gp-conversations-list__pagination-disabled">{t('pagination_next')}</span>
        )}
      </nav>
    </div>
  );
}
