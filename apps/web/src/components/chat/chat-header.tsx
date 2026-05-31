'use client';

import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface ChatHeaderProps {
  onNewConversation: () => void;
  disabled: boolean;
  messageCount: number;
}

export function ChatHeader({ onNewConversation, disabled, messageCount }: ChatHeaderProps) {
  const t = useTranslations('chat');
  const label = t('new_conversation');
  return (
    <div className="gp-chat-header">
      <div className="gp-chat-header__title">
        <span className="gp-chat-header__title-name">{t('current_conversation')}</span>
        {messageCount > 0 && (
          <span className="gp-chat-header__title-meta">
            {t('messages_count', { count: messageCount })}
          </span>
        )}
      </div>
      <button
        type="button"
        className="gp-btn gp-chat-header__new"
        data-variant="ghost"
        onClick={onNewConversation}
        disabled={disabled}
        aria-label={label}
        title={label}
      >
        <Plus size={14} />
        <span>{label}</span>
      </button>
    </div>
  );
}
