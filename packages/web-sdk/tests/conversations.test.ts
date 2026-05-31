import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoldpanClient } from '../src/client';
import { type FetchHandler, installMockFetch } from './helpers/mock-fetch';

describe('GoldpanClient conversation methods', () => {
  let restore: () => void;
  let handler: FetchHandler;
  let lastUrl: string | null;
  let lastInit: RequestInit | undefined;

  beforeEach(() => {
    lastUrl = null;
    lastInit = undefined;
    handler = (url, init) => {
      lastUrl = url;
      lastInit = init;
      return { status: 200, body: {} };
    };
    const mock = installMockFetch((url, init) => handler(url, init));
    restore = mock.restore;
  });

  afterEach(() => {
    restore();
  });

  const client = () => new GoldpanClient({ baseUrl: 'http://test' });

  it('getActiveConversationId encodes channelId query', async () => {
    handler = (url, init) => {
      lastUrl = url;
      lastInit = init;
      return { status: 200, body: { id: 42 } };
    };
    const r = await client().getActiveConversationId('web');
    expect(r).toEqual({ id: 42 });
    expect(lastUrl).toBe('http://test/conversations/active?channelId=web');
    expect(lastInit?.method).toBe('GET');
  });

  it('listConversations encodes all params', async () => {
    handler = (url, init) => {
      lastUrl = url;
      lastInit = init;
      return { status: 200, body: { items: [], total: 0 } };
    };
    await client().listConversations({
      channelId: 'web',
      limit: 20,
      offset: 40,
      includeActive: false,
    });
    const url = new URL(lastUrl as unknown as string);
    expect(url.pathname).toBe('/conversations');
    expect(url.searchParams.get('channelId')).toBe('web');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('offset')).toBe('40');
    expect(url.searchParams.get('includeActive')).toBe('false');
  });

  it('listConversations omits undefined params', async () => {
    handler = (url) => {
      lastUrl = url;
      return { status: 200, body: { items: [], total: 0 } };
    };
    await client().listConversations({ channelId: 'web' });
    const url = new URL(lastUrl as unknown as string);
    expect(url.searchParams.get('channelId')).toBe('web');
    expect(url.searchParams.get('limit')).toBeNull();
    expect(url.searchParams.get('offset')).toBeNull();
    expect(url.searchParams.get('includeActive')).toBeNull();
  });

  it('getConversation builds path', async () => {
    handler = (url, init) => {
      lastUrl = url;
      lastInit = init;
      return {
        status: 200,
        body: {
          id: 7,
          sessionKey: 'web:default',
          channelId: 'web',
          archivedAt: null,
          messages: [],
        },
      };
    };
    const r = await client().getConversation(7);
    expect(r.id).toBe(7);
    expect(lastUrl).toBe('http://test/conversations/7');
  });

  it('createNewConversation sends body', async () => {
    handler = (url, init) => {
      lastUrl = url;
      lastInit = init;
      return { status: 200, body: { id: 99 } };
    };
    const r = await client().createNewConversation('web');
    expect(r).toEqual({ id: 99 });
    expect(lastInit?.method).toBe('POST');
    expect(JSON.parse(lastInit?.body as string)).toEqual({ channelId: 'web' });
  });

  it('createNewConversation includes sessionKey when provided', async () => {
    handler = (_url, init) => {
      lastInit = init;
      return { status: 200, body: { id: 100 } };
    };
    await client().createNewConversation('web', 'web:default');
    expect(JSON.parse(lastInit?.body as string)).toEqual({
      channelId: 'web',
      sessionKey: 'web:default',
    });
  });

  it('unarchiveConversation builds path', async () => {
    handler = (url, init) => {
      lastUrl = url;
      lastInit = init;
      return { status: 200, body: { id: 5 } };
    };
    const r = await client().unarchiveConversation(5);
    expect(r).toEqual({ id: 5 });
    expect(lastUrl).toBe('http://test/conversations/5/unarchive');
    expect(lastInit?.method).toBe('POST');
  });

  it('deleteConversation sends DELETE + handles 204', async () => {
    handler = (url, init) => {
      lastUrl = url;
      lastInit = init;
      return { status: 204 };
    };
    await client().deleteConversation(123);
    expect(lastInit?.method).toBe('DELETE');
    expect(lastUrl).toBe('http://test/conversations/123');
  });

  it('input passes conversationId + sessionKey through POST body', async () => {
    handler = (_url, init) => {
      lastInit = init;
      return { status: 200, body: { type: 'content', text: 'hi', conversationId: 42 } };
    };
    const r = await client().input({ input: 'hi', conversationId: 42, sessionKey: 'web:default' });
    expect(r.type).toBe('content');
    expect((r as { conversationId?: number }).conversationId).toBe(42);
    expect(JSON.parse(lastInit?.body as string)).toEqual({
      input: 'hi',
      conversationId: 42,
      sessionKey: 'web:default',
    });
  });

  it('input still works with only { input } shape', async () => {
    handler = (_url, init) => {
      lastInit = init;
      return { status: 200, body: { type: 'content', text: 'hi' } };
    };
    const r = await client().input({ input: 'hi' });
    expect(r.type).toBe('content');
    expect(JSON.parse(lastInit?.body as string)).toEqual({ input: 'hi' });
  });
});
