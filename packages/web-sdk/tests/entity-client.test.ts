// packages/web-sdk/tests/entity-client.test.ts
// Entity lookup methods for P7.3 mention parsing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoldpanClient } from '../src/client';
import { type FetchHandler, installMockFetch } from './helpers/mock-fetch';

describe('GoldpanClient.lookupEntitiesByName', () => {
  let restore: () => void;
  let handler: FetchHandler;

  beforeEach(() => {
    handler = () => ({ status: 200, body: { data: {} } });
    const mock = installMockFetch((url, init) => handler(url, init));
    restore = mock.restore;
  });

  afterEach(() => {
    restore();
  });

  it('returns empty map when names is empty (no fetch)', async () => {
    let called = false;
    handler = () => {
      called = true;
      return { status: 200, body: { data: {} } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const result = await client.lookupEntitiesByName([]);
    expect(result).toEqual({});
    expect(called).toBe(false);
  });

  it('GETs /entities?name=a&name=b and parses data map', async () => {
    handler = (url) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/entities');
      expect(parsed.searchParams.getAll('name')).toEqual(['a', 'b']);
      return { status: 200, body: { data: { a: 1, b: 2 } } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const result = await client.lookupEntitiesByName(['A', 'B']);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('lowercases + deduplicates names before request', async () => {
    let namesSeen: string[] = [];
    handler = (url) => {
      namesSeen = new URL(url).searchParams.getAll('name');
      return { status: 200, body: { data: {} } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    await client.lookupEntitiesByName(['Foo', 'foo', 'FOO', ' Bar ', '']);
    expect(namesSeen).toEqual(['foo', 'bar']);
  });

  it('preserves spaces / punctuation through repeated name query parameters', async () => {
    let namesSeen: string[] = [];
    handler = (url) => {
      namesSeen = new URL(url).searchParams.getAll('name');
      return { status: 200, body: { data: {} } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    await client.lookupEntitiesByName(['Claude Code', 'OpenAI, Inc.', 'Node.js']);
    expect(namesSeen).toEqual(['claude code', 'openai, inc.', 'node.js']);
  });
});
