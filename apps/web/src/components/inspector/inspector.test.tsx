import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../confirm-provider';
import { Inspector } from './inspector';

// Inspector 的 PayloadRouter 会渲染 EntityPayload，后者自己用 useTranslations()。
// 所以本组测试必须包一层 provider，否则连挂载都会炸。
// Messages 里只放被真正读到的 key（state / entity_detail / inspector + common
// for the ConfirmProvider's modal labels — Inspector now consumes useConfirm
// centrally per PR #57, so all tests need a ConfirmProvider ancestor).
const messages = {
  state: {
    loading_default: '加载中...',
    error_title: '出错了',
    retry: '重试',
    empty_default: '暂无内容',
  },
  inspector: {
    back_fallback: '返回',
    close: '关闭',
    kind_entity: '实体',
    empty_entity_title: '暂无内容',
    unsaved_confirm: '放弃未保存的修改？',
  },
  entity_detail: {
    facts_title: '事实（{count}）',
    relationships_title: '关联实体（{count}）',
  },
  common: {
    ok: '确定',
    cancel: '取消',
    confirm_default_title: '确认',
  },
};

// Stub inspector API client so EntityPayload 不会在测试里真发请求。
// P5 Fix Batch 5 (I4): listNotes 也要 stub —— useEntityLinkedNotes 从
// EntityPayloadBody 提升到外层 EntityPayload 后，loading 阶段就会触发；
// 不 stub 会 TypeError: listNotes is not a function。
vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({
    // never-resolving promise keeps EntityPayload in loading 状态，和原测试一致。
    getEntity: () => new Promise(() => {}),
    listNotes: () => new Promise(() => {}),
  }),
}));

// GithubRepoCard depends on a server action (next/cache) that cannot be
// resolved by vitest's transform. Stub it so EntityPayload (pulled in
// transitively via PayloadRouter) is render-able under jsdom.
vi.mock('../github-repo-card', () => ({
  GithubRepoCard: () => null,
}));

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="zh" messages={messages}>
      <ConfirmProvider>{ui}</ConfirmProvider>
    </NextIntlClientProvider>
  );
}

describe('<Inspector>', () => {
  it('returns null when payload=null', () => {
    const { container } = render(wrap(<Inspector payload={null} onClose={vi.fn()} />));
    expect(container.firstChild).toBeNull();
  });

  it('renders dialog + header + close button when payload set', () => {
    render(wrap(<Inspector payload={{ kind: 'entity', id: 42 }} onClose={vi.fn()} />));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
  });

  it('calls onClose on ESC keypress', async () => {
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when close button clicked', async () => {
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));
    await userEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop clicked (not inspector content)', async () => {
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));
    const backdrop = document.querySelector('.gp-inspector__backdrop');
    expect(backdrop).not.toBeNull();
    await userEvent.click(backdrop as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose when inspector content clicked', async () => {
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));
    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('accepts onAction prop without type errors (dispatcher wiring)', () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={vi.fn()} onAction={onAction} />),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
