import { GoldpanApiError } from '@goldpan/web-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const inputMock = vi.fn();
vi.mock('@/lib/api', () => ({
  createServerClient: async () => ({ input: inputMock }),
  // 测试只关心 inputAction 的业务错误处理 — rethrowNextErrors 行为本身有
  // 自己的测试覆盖（lib/rethrow 即 next/navigation.unstable_rethrow 的薄
  // 包装）；这里 no-op 即可。
  rethrowNextErrors: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ requireAuth: async () => {} }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, values?: Record<string, unknown>) => {
    if (values) return `${key}:${JSON.stringify(values)}`;
    return key;
  },
}));

// Dynamic import after mocks so 'use server' module picks them up.
const { inputAction } = await import('./input');

describe('inputAction', () => {
  beforeEach(() => {
    inputMock.mockReset();
  });

  it('passes conversationId + sessionKey to client.input', async () => {
    inputMock.mockResolvedValue({ type: 'content', text: 'hi', conversationId: 42 });
    const fd = new FormData();
    fd.append('input', '你好');
    fd.append('conversationId', '42');
    fd.append('sessionKey', 'web:default');
    await inputAction({}, fd);
    expect(inputMock).toHaveBeenCalledWith({
      input: '你好',
      conversationId: 42,
      sessionKey: 'web:default',
    });
  });

  it('omits conversationId when formData empty', async () => {
    inputMock.mockResolvedValue({ type: 'content', text: 'hi' });
    const fd = new FormData();
    fd.append('input', 'hi');
    fd.append('sessionKey', 'web:default');
    await inputAction({}, fd);
    expect(inputMock).toHaveBeenCalledWith({ input: 'hi', sessionKey: 'web:default' });
  });

  it('returns conversationId in state when server returns it', async () => {
    inputMock.mockResolvedValue({ type: 'content', text: 'hi', conversationId: 99 });
    const fd = new FormData();
    fd.append('input', 'hi');
    const state = await inputAction({}, fd);
    expect(state.conversationId).toBe(99);
  });

  it('returns conversationId from typed input errors when server persisted the turn', async () => {
    inputMock.mockRejectedValue(
      new GoldpanApiError('Processing failed', 'intent_failed', 400, {
        type: 'error',
        code: 'intent_failed',
        message: 'Processing failed',
        conversationId: 88,
      }),
    );
    const fd = new FormData();
    fd.append('input', 'hi');
    const state = await inputAction({}, fd);
    expect(state.type).toBe('error');
    expect(state.conversationId).toBe(88);
  });

  it('ignores invalid conversationId values', async () => {
    inputMock.mockResolvedValue({ type: 'content', text: 'hi' });
    const fd = new FormData();
    fd.append('input', 'hi');
    fd.append('conversationId', 'abc');
    await inputAction({}, fd);
    expect(inputMock).toHaveBeenCalledWith({ input: 'hi' });
  });

  it('ignores non-positive conversationId', async () => {
    inputMock.mockResolvedValue({ type: 'content', text: 'hi' });
    const fd = new FormData();
    fd.append('input', 'hi');
    fd.append('conversationId', '0');
    await inputAction({}, fd);
    expect(inputMock).toHaveBeenCalledWith({ input: 'hi' });
  });

  it('propagates conversationId through submit result mapping', async () => {
    inputMock.mockResolvedValue({
      type: 'submit',
      status: 'accepted',
      taskId: 5,
      warnings: [],
      conversationId: 77,
    });
    const fd = new FormData();
    fd.append('input', 'https://x.com');
    const state = await inputAction({}, fd);
    expect(state.type).toBe('submit');
    expect(state.conversationId).toBe(77);
    expect(state.taskId).toBe('5');
  });

  it('preserves wait result fields for live BufferedWaitIndicator rendering', async () => {
    inputMock.mockResolvedValue({
      type: 'wait',
      bufferedMessageId: 123,
      expiresAt: 1700000030000,
      fallbackIntent: 'create_note',
      maxWaitMs: 30000,
      waitReasonKey: 'incomplete_command',
      conversationId: 88,
    });
    const fd = new FormData();
    fd.append('input', '明天那个');

    const state = await inputAction({}, fd);

    expect(state).toMatchObject({
      type: 'wait',
      bufferedMessageId: 123,
      bufferedExpiresAt: 1700000030000,
      fallbackIntent: 'create_note',
      maxWaitMs: 30000,
      waitReasonKey: 'incomplete_command',
      conversationId: 88,
    });
  });
});
