import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { GoldpanClient } from '../src/client';
import { GoldpanApiError } from '../src/errors';
import type { InputResult } from '../src/types';
import { type FetchHandler, installMockFetch } from './helpers/mock-fetch';

describe('GoldpanClient', () => {
  let restore: () => void;
  let handler: FetchHandler;

  beforeEach(() => {
    handler = () => ({ status: 200, body: {} });
    const mock = installMockFetch((url, init) => handler(url, init));
    restore = mock.restore;
  });

  afterEach(() => {
    restore();
  });

  // --- Core request<T>() ---

  describe('request', () => {
    it('sends correct method and path', async () => {
      handler = (url, init) => {
        expect(url).toBe('http://localhost:3001/test');
        expect(init?.method).toBe('GET');
        return { status: 200, body: { ok: true } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.request<{ ok: boolean }>('GET', '/test');
      expect(result).toEqual({ ok: true });
    });

    it('includes Authorization header when token is set', async () => {
      handler = (_url, init) => {
        expect(init?.headers).toBeDefined();
        const headers = init!.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer my-token');
        return { status: 200, body: {} };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001', token: 'my-token' });
      await client.request('GET', '/test');
    });

    it('does not include Authorization header when no token', async () => {
      handler = (_url, init) => {
        const headers = init!.headers as Record<string, string>;
        expect(headers.Authorization).toBeUndefined();
        return { status: 200, body: {} };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.request('GET', '/test');
    });

    it('sends JSON body for POST requests', async () => {
      handler = (_url, init) => {
        expect(init?.body).toBe(JSON.stringify({ key: 'value' }));
        const headers = init!.headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
        return { status: 200, body: { received: true } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.request('POST', '/test', { key: 'value' });
    });

    it('does not set Content-Type when no body', async () => {
      handler = (_url, init) => {
        const headers = init!.headers as Record<string, string>;
        expect(headers['Content-Type']).toBeUndefined();
        return { status: 200, body: {} };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.request('GET', '/test');
    });

    it('throws GoldpanApiError on non-2xx response', async () => {
      handler = () => ({
        status: 404,
        body: { type: 'error', code: 'not_found', message: 'Not found' },
      });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await expect(client.request('GET', '/missing')).rejects.toThrow(GoldpanApiError);
      try {
        await client.request('GET', '/missing');
      } catch (e) {
        const err = e as GoldpanApiError;
        expect(err.code).toBe('not_found');
        expect(err.status).toBe(404);
        expect(err.message).toBe('Not found');
      }
    });

    it('calls onUnauthorized on 401 response', async () => {
      handler = () => ({
        status: 401,
        body: { type: 'error', code: 'unauthorized', message: 'Unauthorized' },
      });
      const onUnauthorized = vi.fn();
      const client = new GoldpanClient({
        baseUrl: 'http://localhost:3001',
        onUnauthorized,
      });
      await expect(client.request('GET', '/protected')).rejects.toThrow(GoldpanApiError);
      expect(onUnauthorized).toHaveBeenCalledOnce();
    });

    it('returns undefined for 204 No Content', async () => {
      handler = () => ({ status: 204 });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.request('DELETE', '/thing');
      expect(result).toBeUndefined();
    });

    it('forwards abort signal', async () => {
      handler = () => ({ status: 200, body: {} });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const controller = new AbortController();
      controller.abort();
      await expect(client.request('GET', '/test', undefined, controller.signal)).rejects.toThrow();
    });

    it('passes credentials option to fetch', async () => {
      handler = (_url, init) => {
        expect(init?.credentials).toBe('include');
        return { status: 200, body: {} };
      };
      const client = new GoldpanClient({
        baseUrl: 'http://localhost:3001',
        credentials: 'include',
      });
      await client.request('GET', '/test');
    });

    it('strips trailing slash from baseUrl', async () => {
      handler = (url) => {
        expect(url).toBe('http://localhost:3001/test');
        return { status: 200, body: {} };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001/' });
      await client.request('GET', '/test');
    });
  });

  // --- Auth methods ---

  describe('login', () => {
    it('sends password and returns LoginResult', async () => {
      handler = (_url, init) => {
        const body = JSON.parse(init?.body as string);
        expect(body.password).toBe('secret123');
        return {
          status: 200,
          body: { token: 'tok_abc', expiresAt: '2025-01-02T00:00:00Z' },
        };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.login('secret123');
      expect(result.token).toBe('tok_abc');
      expect(result.expiresAt).toBe('2025-01-02T00:00:00Z');
    });

    it('accepts { authenticated: true } from a no-password server', async () => {
      handler = () => ({ status: 200, body: { authenticated: true } });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.login('');
      expect(result.authenticated).toBe(true);
      expect(result.token).toBeUndefined();
      expect(result.expiresAt).toBeUndefined();
    });

    it('throws on invalid password', async () => {
      handler = () => ({
        status: 401,
        body: { type: 'error', code: 'invalid_password', message: 'Invalid password' },
      });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await expect(client.login('wrong')).rejects.toThrow(GoldpanApiError);
    });

    // Regression: a 401 from /auth/login means "invalid password" — a business
    // response, NOT an expired session. Triggering `onUnauthorized` here would
    // clear existing session state or loop the app back to a screen it is
    // already on.
    it('does not call onUnauthorized on 401 (bad password)', async () => {
      handler = () => ({
        status: 401,
        body: { type: 'error', code: 'invalid_password', message: 'Invalid password' },
      });
      const onUnauthorized = vi.fn();
      const client = new GoldpanClient({
        baseUrl: 'http://localhost:3001',
        onUnauthorized,
      });
      try {
        await client.login('wrong');
        expect.fail('expected to throw');
      } catch (e) {
        const err = e as GoldpanApiError;
        expect(err).toBeInstanceOf(GoldpanApiError);
        expect(err.code).toBe('invalid_password');
        expect(err.status).toBe(401);
      }
      expect(onUnauthorized).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('sends POST to /auth/logout', async () => {
      handler = (url, init) => {
        expect(url).toContain('/auth/logout');
        expect(init?.method).toBe('POST');
        return { status: 200, body: { authenticated: false } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.logout();
    });
  });

  describe('getStatus', () => {
    it('returns SystemStatus', async () => {
      const statusBody = {
        authenticated: true,
        authRequired: false,
        language: 'en',
        features: { embedding: true, relations: false, debug: true },
        config: { maxTextInputLength: 20000 },
      };
      handler = () => ({ status: 200, body: statusBody });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.getStatus();
      expect(result).toEqual(statusBody);
    });
  });

  // --- Health ---

  describe('health', () => {
    it('returns HealthStatus', async () => {
      handler = () => ({ status: 200, body: { status: 'ok' } });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.health();
      expect(result).toEqual({ status: 'ok' });
    });

    it('throws on unhealthy server', async () => {
      handler = () => ({
        status: 503,
        body: { type: 'error', code: 'worker_not_running', message: 'Worker is not running' },
      });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await expect(client.health()).rejects.toThrow(GoldpanApiError);
    });
  });

  // --- Input ---

  describe('input', () => {
    it('sends text and returns query result', async () => {
      const queryBody = {
        type: 'query',
        query: 'what is AI?',
        answer: 'AI is...',
        confidence: 'high',
        citedEntityIds: [1],
        citedPointIds: [10],
      };
      handler = (_url, init) => {
        const body = JSON.parse(init?.body as string);
        expect(body.input).toBe('what is AI?');
        return { status: 200, body: queryBody };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.input({ input: 'what is AI?' });
      expect(result.type).toBe('query');
    });

    it('returns submit result', async () => {
      const submitBody = {
        type: 'submit',
        status: 'accepted',
        taskId: 42,
        warnings: [],
      };
      handler = () => ({ status: 201, body: submitBody });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.input({ input: 'https://example.com' });
      expect(result.type).toBe('submit');
    });

    it('throws on error type response', async () => {
      handler = () => ({
        status: 400,
        body: {
          type: 'error',
          code: 'input_empty',
          message: 'Processing failed',
          conversationId: 42,
        },
      });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await expect(client.input({ input: '' })).rejects.toThrow(GoldpanApiError);
      try {
        await client.input({ input: '' });
      } catch (e) {
        const err = e as GoldpanApiError;
        expect(err.code).toBe('input_empty');
        expect(err.data?.conversationId).toBe(42);
      }
    });

    // Regression: the server returns HTTP 409 with a submit-shaped JSON body
    // when a URL was already submitted. This is a legitimate business result,
    // not an error — callers need the `duplicate` status to render a message.
    it('returns duplicate submit result on HTTP 409', async () => {
      handler = () => ({
        status: 409,
        body: { type: 'submit', status: 'duplicate', message: 'Already submitted' },
      });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.input({ input: 'https://example.com' });
      expect(result.type).toBe('submit');
      if (result.type === 'submit' && result.status === 'duplicate') {
        expect(result.message).toBe('Already submitted');
      } else {
        expect.fail('expected submit/duplicate result');
      }
    });

    // Regression: /input returns HTTP 400 with a submit-shaped body when the
    // URL is malformed or blocked. Same handling as 409 — return, don't throw.
    it('returns rejected submit result on HTTP 400', async () => {
      handler = () => ({
        status: 400,
        body: { type: 'submit', status: 'rejected', code: 'url_invalid', reason: 'Bad URL' },
      });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.input({ input: 'not-a-url' });
      expect(result.type).toBe('submit');
      if (result.type === 'submit' && result.status === 'rejected') {
        expect(result.code).toBe('url_invalid');
        expect(result.reason).toBe('Bad URL');
      } else {
        expect.fail('expected submit/rejected result');
      }
    });

    it('forwards abort signal', async () => {
      handler = () => ({ status: 200, body: { type: 'content', text: 'hi' } });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const controller = new AbortController();
      controller.abort();
      await expect(client.input({ input: 'test' }, controller.signal)).rejects.toThrow();
    });

    it('calls onUnauthorized and preserves server code/message on 401', async () => {
      handler = () => ({
        status: 401,
        body: { type: 'error', code: 'expired_session', message: 'Session expired' },
      });
      const onUnauthorized = vi.fn();
      const client = new GoldpanClient({
        baseUrl: 'http://localhost:3001',
        onUnauthorized,
      });
      try {
        await client.input({ input: 'test' });
        expect.fail('expected to throw');
      } catch (e) {
        const err = e as GoldpanApiError;
        expect(err).toBeInstanceOf(GoldpanApiError);
        expect(err.code).toBe('expired_session');
        expect(err.message).toBe('Session expired');
        expect(err.status).toBe(401);
      }
      expect(onUnauthorized).toHaveBeenCalledOnce();
    });

    // P4: clarify chip click 透传 forcedIntent + payload 到 server。两个字段
    // 在 API surface 必须成对（plan §22）—— 这里 assert POST body 真带过去了，
    // 不会因 client.input 的 req 解构丢字段或类型签名遗漏而沉默 drop。
    it('forwards forcedIntent + payload in POST body (P4 chip path)', async () => {
      let captured: Record<string, unknown> | undefined;
      handler = (_url, init) => {
        captured = JSON.parse(init?.body as string) as Record<string, unknown>;
        return {
          status: 200,
          body: { type: 'content', text: 'ok' },
        };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.input({
        input: 'resolve clarify',
        forcedIntent: 'resolve_tracking_entity',
        payload: '{"ruleId":42,"entityId":7}',
      });
      expect(captured).toMatchObject({
        input: 'resolve clarify',
        forcedIntent: 'resolve_tracking_entity',
        payload: '{"ruleId":42,"entityId":7}',
      });
    });

    it('omits forcedIntent / payload when caller does not supply them', async () => {
      let captured: Record<string, unknown> | undefined;
      handler = (_url, init) => {
        captured = JSON.parse(init?.body as string) as Record<string, unknown>;
        return { status: 200, body: { type: 'content', text: 'ok' } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.input({ input: 'plain free text' });
      expect(captured).toEqual({ input: 'plain free text' });
      expect(captured).not.toHaveProperty('forcedIntent');
      expect(captured).not.toHaveProperty('payload');
    });
  });

  describe('tasks', () => {
    it('forwards abort signal to getTasks', async () => {
      const controller = new AbortController();
      handler = (_url, init) => {
        expect(init?.signal).toBe(controller.signal);
        return { status: 200, body: { data: [], total: 0 } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.getTasks({ limit: 20 }, controller.signal);
    });
  });

  // --- Submit ---

  describe('submit', () => {
    it('returns accepted result', async () => {
      handler = (_url, init) => {
        const body = JSON.parse(init?.body as string);
        expect(body.input).toBe('https://example.com');
        return { status: 201, body: { status: 'accepted', taskId: 1, warnings: [] } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.submit('https://example.com');
      expect(result.status).toBe('accepted');
      if (result.status === 'accepted') {
        expect(result.taskId).toBe(1);
      }
    });

    it('returns duplicate result', async () => {
      handler = () => ({
        status: 409,
        body: { status: 'duplicate', message: 'Duplicate URL' },
      });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.submit('https://example.com');
      expect(result.status).toBe('duplicate');
    });

    it('returns rejected result', async () => {
      handler = () => ({
        status: 400,
        body: { status: 'rejected', code: 'url_invalid', reason: 'Invalid URL' },
      });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.submit('not-a-url');
      expect(result.status).toBe('rejected');
    });

    it('throws on server error', async () => {
      handler = () => ({
        status: 500,
        body: { type: 'error', code: 'internal', message: 'Internal error' },
      });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await expect(client.submit('test')).rejects.toThrow(GoldpanApiError);
    });

    it('calls onUnauthorized and preserves server code/message on 401', async () => {
      handler = () => ({
        status: 401,
        body: { type: 'error', code: 'expired_session', message: 'Session expired' },
      });
      const onUnauthorized = vi.fn();
      const client = new GoldpanClient({
        baseUrl: 'http://localhost:3001',
        onUnauthorized,
      });
      try {
        await client.submit('test');
        expect.fail('expected to throw');
      } catch (e) {
        const err = e as GoldpanApiError;
        expect(err).toBeInstanceOf(GoldpanApiError);
        expect(err.code).toBe('expired_session');
        expect(err.message).toBe('Session expired');
        expect(err.status).toBe(401);
      }
      expect(onUnauthorized).toHaveBeenCalledOnce();
    });
  });

  // --- Query ---

  describe('query', () => {
    it('returns QueryResult', async () => {
      const body = {
        type: 'query',
        answer: 'The answer is 42',
        confidence: 'high',
        citedEntityIds: [1, 2],
        citedPointIds: [10, 20],
      };
      handler = (_url, init) => {
        const parsed = JSON.parse(init?.body as string);
        expect(parsed.query).toBe('meaning of life');
        return { status: 200, body };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.query('meaning of life');
      expect(result.answer).toBe('The answer is 42');
      expect(result.confidence).toBe('high');
    });
  });

  // --- Tasks ---

  describe('getTasks', () => {
    it('returns paginated task list', async () => {
      const tasks = [
        {
          id: 1,
          sourceId: 1,
          status: 'done',
          createdAt: '2025-01-01',
          pipelineStep: null,
          inputType: 'url',
          result: null,
          errorKind: null,
          source: null,
        },
      ];
      handler = () => ({ status: 200, body: { data: tasks, total: 1 } });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.getTasks();
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('passes limit query parameter', async () => {
      handler = (url) => {
        expect(url).toContain('limit=10');
        return { status: 200, body: { data: [], total: 0 } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.getTasks({ limit: 10 });
    });
  });

  describe('getTask', () => {
    it('returns task detail with source fields', async () => {
      const body = {
        status: 'done',
        taskId: '1',
        sourceId: 42,
        sourceUrl: 'https://example.com/article',
        createdAt: '2025-01-01',
        result: { stats: { extracted: 5 } },
        sourceStatus: 'confirmed',
        logs: [],
      };
      handler = (url) => {
        expect(url).toContain('/tasks/1');
        return { status: 200, body };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.getTask(1);
      expect(result.status).toBe('done');
      expect(result.sourceId).toBe(42);
      expect(result.sourceUrl).toBe('https://example.com/article');
    });
  });

  describe('retryTask', () => {
    it('sends POST to /tasks/:id/retry', async () => {
      handler = (url, init) => {
        expect(url).toContain('/tasks/5/retry');
        expect(init?.method).toBe('POST');
        return { status: 200, body: { ok: true } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.retryTask(5);
    });
  });

  describe('deleteTask', () => {
    it('sends DELETE to /tasks/:id', async () => {
      handler = (url, init) => {
        expect(url).toContain('/tasks/3');
        expect(init?.method).toBe('DELETE');
        return { status: 200, body: { ok: true } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.deleteTask(3);
    });
  });

  describe('clearTaskLogs', () => {
    it('sends DELETE to /tasks/:id/logs', async () => {
      handler = (url, init) => {
        expect(url).toContain('/tasks/7/logs');
        expect(init?.method).toBe('DELETE');
        return { status: 200, body: { ok: true } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.clearTaskLogs(7);
    });
  });

  // --- Knowledge ---

  describe('getCategories', () => {
    it('returns CategoryTree', async () => {
      const categories = [
        {
          id: 1,
          name: 'Tech',
          path: 'Tech',
          parentId: null,
          createdAt: '2025-01-01',
          updatedAt: '2025-01-01',
        },
      ];
      handler = () => ({ status: 200, body: { data: categories, total: 1 } });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.getCategories();
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe('Tech');
    });
  });

  describe('getEntities', () => {
    it('returns paginated entity list', async () => {
      const entities = [{ id: 1, name: 'OpenAI', categoryPaths: ['Tech/AI'], activePointCount: 5 }];
      handler = () => ({ status: 200, body: { data: entities, total: 1 } });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.getEntities();
      expect(result.data[0].name).toBe('OpenAI');
    });

    it('passes category filter', async () => {
      handler = (url) => {
        expect(url).toContain('category=3');
        return { status: 200, body: { data: [], total: 0 } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.getEntities({ category: 3 });
    });
  });

  describe('getEntity', () => {
    it('returns entity detail', async () => {
      const body = {
        entity: {
          id: 1,
          name: 'OpenAI',
          description: 'AI company',
          aliases: [],
          keywords: ['ai'],
          categoryPaths: ['Tech'],
        },
        points: [
          {
            id: 10,
            content: 'Founded in 2015',
            type: 'fact',
            status: 'active',
            createdAt: '2025-01-01',
          },
        ],
        sources: [{ id: 100, originalUrl: 'https://example.com', status: 'confirmed' }],
        relations: [],
      };
      handler = (url) => {
        expect(url).toContain('/entities/1');
        return { status: 200, body };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.getEntity(1);
      expect(result.entity.name).toBe('OpenAI');
      expect(result.points).toHaveLength(1);
    });
  });

  describe('discardSource', () => {
    it('sends POST to /sources/:sourceId/discard', async () => {
      handler = (url, init) => {
        expect(url).toContain('/sources/42/discard');
        expect(init?.method).toBe('POST');
        return { status: 200, body: { ok: true } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.discardSource(42);
    });
  });

  describe('listSources', () => {
    const emptyResponse = {
      status: 200 as const,
      body: {
        data: [],
        total: 0,
        counts: {
          processing: 0,
          confirmed: 0,
          confirmed_empty: 0,
          failed: 0,
          discarded: 0,
        },
      },
    };

    it('joins array status with comma in querystring', async () => {
      handler = (url) => {
        expect(url).toContain('status=confirmed%2Cconfirmed_empty');
        return emptyResponse;
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.listSources({ status: ['confirmed', 'confirmed_empty'] });
    });

    it('passes single string status as a plain value', async () => {
      handler = (url) => {
        expect(url).toContain('status=confirmed');
        expect(url).not.toContain('%2C');
        return emptyResponse;
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.listSources({ status: 'confirmed' });
    });

    it('omits status query param when no params supplied', async () => {
      handler = (url) => {
        expect(url).not.toContain('status=');
        return emptyResponse;
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.listSources();
    });

    it('returns response shape with data, total, counts', async () => {
      handler = () => ({
        status: 200,
        body: {
          data: [],
          total: 0,
          counts: {
            processing: 1,
            confirmed: 2,
            confirmed_empty: 0,
            failed: 3,
            discarded: 4,
          },
        },
      });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.listSources();
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.counts.processing).toBe(1);
      expect(result.counts.confirmed).toBe(2);
      expect(result.counts.failed).toBe(3);
      expect(result.counts.discarded).toBe(4);
    });

    it('SOURCE_LIST_ITEM_KEYS exported from fixture matches the locked drift contract', async () => {
      // Two-sided drift detection: this side pins the SDK fixture's key-set,
      // core/tests/db/repositories/source.test.ts pins the same list against
      // real repo output. Adding a new field to `SourceListItem` (required OR
      // optional) breaks the fixture's `satisfies Required<SourceListItem>`
      // first, then dev-must-add forces fixture's keys to grow, which trips
      // this test until both pinned lists are bumped in lockstep.
      const { SOURCE_LIST_ITEM_KEYS } = await import('./fixtures/sources.fixture');
      expect(SOURCE_LIST_ITEM_KEYS).toEqual(
        [
          'createdAt',
          'entityCategoryPaths',
          'entityCount',
          'id',
          'kind',
          'kpCount',
          'normalizedUrl',
          'originalUrl',
          'origin',
          'preview',
          'status',
          'title',
          'topEntities',
        ].sort(),
      );
    });
  });

  // --- SourceView ---

  describe('listSourceView', () => {
    it('returns SourceViewListResult', async () => {
      const body = {
        data: [
          {
            id: 1,
            kind: 'user',
            title: 'My note',
            originalUrl: null,
            createdAt: '2025-01-01',
            categoryIds: [],
          },
        ],
        total: 1,
        categories: [],
        stats: { sourceCount: 1, pointCount: 3 },
      };
      handler = () => ({ status: 200, body });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.listSourceView();
      expect(result.data).toHaveLength(1);
      expect(result.stats.sourceCount).toBe(1);
    });

    it('passes category filter', async () => {
      handler = (url) => {
        expect(url).toContain('category=2');
        return {
          status: 200,
          body: { data: [], total: 0, categories: [], stats: { sourceCount: 0, pointCount: 0 } },
        };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await client.listSourceView({ category: 2 });
    });
  });

  describe('getSourceView', () => {
    it('returns SourceViewDetail', async () => {
      const body = {
        source: {
          id: 1,
          kind: 'user',
          normalizedUrl: null,
          originalUrl: null,
          title: null,
          rawContent: 'test',
          metadata: null,
          status: 'confirmed',
          createdAt: '2025-01-01',
          updatedAt: '2025-01-01',
          origin: 'user',
          trackingRuleId: null,
        },
        entities: [
          { entityId: 1, entityName: 'Test', points: [{ id: 10, content: 'fact', type: 'fact' }] },
        ],
        categoryPaths: ['Tech'],
        tags: ['ai'],
      };
      handler = (url) => {
        expect(url).toContain('/notes/1');
        return { status: 200, body };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.getSourceView(1);
      expect(result.entities).toHaveLength(1);
      expect(result.tags).toContain('ai');
    });
  });

  // --- Debug ---

  describe('getDebugTask', () => {
    it('returns DebugTaskDetail', async () => {
      const body = {
        task: {
          id: 1,
          sourceId: 1,
          status: 'done',
          pipelineStep: null,
          inputType: 'url',
          errorMessage: null,
          errorKind: null,
          createdAt: '2025-01-01',
          updatedAt: '2025-01-01',
        },
        logs: [],
        llmCalls: [],
        eventLogs: [],
        submissionLogs: [],
      };
      handler = (url) => {
        expect(url).toContain('/debug/tasks/1');
        return { status: 200, body };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.getDebugTask(1);
      expect(result.task.id).toBe(1);
    });
  });

  describe('getDebugLlmCall', () => {
    it('returns LlmCallDetail', async () => {
      const body = {
        requestBody: '{"prompt":"test"}',
        responseBody: '{"result":"ok"}',
        requestSchema: '{"type":"object"}',
      };
      handler = (url) => {
        expect(url).toContain('/debug/llm-calls/99');
        return { status: 200, body };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.getDebugLlmCall(99);
      expect(result.requestBody).toBe('{"prompt":"test"}');
    });
  });

  // --- GitHub ---

  describe('refreshGithub', () => {
    it('sends POST to /github/refresh with owner and repo', async () => {
      handler = (url, init) => {
        expect(url).toBe('http://localhost:3001/github/refresh');
        expect(init?.method).toBe('POST');
        const body = JSON.parse(init?.body as string);
        expect(body.owner).toBe('facebook');
        expect(body.repo).toBe('react');
        return {
          status: 200,
          body: { status: 'started', sourceId: 1, taskId: 2 },
        };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.refreshGithub('facebook', 'react');
      expect(result.status).toBe('started');
      if (result.status === 'started') {
        expect(result.sourceId).toBe(1);
        expect(result.taskId).toBe(2);
      }
    });
  });

  describe('refreshGithubByUrl', () => {
    it('sends POST to /github/refresh-by-url with normalizedUrl', async () => {
      handler = (url, init) => {
        expect(url).toBe('http://localhost:3001/github/refresh-by-url');
        expect(init?.method).toBe('POST');
        const body = JSON.parse(init?.body as string);
        expect(body.normalizedUrl).toBe('https://github.com/o/r');
        return {
          status: 200,
          body: { status: 'started', sourceId: 10, taskId: 20 },
        };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.refreshGithubByUrl('https://github.com/o/r');
      expect(result.status).toBe('started');
    });
  });

  describe('getGithubState', () => {
    it('sends GET to /github/state with owner and repo query params', async () => {
      handler = (url, init) => {
        expect(url).toContain('/github/state');
        expect(url).toContain('owner=o');
        expect(url).toContain('repo=r');
        expect(init?.method).toBe('GET');
        return { status: 200, body: { data: null } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const result = await client.getGithubState('o', 'r');
      expect(result).toEqual({ data: null });
    });
  });

  // The shared `installMockFetch` only models HTTP responses; retry on
  // transient network failure needs `fetch` itself to throw (how
  // `ECONNREFUSED` surfaces in undici / Node fetch). Per-test fetch impl.
  describe('retryNetworkErrors', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => {
      restore();
      originalFetch = globalThis.fetch;
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('retries on TypeError until success and returns the eventual response', async () => {
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls < 3) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch;
      const client = new GoldpanClient({
        baseUrl: 'http://localhost:3001',
        retryNetworkErrors: { attempts: 3, baseDelayMs: 1 },
      });
      const result = await client.request<{ ok: boolean }>('GET', '/x');
      expect(result).toEqual({ ok: true });
      expect(calls).toBe(3);
    });

    it('throws the last error after exhausting attempts', async () => {
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      const client = new GoldpanClient({
        baseUrl: 'http://localhost:3001',
        retryNetworkErrors: { attempts: 2, baseDelayMs: 1 },
      });
      await expect(client.request('GET', '/x')).rejects.toThrow('fetch failed');
      expect(calls).toBe(2);
    });

    it('does NOT retry HTTP error responses (only network failures)', async () => {
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return new Response('{}', { status: 500 });
      }) as unknown as typeof fetch;
      const client = new GoldpanClient({
        baseUrl: 'http://localhost:3001',
        retryNetworkErrors: { attempts: 3, baseDelayMs: 1 },
      });
      await expect(client.request('GET', '/x')).rejects.toThrow();
      expect(calls).toBe(1);
    });

    it('honours an aborted signal mid-retry — surfaces the abort, no further attempts', async () => {
      let calls = 0;
      const ac = new AbortController();
      globalThis.fetch = vi.fn(async () => {
        calls++;
        ac.abort();
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      const client = new GoldpanClient({
        baseUrl: 'http://localhost:3001',
        retryNetworkErrors: { attempts: 5, baseDelayMs: 1 },
      });
      await expect(client.request('GET', '/x', undefined, ac.signal)).rejects.toThrow(
        'fetch failed',
      );
      expect(calls).toBe(1);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// P2: handleInput / input() — v2 result variants (wait / note / tracking_pending)
//
// 这一块同时覆盖：
//   1) 运行时解析 — server 返回 wait / note / tracking_pending JSON 时，
//      GoldpanClient.input() 能透传给 caller（INPUT_RESULT_TYPES filter 已含
//      新 type，没漏的话不会被 throw 成 GoldpanApiError）。
//   2) 编译时穷举 — InputResult union 的 narrowing 包含三个新 case，外加
//      keyed clarify 字段 (questionKey / structuredOptions) additive 可用。
//      漏 case 时 expectTypeOf 报错；漏字段时访问处直接挂掉。
// ──────────────────────────────────────────────────────────────────────────────
describe('GoldpanClient.input — v2 result types', () => {
  let restore: () => void;
  let handler: FetchHandler;

  beforeEach(() => {
    handler = () => ({ status: 200, body: {} });
    const mock = installMockFetch((url, init) => handler(url, init));
    restore = mock.restore;
  });

  afterEach(() => {
    restore();
  });

  it('parses wait response', async () => {
    handler = (url) => {
      if (url.endsWith('/input')) {
        return {
          status: 200,
          body: {
            type: 'wait',
            bufferedMessageId: 42,
            expiresAt: Date.now() + 30000,
            fallbackIntent: 'create_note',
            maxWaitMs: 30000,
            waitReasonKey: 'incomplete_command',
          },
        };
      }
      return { status: 404, body: { type: 'error', code: 'not_found', message: 'not found' } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const result = await client.input({ input: '明天那个...' });
    expect(result.type).toBe('wait');
    if (result.type === 'wait') {
      expect(result.bufferedMessageId).toBe(42);
      expect(result.waitReasonKey).toBe('incomplete_command');
      expect(result.fallbackIntent).toBe('create_note');
      expect(result.maxWaitMs).toBe(30000);
    }
  });

  it('parses note response', async () => {
    handler = (url) => {
      if (url.endsWith('/input')) {
        return {
          status: 200,
          body: {
            type: 'note',
            note: {
              id: 7,
              content: 'idea',
              subtype: 'note',
              tags: [],
              linkedEntities: [],
              linkedSources: [],
              createdAt: 1700000000000,
            },
          },
        };
      }
      return { status: 404, body: { type: 'error', code: 'not_found', message: 'not found' } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const result = await client.input({ input: 'idea X' });
    expect(result.type).toBe('note');
    if (result.type === 'note') {
      expect(result.note.subtype).toBe('note');
      expect(result.note.id).toBe(7);
      expect(result.note.linkedEntities).toEqual([]);
      expect(result.note.linkedSources).toEqual([]);
    }
  });

  it('parses tracking_pending response', async () => {
    handler = (url) => {
      if (url.endsWith('/input')) {
        return {
          status: 200,
          body: {
            type: 'tracking_pending',
            trackingRuleId: 5,
            reasonKey: 'waiting_pipeline',
          },
        };
      }
      return { status: 404, body: { type: 'error', code: 'not_found', message: 'not found' } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const result = await client.input({ input: '追踪 OpenAI' });
    expect(result.type).toBe('tracking_pending');
    if (result.type === 'tracking_pending') {
      expect(result.trackingRuleId).toBe(5);
      expect(result.reasonKey).toBe('waiting_pipeline');
    }
  });

  it('parses keyed clarify fields alongside legacy fields', async () => {
    handler = (url) => {
      if (url.endsWith('/input')) {
        return {
          status: 200,
          body: {
            type: 'clarify',
            // legacy fallback —— P6 cleanup 时删
            question: '想做什么？',
            options: ['记笔记', '提交'],
            // P2 keyed —— UI 优先消费
            questionKey: 'ambiguous_intent',
            structuredOptions: [
              { intentKey: 'create_note' },
              { intentKey: 'submit_url', payload: 'https://x' },
            ],
          },
        };
      }
      return { status: 404, body: { type: 'error', code: 'not_found', message: 'not found' } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const result = await client.input({ input: '说不清楚' });
    expect(result.type).toBe('clarify');
    if (result.type === 'clarify') {
      // legacy 仍在
      expect(result.question).toBe('想做什么？');
      expect(result.options).toEqual(['记笔记', '提交']);
      // keyed 也在
      expect(result.questionKey).toBe('ambiguous_intent');
      expect(result.structuredOptions).toEqual([
        { intentKey: 'create_note' },
        { intentKey: 'submit_url', payload: 'https://x' },
      ]);
    }
  });

  // 编译时穷举：InputResult union 必须正好覆盖这 8 个 type 字面量
  //（submit/query/content/action/clarify 是 P1 的，wait/note/tracking_pending
  // 是 P2 新增）。多了少了 expectTypeOf 都会编译失败。
  it('InputResult union covers all 8 variants exhaustively', () => {
    expectTypeOf<InputResult['type']>().toEqualTypeOf<
      'submit' | 'query' | 'content' | 'action' | 'clarify' | 'wait' | 'note' | 'tracking_pending'
    >();
  });

  // 编译时字段检查：narrowing 后能拿到对应 variant 的关键字段。
  // 这函数永远不会真的执行 —— 类型推导就够了；漏字段时 tsc 会报错。
  it('narrows each variant to expose its variant-specific fields', () => {
    const _typeCheck = (r: InputResult): string => {
      switch (r.type) {
        case 'submit':
          return r.status;
        case 'query':
          return r.answer;
        case 'content':
          return r.text;
        case 'action':
          return r.message;
        case 'clarify':
          // legacy + keyed 字段都应可选可访问
          return `${r.question ?? ''}|${r.questionKey ?? ''}`;
        case 'wait':
          return `${r.bufferedMessageId}|${r.waitReasonKey}|${r.fallbackIntent}|${r.maxWaitMs}|${r.expiresAt}`;
        case 'note':
          return `${r.note.id}|${r.note.subtype}|${r.note.content}`;
        case 'tracking_pending':
          return `${r.trackingRuleId}|${r.reasonKey}`;
      }
    };
    expect(typeof _typeCheck).toBe('function');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// P3 Buffer mechanism — releaseBufferedMessage / cancelBufferedMessage
//
// 这两个 method 给 BufferedWaitIndicator 用：
//   - release: 倒计时归零 / 用户点"立即执行" → POST /conversations/buffered/:id/release
//   - cancel:  用户点"取消"                  → POST /conversations/buffered/:id/cancel
// 关键 assertion 是 URL 和 method（路由正确 + POST），response body 透传给 caller。
// ──────────────────────────────────────────────────────────────────────────────
describe('GoldpanClient buffer release / cancel', () => {
  let restore: () => void;
  let handler: FetchHandler;

  beforeEach(() => {
    handler = () => ({ status: 200, body: {} });
    const mock = installMockFetch((url, init) => handler(url, init));
    restore = mock.restore;
  });

  afterEach(() => {
    restore();
  });

  it('releaseBufferedMessage 调用 POST /conversations/buffered/:id/release', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    handler = (url, init) => {
      calls.push({ url, method: init?.method });
      if (url.endsWith('/release')) {
        return {
          status: 200,
          body: {
            executed: true,
            result: {
              type: 'note',
              note: {
                id: 7,
                content: 'release note',
                subtype: 'note',
                tags: [],
                linkedEntities: [],
                linkedSources: [],
                createdAt: 1700000000000,
              },
            },
            conversationId: 1,
          },
        };
      }
      return { status: 404, body: { type: 'error', code: 'not_found', message: 'not found' } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const out = await client.releaseBufferedMessage(42);
    expect(out.executed).toBe(true);
    expect(out.result?.type).toBe('note');
    if (out.result?.type !== 'note') throw new Error('expected note result');
    expect(out.result.note.content).toBe('release note');
    expect(calls[0]?.url).toMatch(/\/conversations\/buffered\/42\/release$/);
    expect(calls[0]?.method).toBe('POST');
  });

  it('cancelBufferedMessage 调用 cancel endpoint', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    handler = (url, init) => {
      calls.push({ url, method: init?.method });
      if (url.endsWith('/cancel')) {
        return {
          status: 200,
          body: { cancelled: true, conversationId: 1 },
        };
      }
      return { status: 404, body: { type: 'error', code: 'not_found', message: 'not found' } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const out = await client.cancelBufferedMessage(42);
    expect(out.cancelled).toBe(true);
    expect(calls[0]?.url).toMatch(/\/conversations\/buffered\/42\/cancel$/);
    expect(calls[0]?.method).toBe('POST');
  });

  it('release CAS 失败时 executed=false + reason=already_finalized', async () => {
    handler = () => ({
      status: 200,
      body: { executed: false, reason: 'already_finalized' },
    });
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const out = await client.releaseBufferedMessage(42);
    expect(out.executed).toBe(false);
    expect(out.reason).toBe('already_finalized');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// P4 Task 7: resolveTrackingClarify — UI clarify chip click → POST
// /tracking/rules/:id/resolve { entityId }. 关键断言：URL / method / 序列化的
// body 三者都对，response 透传给 caller（flat object，不是 { data } envelope）。
// ──────────────────────────────────────────────────────────────────────────────
describe('GoldpanClient resolveTrackingClarify', () => {
  let restore: () => void;
  let handler: FetchHandler;

  beforeEach(() => {
    handler = () => ({ status: 200, body: {} });
    const mock = installMockFetch((url, init) => handler(url, init));
    restore = mock.restore;
  });

  afterEach(() => {
    restore();
  });

  it('calls POST /tracking/rules/:id/resolve with entityId body', async () => {
    const calls: Array<{ url: string; method: string | undefined; body: string | undefined }> = [];
    handler = (url, init) => {
      calls.push({
        url,
        method: init?.method,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return {
        status: 200,
        body: { resolved: true, ruleId: 7, entityId: 42, entityName: 'Anthropic' },
      };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const out = await client.resolveTrackingClarify(7, 42);
    expect(out).toEqual({ resolved: true, ruleId: 7, entityId: 42, entityName: 'Anthropic' });
    expect(calls[0]?.url).toMatch(/\/tracking\/rules\/7\/resolve$/);
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ entityId: 42 });
  });
});
