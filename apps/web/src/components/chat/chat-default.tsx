'use client';

import type { ConversationSummary } from '@goldpan/web-sdk';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useTz } from '@/components/tz-provider';
import { formatRelativeTime } from '@/lib/format';

interface ChatDefaultProps {
  recentConversations?: ConversationSummary[];
  onRecentClick?: (id: number) => void;
  recentDisabled?: boolean;
}

export function ChatDefault({
  recentConversations = [],
  onRecentClick,
  recentDisabled = false,
}: ChatDefaultProps) {
  const t = useTranslations('chat');
  const tConv = useTranslations('conversations');
  const tTime = useTranslations('time');
  const tz = useTz();

  return (
    <div className="gp-chat-default">
      <h1 className="gp-chat-default__greeting">{t('welcome_greeting')}</h1>
      <p className="gp-chat-default__prompt">{t('welcome_prompt')}</p>
      {recentConversations.length > 0 && onRecentClick && (
        <div className="gp-chat-default__recent">
          <p className="gp-chat-default__recent-label">{t('recent_label')}</p>
          <ul className="gp-chat-default__recent-list">
            {recentConversations.map((c) => {
              const title = c.title ?? tConv('list_title_fallback', { id: c.id });
              const time = formatRelativeTime(c.lastMessageAt ?? c.updatedAt, tTime, tz);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    className="gp-chat-default__recent-item"
                    onClick={() => onRecentClick(c.id)}
                    disabled={recentDisabled}
                  >
                    <span className="gp-chat-default__recent-title">{title}</span>
                    <span className="gp-chat-default__recent-time">{time}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <Link href="/conversations" className="gp-chat-default__recent-link">
            {t('recent_view_all')}
          </Link>
        </div>
      )}
    </div>
  );
}
