import type { ConversationSummary } from '@goldpan/web-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import zhMessages from '../../../messages/zh.json';
import { ConversationsListClient } from './conversations-list-client';

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));

vi.mock('@/components/confirm-provider', () => ({
  useConfirm: () => confirmMock,
  ConfirmProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const pushMock = vi.fn();
const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

const deleteMock = vi.fn();
vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({ deleteConversation: deleteMock }),
}));

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="zh" messages={zhMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const sampleItem = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 7,
  sessionKey: 'web:default',
  channelId: 'web',
  title: '首条消息内容',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastMessageAt: Date.now(),
  archivedAt: Date.now(),
  archivedReason: 'user_reset',
  messageCount: 3,
  ...overrides,
});

describe('ConversationsListClient', () => {
  beforeEach(() => {
    pushMock.mockReset();
    refreshMock.mockReset();
    deleteMock.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });

  it('renders items with title + meta', () => {
    renderWithIntl(
      <ConversationsListClient items={[sampleItem()]} total={1} page={1} pageSize={20} />,
    );
    expect(screen.getByText('首条消息内容')).toBeTruthy();
    expect(screen.getByText(/3 条消息/)).toBeTruthy();
  });

  it('falls back to "对话 #{id}" when title is null', () => {
    renderWithIntl(
      <ConversationsListClient
        items={[sampleItem({ title: null })]}
        total={1}
        page={1}
        pageSize={20}
      />,
    );
    expect(screen.getByText('对话 #7')).toBeTruthy();
  });

  it('continue pushes /?c=<id>', () => {
    renderWithIntl(
      <ConversationsListClient items={[sampleItem()]} total={1} page={1} pageSize={20} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(pushMock).toHaveBeenCalledWith('/?c=7');
  });

  it('delete confirm + refresh on success', async () => {
    deleteMock.mockResolvedValue(undefined);
    renderWithIntl(
      <ConversationsListClient items={[sampleItem()]} total={1} page={1} pageSize={20} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith(7);
      expect(refreshMock).toHaveBeenCalled();
    });
  });

  it('delete cancel short-circuits', async () => {
    confirmMock.mockResolvedValueOnce(false);
    renderWithIntl(
      <ConversationsListClient items={[sampleItem()]} total={1} page={1} pageSize={20} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('delete surfaces error banner on rejection', async () => {
    deleteMock.mockRejectedValue(new Error('boom'));
    renderWithIntl(
      <ConversationsListClient items={[sampleItem()]} total={1} page={1} pageSize={20} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(screen.getByText('删除失败，请稍后重试')).toBeTruthy();
    });
  });

  it('delete uses unified delete_confirm copy regardless of archived state', async () => {
    renderWithIntl(
      <ConversationsListClient
        items={[sampleItem({ archivedAt: null })]}
        total={1}
        page={1}
        pageSize={20}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() =>
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: '删除这条对话及其所有消息？此操作不可撤销。' }),
      ),
    );
  });

  it('empty list on page 1 shows empty_title', () => {
    renderWithIntl(<ConversationsListClient items={[]} total={0} page={1} pageSize={20} />);
    expect(screen.getByText('暂无历史对话')).toBeTruthy();
  });

  it('empty list on page 2 shows back-to-first-page link', () => {
    renderWithIntl(<ConversationsListClient items={[]} total={20} page={2} pageSize={20} />);
    expect(screen.getByText('此页无内容')).toBeTruthy();
    expect(screen.getByText('回到第一页')).toBeTruthy();
  });

  it('pagination links show correct hrefs', () => {
    renderWithIntl(
      <ConversationsListClient items={[sampleItem()]} total={50} page={2} pageSize={20} />,
    );
    const prev = screen.getByText('上一页');
    const next = screen.getByText('下一页');
    expect(prev.getAttribute('href')).toBe('/conversations?page=1');
    expect(next.getAttribute('href')).toBe('/conversations?page=3');
  });
});
