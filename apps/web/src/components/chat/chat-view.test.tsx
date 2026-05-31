import { GoldpanApiError } from '@goldpan/web-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import zhMessages from '../../../messages/zh.json';
import { ConfirmProvider } from '../confirm-provider';
import { ChatView } from './chat-view';

const replaceMock = vi.fn();
const pushMock = vi.fn();
const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock, refresh: refreshMock }),
}));

const unarchiveMock = vi.fn();
const createNewMock = vi.fn();
const listConversationsMock = vi.fn();
const updateNoteMock = vi.fn();
const inputClientMock = vi.fn();
// PR #57 thread #1: ReclassifyChipBar lazy-fetches `getNote(noteId)` on
// mount to detect the cross-page archived case. Default to `archived: false`
// here so existing chat-view scenarios render ChipBar; per-test overrides
// can change this for archived-state checks.
const getNoteMock = vi.fn();
vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({
    unarchiveConversation: unarchiveMock,
    createNewConversation: createNewMock,
    listConversations: listConversationsMock,
    // P5 Fix Batch 5 (I3): useReclassifyNote 内部用这两个方法。test 把它们
    // mock 成 resolved Promise，让 reclassify 流程能跑到 onSuccess 回调，
    // 触发 setReclassifiedNoteIds —— 这是 I3 ChipBar 隐藏的入口。
    updateNote: updateNoteMock,
    input: inputClientMock,
    getNote: getNoteMock,
  }),
}));

const inputActionMock = vi.fn();
vi.mock('@/actions/input', () => ({
  inputAction: (...args: unknown[]) => inputActionMock(...args),
}));

function renderView(props: ComponentProps<typeof ChatView>): ReactElement {
  // Inspector now consumes useConfirm centrally for dirty-guard; ChatView mounts
  // Inspector unconditionally so renderView must wrap in ConfirmProvider too.
  return render(
    <NextIntlClientProvider locale="zh" messages={zhMessages}>
      <ConfirmProvider>
        <ChatView {...props} />
      </ConfirmProvider>
    </NextIntlClientProvider>,
  ) as unknown as ReactElement;
}

describe('ChatView integration', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    refreshMock.mockReset();
    unarchiveMock.mockReset();
    createNewMock.mockReset();
    listConversationsMock.mockReset();
    inputActionMock.mockReset();
    updateNoteMock.mockReset();
    inputClientMock.mockReset();
    getNoteMock.mockReset();
    getNoteMock.mockResolvedValue({ id: 0, archived: false });
    listConversationsMock.mockResolvedValue({ items: [], total: 0 });
  });

  it('Scenario A: archived initialConversation triggers unarchive on mount', async () => {
    unarchiveMock.mockResolvedValue({ id: 42 });
    renderView({
      maxInputLength: 20000,
      initialConversation: {
        id: 42,
        messages: [
          {
            id: 1,
            role: 'user',
            content: '历史消息',
            metadata: null,
            createdAt: Date.now(),
          },
        ],
        archived: true,
      },
    });
    await waitFor(() => {
      expect(unarchiveMock).toHaveBeenCalledWith(42);
    });
    expect(screen.getByText('历史消息')).toBeTruthy();
  });

  it('Scenario A: renders messages from initialConversation regardless of archived flag', () => {
    renderView({
      maxInputLength: 20000,
      initialConversation: {
        id: 7,
        messages: [
          {
            id: 1,
            role: 'user',
            content: '历史 user',
            metadata: null,
            createdAt: Date.now(),
          },
          {
            id: 2,
            role: 'assistant',
            content: '历史 assistant',
            metadata: { resultType: 'content' },
            createdAt: Date.now(),
          },
        ],
        archived: false,
      },
    });
    expect(screen.getByText('历史 user')).toBeTruthy();
    expect(screen.getByText('历史 assistant')).toBeTruthy();
    expect(unarchiveMock).not.toHaveBeenCalled();
  });

  it('routes accepted opinion submissions to NoteBubbleCard on reload via metadata.inputMode', () => {
    // Polling kicks in for the rendered card; mock fetch so the test isn't
    // racing the network. Returning `pending` is enough — we just need the
    // bubble shell to render without throwing.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'pending',
        taskId: '99',
        sourceId: 1,
        createdAt: Date.now(),
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderView({
      maxInputLength: 20000,
      initialConversation: {
        id: 9,
        messages: [
          {
            id: 1,
            role: 'assistant',
            content: '[submit:accepted]',
            metadata: {
              resultType: 'submit',
              submitStatus: 'accepted',
              taskId: 99,
              inputMode: 'opinion',
            },
            createdAt: Date.now(),
          },
        ],
        archived: false,
      },
    });

    // NoteBubbleCard's "正在记录观点 …" title is the unique-to-note marker —
    // TaskBubbleCard never renders that string, so its presence proves the
    // dispatch in message-bubble picked the opinion branch.
    expect(screen.getByText('正在记录观点 …')).toBeTruthy();
    expect(screen.queryByText(/任务 #99/)).toBeNull();

    vi.unstubAllGlobals();
  });

  it('renders persisted rejected submit messages through i18n mapping', () => {
    renderView({
      maxInputLength: 20000,
      initialConversation: {
        id: 8,
        messages: [
          {
            id: 1,
            role: 'assistant',
            content: '[submit:rejected]',
            metadata: {
              resultType: 'submit',
              submitStatus: 'rejected',
              rejectCode: 'url_invalid',
              rejectReason: 'raw server reason',
            },
            createdAt: Date.now(),
          },
        ],
        archived: false,
      },
    });
    expect(screen.getByText('URL 格式无效。')).toBeTruthy();
    expect(screen.queryByText('raw server reason')).toBeNull();
  });

  it('clears deleted notice without dropping the active conversation URL', async () => {
    renderView({
      maxInputLength: 20000,
      showDeletedNotice: true,
      initialConversation: {
        id: 12,
        messages: [],
        archived: false,
      },
    });
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/?c=12');
    });
    expect(screen.getByText('所选对话已失效')).toBeTruthy();
  });

  it('shows one-shot reclassify fallback notice from URL flag and clears the flag', async () => {
    renderView({
      maxInputLength: 20000,
      showReclassifyFallbackNotice: true,
      initialConversation: {
        id: 33,
        messages: [],
        archived: false,
      },
    });
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/?c=33');
    });
    expect(screen.getByText('源对话已归档，已切换到新对话')).toBeTruthy();
  });

  it('Scenario B: first input response with conversationId triggers URL replace', async () => {
    inputActionMock.mockResolvedValue({
      type: 'content',
      contentText: 'hi back',
      conversationId: 99,
    });
    renderView({ maxInputLength: 20000, initialConversation: null });

    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '你好' } });
    const form = textarea.closest('form');
    if (!form) throw new Error('form not found');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/?c=99');
    });
  });

  it('renders live wait responses on the user bubble instead of a plain assistant action', async () => {
    inputActionMock.mockResolvedValue({
      type: 'wait',
      bufferedMessageId: 42,
      bufferedExpiresAt: Date.now() + 30_000,
      waitReasonKey: 'incomplete_command',
      conversationId: 1,
    });
    renderView({
      maxInputLength: 20000,
      initialConversation: { id: 1, messages: [], archived: false },
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '明天那个' } });
    const form = textarea.closest('form');
    if (!form) throw new Error('form not found');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText('句子未完成')).toBeTruthy();
      expect(screen.getByRole('button', { name: '立即执行' })).toBeTruthy();
    });
    expect(screen.queryByText('思考中')).toBeNull();
  });

  it('recent 3 fetched on truly-empty state', async () => {
    listConversationsMock.mockResolvedValue({
      items: [
        {
          id: 1,
          title: '历史对话 A',
          sessionKey: 'web:default',
          channelId: 'web',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastMessageAt: Date.now(),
          archivedAt: Date.now(),
          archivedReason: null,
          messageCount: 1,
        },
      ],
      total: 1,
    });
    renderView({ maxInputLength: 20000, initialConversation: null });
    await waitFor(() => {
      expect(listConversationsMock).toHaveBeenCalledWith({
        channelId: 'web',
        limit: 3,
        includeActive: false,
      });
      expect(screen.getByText('历史对话 A')).toBeTruthy();
    });
  });

  it('does not fetch recent 3 when initialConversation present', async () => {
    renderView({
      maxInputLength: 20000,
      initialConversation: { id: 1, messages: [], archived: false },
    });
    // Wait a tick for any effects to run
    await new Promise((r) => setTimeout(r, 10));
    expect(listConversationsMock).not.toHaveBeenCalled();
  });

  it('renders note reclassify chip bar for resultType=note on reload', async () => {
    renderView({
      maxInputLength: 20000,
      initialConversation: {
        id: 1,
        archived: false,
        messages: [
          {
            id: 10,
            role: 'user',
            content: '今天看了一篇文章',
            metadata: null,
            createdAt: Date.now(),
          },
          {
            id: 11,
            role: 'assistant',
            content: 'Saved as note #5',
            metadata: { resultType: 'note', noteId: 5, subtype: 'note' },
            createdAt: Date.now(),
          },
        ],
      },
    });
    // ReclassifyChipBar (Task 10) appears with sentinel data-testid="reclassify-chip-bar"
    expect(await screen.findByTestId('reclassify-chip-bar')).toBeInTheDocument();
  });

  it('disables new conversation while an input action is pending', async () => {
    let resolveAction: ((value: unknown) => void) | undefined;
    inputActionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAction = resolve;
        }),
    );
    renderView({
      maxInputLength: 20000,
      initialConversation: {
        id: 1,
        messages: [
          {
            id: 1,
            role: 'user',
            content: 'old',
            metadata: null,
            createdAt: Date.now(),
          },
        ],
        archived: false,
      },
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '慢请求' } });
    const form = textarea.closest('form');
    if (!form) throw new Error('form not found');
    fireEvent.submit(form);

    const newButton = screen.getByRole('button', { name: '新建对话' });
    await waitFor(() => {
      expect(newButton).toBeDisabled();
    });
    fireEvent.click(newButton);
    expect(createNewMock).not.toHaveBeenCalled();

    resolveAction?.({ type: 'content', contentText: 'done', conversationId: 1 });
  });

  // P5 Fix Batch 5 (I3): note bubble 上的 ReclassifyChipBar 在 reclassify 成功
  // 后必须从 UI 消失（替换成"已重新分类"placeholder），否则 server-reload 仍
  // 会还原 note bubble，用户可以重复点击触发已 archived 的 note 报错。
  it('I3: hides reclassify chip bar + shows reclassified hint after successful reclassify', async () => {
    // useReclassifyNote 内部两步：先 archive 原 note 成功，再 /input forced
    // dispatch 成功 —— 这条路径会调 onSuccess 把 noteId 加入 reclassifiedNoteIds。
    updateNoteMock.mockResolvedValue({});
    inputClientMock.mockResolvedValue({ type: 'query', answer: 'ok' });

    renderView({
      maxInputLength: 20000,
      initialConversation: {
        id: 1,
        archived: false,
        messages: [
          {
            id: 10,
            role: 'user',
            content: '今天看了一篇文章',
            metadata: null,
            createdAt: Date.now(),
          },
          {
            id: 11,
            role: 'assistant',
            content: 'Saved as note #5',
            metadata: { resultType: 'note', noteId: 5, subtype: 'note' },
            createdAt: Date.now(),
          },
        ],
      },
    });

    // ChipBar 一开始可见
    expect(await screen.findByTestId('reclassify-chip-bar')).toBeInTheDocument();

    // 触发 reclassify —— 点 "改为查询" chip (key='query' → labelKey='to_query')
    // 与 zh.json reclassify_chip_bar.to_query='改为查询' 对应
    const queryChip = screen.getByRole('button', { name: '改为查询' });
    await waitFor(() => expect(queryChip).not.toBeDisabled());
    fireEvent.click(queryChip);

    // 等异步链：updateNote → input → onSuccess → setState → re-render
    await waitFor(() => {
      expect(screen.queryByTestId('reclassify-chip-bar')).toBeNull();
    });
    expect(screen.getByText('已重新分类')).toBeInTheDocument();
  });

  // T10 F-CHAT-ONERROR-NO-TEST: reclassify dispatch failure (with rollback
  // succeeding) must surface err.message via onError → setErrorBanner so the
  // user sees what went wrong. Without this assertion a regression that
  // swallows onError silently would leave the chip bar visible + the user
  // unaware their click failed.
  it('shows error banner when reclassify dispatch fails (onError path)', async () => {
    // archive succeeds → dispatch rejects → rollback unarchive succeeds → onError fires
    updateNoteMock.mockImplementation((_id, patch) =>
      patch.archived === false ? Promise.resolve({}) : Promise.resolve({ id: 5, archived: true }),
    );
    inputClientMock.mockRejectedValue(new Error('boom dispatch'));

    renderView({
      maxInputLength: 20000,
      initialConversation: {
        id: 1,
        archived: false,
        messages: [
          { id: 10, role: 'user', content: '一段话', metadata: null, createdAt: Date.now() },
          {
            id: 11,
            role: 'assistant',
            content: 'Saved as note #5',
            metadata: { resultType: 'note', noteId: 5, subtype: 'note' },
            createdAt: Date.now(),
          },
        ],
      },
    });
    const queryChip = await screen.findByRole('button', { name: '改为查询' });
    await waitFor(() => expect(queryChip).not.toBeDisabled());
    fireEvent.click(queryChip);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('boom dispatch');
    });
  });

  // T11 F-MULTI-NOTE-IDS-NO-TEST: reclassifiedNoteIds is a Set — adding a
  // second id must not drop the first. With two note bubbles, reclassify
  // both, both ChipBars should disappear in the final render.
  it('appends multiple reclassified noteIds without replacing previous', async () => {
    updateNoteMock.mockResolvedValue({});
    inputClientMock.mockResolvedValue({ type: 'query', answer: 'ok' });

    renderView({
      maxInputLength: 20000,
      initialConversation: {
        id: 1,
        archived: false,
        messages: [
          { id: 10, role: 'user', content: 'a', metadata: null, createdAt: Date.now() },
          {
            id: 11,
            role: 'assistant',
            content: 'Saved as note #5',
            metadata: { resultType: 'note', noteId: 5, subtype: 'note' },
            createdAt: Date.now(),
          },
          { id: 12, role: 'user', content: 'b', metadata: null, createdAt: Date.now() },
          {
            id: 13,
            role: 'assistant',
            content: 'Saved as note #6',
            metadata: { resultType: 'note', noteId: 6, subtype: 'memo' },
            createdAt: Date.now(),
          },
        ],
      },
    });

    // Two ChipBars rendered initially.
    await waitFor(() => {
      expect(screen.getAllByTestId('reclassify-chip-bar')).toHaveLength(2);
    });

    // Click the first ChipBar's "改为查询".
    const firstChip = screen.getAllByRole('button', { name: '改为查询' })[0];
    if (!firstChip) throw new Error('first chip not found');
    await waitFor(() => expect(firstChip).not.toBeDisabled());
    fireEvent.click(firstChip);
    await waitFor(() => {
      expect(screen.getAllByTestId('reclassify-chip-bar')).toHaveLength(1);
    });

    // Click the remaining ChipBar's "改为查询".
    const secondChip = screen.getByRole('button', { name: '改为查询' });
    await waitFor(() => expect(secondChip).not.toBeDisabled());
    fireEvent.click(secondChip);
    await waitFor(() => {
      expect(screen.queryByTestId('reclassify-chip-bar')).toBeNull();
    });
  });

  // T-FALLBACK-NAV: when the hook reports fellBackToSession=true with a
  // different dispatchedResult.conversationId, ChatView must navigate the
  // user to `/?c=<newId>` and show the fallback info banner. Without this
  // path the user's dispatch lands in a conversation they're not viewing.
  it('reclassify fallback to new conversation navigates user via ?c=<newId> + info banner', async () => {
    // archive succeeds, first dispatch returns 409 conversation_archived,
    // second dispatch (fallback) returns 200 with a NEW conversationId=999.
    updateNoteMock.mockResolvedValue({});
    let callIdx = 0;
    inputClientMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return Promise.reject(new GoldpanApiError('archived', 'conversation_archived', 409));
      }
      return Promise.resolve({ type: 'query', answer: 'ok', conversationId: 999 });
    });

    renderView({
      maxInputLength: 20000,
      initialConversation: {
        id: 1,
        archived: false,
        messages: [
          { id: 10, role: 'user', content: 'x', metadata: null, createdAt: Date.now() },
          {
            id: 11,
            role: 'assistant',
            content: 'Saved as note #5',
            metadata: { resultType: 'note', noteId: 5, subtype: 'note' },
            createdAt: Date.now(),
          },
        ],
      },
    });

    const queryChip = await screen.findByRole('button', { name: '改为查询' });
    await waitFor(() => expect(queryChip).not.toBeDisabled());
    fireEvent.click(queryChip);

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/?c=999&reclassifyFallback=1');
    });
    // Info banner from chat.reclassify_fallback_session (zh).
    expect(screen.getByRole('status')).toHaveTextContent('源对话已归档，已切换到新对话');
  });

  it('keeps chat navigation and composer disabled while reclassify is in flight', async () => {
    let resolveInput: ((value: unknown) => void) | undefined;
    updateNoteMock.mockResolvedValue({});
    inputClientMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInput = resolve;
        }),
    );

    renderView({
      maxInputLength: 20000,
      initialConversation: {
        id: 1,
        archived: false,
        messages: [
          { id: 10, role: 'user', content: 'x', metadata: null, createdAt: Date.now() },
          {
            id: 11,
            role: 'assistant',
            content: 'Saved as note #5',
            metadata: { resultType: 'note', noteId: 5, subtype: 'note' },
            createdAt: Date.now(),
          },
        ],
      },
    });

    const queryChip = await screen.findByRole('button', { name: '改为查询' });
    await waitFor(() => expect(queryChip).not.toBeDisabled());
    fireEvent.click(queryChip);

    const newButton = screen.getByRole('button', { name: '新建对话' });
    await waitFor(() => expect(newButton).toBeDisabled());
    expect(screen.getByRole('textbox')).toBeDisabled();
    fireEvent.click(newButton);
    expect(createNewMock).not.toHaveBeenCalled();

    resolveInput?.({ type: 'query', answer: 'ok', conversationId: 1 });
  });

  it('navigates to dispatched conversation when reclassify completes after the viewed conversation changed', async () => {
    updateNoteMock.mockResolvedValue({});
    inputClientMock.mockResolvedValue({ type: 'query', answer: 'ok', conversationId: 2 });

    renderView({
      maxInputLength: 20000,
      initialConversation: {
        id: 1,
        archived: false,
        messages: [
          { id: 10, role: 'user', content: 'x', metadata: null, createdAt: Date.now() },
          {
            id: 11,
            role: 'assistant',
            content: 'Saved as note #5',
            metadata: { resultType: 'note', noteId: 5, subtype: 'note' },
            createdAt: Date.now(),
          },
        ],
      },
    });

    const queryChip = await screen.findByRole('button', { name: '改为查询' });
    await waitFor(() => expect(queryChip).not.toBeDisabled());
    fireEvent.click(queryChip);

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/?c=2');
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  // T-ROLLBACK-CHAT: archive succeeds, dispatch fails, rollback unarchive
  // also fails — onRollbackFailed fires and the chat-flavored banner must
  // surface (not the generic onError text).
  it('shows reclassify_rollback_failed banner when archive succeeds + dispatch fails + unarchive fails', async () => {
    // First updateNote call (archived=true) succeeds; second
    // (archived=false rollback) rejects. Dispatch rejects in between.
    updateNoteMock.mockImplementation((_id, patch) =>
      patch.archived === false
        ? Promise.reject(new Error('rollback boom'))
        : Promise.resolve({ id: 5, archived: true }),
    );
    inputClientMock.mockRejectedValue(new Error('dispatch boom'));

    renderView({
      maxInputLength: 20000,
      initialConversation: {
        id: 1,
        archived: false,
        messages: [
          { id: 10, role: 'user', content: 'y', metadata: null, createdAt: Date.now() },
          {
            id: 11,
            role: 'assistant',
            content: 'Saved as note #5',
            metadata: { resultType: 'note', noteId: 5, subtype: 'note' },
            createdAt: Date.now(),
          },
        ],
      },
    });

    const queryChip = await screen.findByRole('button', { name: '改为查询' });
    await waitFor(() => expect(queryChip).not.toBeDisabled());
    fireEvent.click(queryChip);

    await waitFor(() => {
      // chat.reclassify_rollback_failed text mirrors note_payload
      // version with the dispatch error interpolated.
      expect(screen.getByRole('alert')).toHaveTextContent('重新分类失败，且原笔记自动恢复也失败');
      expect(screen.getByRole('alert')).toHaveTextContent('dispatch boom');
    });
  });

  // T-CONTRACT-VIOLATION: server contract violation — note result missing
  // noteSubtype. Should fall through to an error bubble (case 'error' in
  // MessageBubble renders gp-bubble__error with intent_error fallback)
  // rather than render an empty span (the pre-fix pending bubble).
  it('note result without noteSubtype falls through to error bubble (not empty span)', async () => {
    inputActionMock.mockResolvedValue({
      type: 'note',
      noteId: 5,
      // noteSubtype intentionally absent — contract violation
      conversationId: 1,
    });
    renderView({
      maxInputLength: 20000,
      initialConversation: { id: 1, messages: [], archived: false },
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'broken note' } });
    const form = textarea.closest('form');
    if (!form) throw new Error('form not found');
    fireEvent.submit(form);

    // zh intent_error → "无法处理你的输入，请重试。"
    await waitFor(() => {
      expect(screen.getByText('无法处理你的输入，请重试。')).toBeInTheDocument();
    });
  });
});
