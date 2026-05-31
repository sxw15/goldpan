import { afterEach, describe, expect, it, vi } from 'vitest';

const grammyMock = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown) => Promise<void>>(),
  getMe: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('grammy', () => {
  class Bot {
    api = { getMe: grammyMock.getMe };

    on(event: string, handler: (ctx: unknown) => Promise<void>) {
      grammyMock.handlers.set(event, handler);
    }

    start(opts: { onStart?: () => void }) {
      return grammyMock.start(opts);
    }

    stop() {
      return grammyMock.stop();
    }
  }

  return { Bot };
});

import { createTelegramTransport, translateMessageUpdate } from '../../src/transport/polling.js';

afterEach(() => {
  grammyMock.handlers.clear();
  grammyMock.getMe.mockReset();
  grammyMock.start.mockReset();
  grammyMock.stop.mockReset();
});

describe('translateMessageUpdate', () => {
  it('text DM → text contentType', () => {
    const m = translateMessageUpdate(
      {
        update_id: 1,
        message: {
          message_id: 100,
          from: { id: 7, username: 'alice' },
          chat: { id: 5, type: 'private' },
          text: 'hi',
          date: 1714000000,
        },
      } as never,
      { accountId: 'bot1' },
    );
    expect(m).toEqual({
      channelId: 'telegram',
      accountId: 'bot1',
      chatId: '5',
      userId: '7',
      platformMsgId: '100',
      text: 'hi',
      contentType: 'text',
      raw: expect.any(Object),
      receivedAt: expect.any(Date),
    });
  });

  it('photo → image contentType', () => {
    const m = translateMessageUpdate(
      {
        update_id: 2,
        message: {
          message_id: 101,
          from: { id: 7 },
          chat: { id: 5, type: 'private' },
          photo: [{ file_id: 'p1' }],
          date: 1714000001,
        },
      } as never,
      { accountId: 'bot1' },
    );
    expect(m?.contentType).toBe('image');
  });

  it('voice → voice contentType', () => {
    const m = translateMessageUpdate(
      {
        update_id: 3,
        message: {
          message_id: 102,
          from: { id: 7 },
          chat: { id: 5, type: 'private' },
          voice: { file_id: 'v1' },
          date: 1714000002,
        },
      } as never,
      { accountId: 'bot1' },
    );
    expect(m?.contentType).toBe('voice');
  });

  it('audio (music file) → voice contentType', () => {
    const m = translateMessageUpdate(
      {
        update_id: 30,
        message: {
          message_id: 120,
          from: { id: 7 },
          chat: { id: 5, type: 'private' },
          audio: { file_id: 'a1' },
          date: 1714000010,
        },
      } as never,
      { accountId: 'bot1' },
    );
    expect(m?.contentType).toBe('voice');
  });

  it('animation (GIF/MP4) → video contentType', () => {
    const m = translateMessageUpdate(
      {
        update_id: 31,
        message: {
          message_id: 121,
          from: { id: 7 },
          chat: { id: 5, type: 'private' },
          animation: { file_id: 'g1' },
          date: 1714000011,
        },
      } as never,
      { accountId: 'bot1' },
    );
    expect(m?.contentType).toBe('video');
  });

  it('video_note (circular video) → video contentType', () => {
    const m = translateMessageUpdate(
      {
        update_id: 32,
        message: {
          message_id: 122,
          from: { id: 7 },
          chat: { id: 5, type: 'private' },
          video_note: { file_id: 'vn1' },
          date: 1714000012,
        },
      } as never,
      { accountId: 'bot1' },
    );
    expect(m?.contentType).toBe('video');
  });

  it('sticker → other contentType (variant-agnostic)', () => {
    const m = translateMessageUpdate(
      {
        update_id: 33,
        message: {
          message_id: 123,
          from: { id: 7 },
          chat: { id: 5, type: 'private' },
          sticker: { file_id: 's1' },
          date: 1714000013,
        },
      } as never,
      { accountId: 'bot1' },
    );
    expect(m?.contentType).toBe('other');
  });

  it('returns null for updates without a message (e.g. edited_message, callback_query)', () => {
    expect(
      translateMessageUpdate({ update_id: 5, edited_message: {} } as never, { accountId: 'bot1' }),
    ).toBeNull();
    expect(
      translateMessageUpdate(
        {
          update_id: 6,
          callback_query: {
            id: 'cb1',
            from: { id: 7 },
            message: { chat: { id: 5 }, message_id: 10, date: 1 },
            data: 'clarify:1:0',
          },
        } as never,
        { accountId: 'bot1' },
      ),
    ).toBeNull();
  });
});

describe('createTelegramTransport callback routing', () => {
  it('answers callback queries before invoking onCallbackQuery', async () => {
    const order: string[] = [];
    grammyMock.getMe.mockResolvedValue({ id: 99, username: 'mybot' });
    grammyMock.start.mockImplementation(async (opts: { onStart?: () => void }) => {
      opts.onStart?.();
    });
    grammyMock.stop.mockResolvedValue(undefined);

    const onCallbackQuery = vi.fn(async () => {
      order.push('callback');
    });
    const transport = await createTelegramTransport({
      token: 'token',
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      dispatch: vi.fn(),
      onCallbackQuery,
    });

    await transport.start();

    const callbackHandler = grammyMock.handlers.get('callback_query');
    expect(callbackHandler).toBeTypeOf('function');

    await callbackHandler?.({
      update: {
        update_id: 10,
        callback_query: {
          id: 'cb-order',
          from: { id: 7 },
          message: { message_id: 103, chat: { id: 5, type: 'private' }, date: 1714000003 },
          data: 'clarify:42:0',
        },
      },
      answerCallbackQuery: vi.fn(async () => {
        order.push('ack');
      }),
    });

    expect(order).toEqual(['ack', 'callback']);
    expect(onCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it('acks callback queries even when no handler is installed (then logs debug)', async () => {
    grammyMock.getMe.mockResolvedValue({ id: 99, username: 'mybot' });
    grammyMock.start.mockImplementation(async (opts: { onStart?: () => void }) => {
      opts.onStart?.();
    });
    grammyMock.stop.mockResolvedValue(undefined);

    const debug = vi.fn();
    const transport = await createTelegramTransport({
      token: 'token',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug } as never,
      signal: new AbortController().signal,
      dispatch: vi.fn(),
      // no onCallbackQuery
    });

    await transport.start();

    const callbackHandler = grammyMock.handlers.get('callback_query');
    const ack = vi.fn(async () => {});
    await callbackHandler?.({
      update: {
        update_id: 11,
        callback_query: {
          id: 'cb-no-handler',
          from: { id: 7 },
          message: { message_id: 300, chat: { id: 5 }, date: 1 },
          data: 'clarify:1:0',
        },
      },
      answerCallbackQuery: ack,
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalled();
  });
});
