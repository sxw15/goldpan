import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const sendMessageMock = vi.fn();

class FakeBot {
  api = { sendMessage: sendMessageMock };
}

class FakeGrammyError extends Error {
  error_code: number;
  description: string;
  parameters: Record<string, unknown>;
  constructor(error_code: number, description: string, parameters: Record<string, unknown> = {}) {
    super(description);
    this.name = 'GrammyError';
    this.error_code = error_code;
    this.description = description;
    this.parameters = parameters;
  }
}

class FakeHttpError extends Error {
  error: unknown;
  constructor(message: string, inner?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.error = inner;
  }
}

vi.mock('grammy', () => ({
  Bot: FakeBot,
  GrammyError: FakeGrammyError,
  HttpError: FakeHttpError,
}));

beforeEach(() => {
  sendMessageMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('sendTelegramTestMessage', () => {
  test('happy path: calls bot.api.sendMessage with link preview disabled', async () => {
    const { sendTelegramTestMessage } = await import('../../src/transport/oneshot.js');
    sendMessageMock.mockResolvedValueOnce(undefined);
    await sendTelegramTestMessage({
      token: 'token-abc',
      chatId: '123',
      text: 'hi',
    });
    expect(sendMessageMock).toHaveBeenCalledWith('123', 'hi', {
      link_preview_options: { is_disabled: true },
    });
  });

  test('empty token rejects synchronously with kind=unauthorized', async () => {
    const { sendTelegramTestMessage, TelegramTestError } = await import(
      '../../src/transport/oneshot.js'
    );
    await expect(
      sendTelegramTestMessage({ token: '', chatId: '1', text: 'hi' }),
    ).rejects.toBeInstanceOf(TelegramTestError);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test('GrammyError 401 → kind=unauthorized + errorCode=401', async () => {
    const { sendTelegramTestMessage } = await import('../../src/transport/oneshot.js');
    sendMessageMock.mockRejectedValueOnce(new FakeGrammyError(401, 'Unauthorized'));
    await expect(
      sendTelegramTestMessage({ token: 'bad', chatId: '1', text: 'hi' }),
    ).rejects.toMatchObject({
      name: 'TelegramTestError',
      kind: 'unauthorized',
      errorCode: 401,
      telegramDescription: 'Unauthorized',
    });
  });

  test.each([
    'Bad Request: chat not found',
    'Bad Request: chat_id is empty',
    'Bad Request: chat id is empty',
    'Bad Request: PEER_ID_INVALID',
  ])('GrammyError 400 description "%s" → kind=chat_not_found', async (desc) => {
    const { sendTelegramTestMessage } = await import('../../src/transport/oneshot.js');
    sendMessageMock.mockRejectedValueOnce(new FakeGrammyError(400, desc));
    await expect(
      sendTelegramTestMessage({ token: 't', chatId: '999', text: 'hi' }),
    ).rejects.toMatchObject({ kind: 'chat_not_found', errorCode: 400 });
  });

  test('GrammyError 400 with unrelated description → kind=unknown', async () => {
    const { sendTelegramTestMessage } = await import('../../src/transport/oneshot.js');
    sendMessageMock.mockRejectedValueOnce(
      new FakeGrammyError(400, 'Bad Request: message text is empty'),
    );
    await expect(
      sendTelegramTestMessage({ token: 't', chatId: '1', text: '' }),
    ).rejects.toMatchObject({ kind: 'unknown', errorCode: 400 });
  });

  test('GrammyError 403 → kind=forbidden + errorCode=403', async () => {
    const { sendTelegramTestMessage } = await import('../../src/transport/oneshot.js');
    sendMessageMock.mockRejectedValueOnce(
      new FakeGrammyError(403, 'Forbidden: bot was blocked by the user'),
    );
    await expect(
      sendTelegramTestMessage({ token: 't', chatId: '1', text: 'hi' }),
    ).rejects.toMatchObject({ kind: 'forbidden', errorCode: 403 });
  });

  test('GrammyError 429 with parameters.retry_after → kind=rate_limited + retryAfter', async () => {
    const { sendTelegramTestMessage } = await import('../../src/transport/oneshot.js');
    sendMessageMock.mockRejectedValueOnce(
      new FakeGrammyError(429, 'Too Many Requests', { retry_after: 30 }),
    );
    await expect(
      sendTelegramTestMessage({ token: 't', chatId: '1', text: 'hi' }),
    ).rejects.toMatchObject({ kind: 'rate_limited', errorCode: 429, retryAfter: 30 });
  });

  test('GrammyError 429 without retry_after → kind=rate_limited, retryAfter not a number', async () => {
    const { sendTelegramTestMessage } = await import('../../src/transport/oneshot.js');
    sendMessageMock.mockRejectedValueOnce(new FakeGrammyError(429, 'Too Many Requests'));
    const e = (await sendTelegramTestMessage({ token: 't', chatId: '1', text: 'hi' }).then(
      () => undefined,
      (x) => x as { kind: string; errorCode?: number; retryAfter?: unknown },
    ))!;
    expect(e.kind).toBe('rate_limited');
    expect(e.errorCode).toBe(429);
    // 没有 retry_after 时不应承诺一个数字（class field 在 TS 下会自动 own-prop=undefined,
    // 这里检查 typeof 而不是 hasOwnProperty 更稳）。
    expect(typeof e.retryAfter).not.toBe('number');
  });

  test('HttpError → kind=network with inner message appended', async () => {
    const { sendTelegramTestMessage } = await import('../../src/transport/oneshot.js');
    sendMessageMock.mockRejectedValueOnce(
      new FakeHttpError('outer', new Error('connect ECONNREFUSED')),
    );
    await expect(
      sendTelegramTestMessage({ token: 't', chatId: '1', text: 'hi' }),
    ).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('ECONNREFUSED'),
    });
  });

  test('non-grammy / non-http error rethrown unchanged', async () => {
    const { sendTelegramTestMessage } = await import('../../src/transport/oneshot.js');
    const generic = new Error('boom');
    sendMessageMock.mockRejectedValueOnce(generic);
    await expect(sendTelegramTestMessage({ token: 't', chatId: '1', text: 'hi' })).rejects.toBe(
      generic,
    );
  });
});
