import type { ConversationSummary } from '@goldpan/web-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { ChatDefault } from './chat-default';

const messages = {
  chat: {
    welcome_greeting: '👋 今天想聊点什么',
    welcome_prompt: '试一下：',
    recent_label: '继续最近对话',
    recent_view_all: '查看全部 →',
  },
  conversations: {
    list_title_fallback: '对话 #{id}',
  },
  time: {
    just_now: '刚刚',
    minutes_ago: '{count} 分钟前',
    hours_ago: '{count} 小时前',
    yesterday: '昨天',
    days_ago: '{count} 天前',
  },
};

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="zh" messages={messages}>
      {ui}
    </NextIntlClientProvider>
  );
}

const makeItem = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 1,
  sessionKey: 'web:default',
  channelId: 'web',
  title: '示例对话',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastMessageAt: Date.now(),
  archivedAt: Date.now(),
  archivedReason: 'user_reset',
  messageCount: 2,
  ...overrides,
});

describe('<ChatDefault>', () => {
  it('renders welcome greeting + prompt', () => {
    render(wrap(<ChatDefault />));
    expect(screen.getByText('👋 今天想聊点什么')).toBeInTheDocument();
    expect(screen.getByText('试一下：')).toBeInTheDocument();
  });

  it('does not render recent block when list is empty', () => {
    render(wrap(<ChatDefault recentConversations={[]} />));
    expect(document.querySelector('.gp-chat-default__recent')).toBeNull();
  });

  it('does not render recent block when onRecentClick missing', () => {
    render(wrap(<ChatDefault recentConversations={[makeItem()]} />));
    expect(document.querySelector('.gp-chat-default__recent')).toBeNull();
  });

  it('renders recent items with titles + view-all link', () => {
    render(
      wrap(
        <ChatDefault
          recentConversations={[
            makeItem({ id: 1, title: '最近对话 A' }),
            makeItem({ id: 2, title: null }),
          ]}
          onRecentClick={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText('最近对话 A')).toBeInTheDocument();
    expect(screen.getByText('对话 #2')).toBeInTheDocument();
    const link = screen.getByText('查看全部 →');
    expect(link.getAttribute('href')).toBe('/conversations');
  });

  it('calls onRecentClick with id when recent item clicked', () => {
    const onClick = vi.fn();
    render(
      wrap(
        <ChatDefault
          recentConversations={[makeItem({ id: 9, title: 'T' })]}
          onRecentClick={onClick}
        />,
      ),
    );
    fireEvent.click(screen.getByText('T'));
    expect(onClick).toHaveBeenCalledWith(9);
  });

  it('disables recent buttons when recentDisabled=true', () => {
    render(
      wrap(
        <ChatDefault
          recentConversations={[makeItem({ id: 1, title: 'T' })]}
          onRecentClick={vi.fn()}
          recentDisabled
        />,
      ),
    );
    const btn = screen.getByText('T').closest('button');
    expect(btn?.hasAttribute('disabled')).toBe(true);
  });
});
