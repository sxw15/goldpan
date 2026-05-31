// packages/web-sdk/tests/client.interest.test.ts
//
// T4 SDK tests for the 8 Interest CRUD + lifecycle methods. Pairs with the
// fixture in `./fixtures/interest.fixture.ts` and the three-side duck-typing
// contract asserted in plugin / server / SDK.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoldpanClient } from '../src/client';
import { GoldpanApiError } from '../src/errors';
import {
  INTEREST_DETAIL_KEYS,
  INTEREST_KEYS,
  INTEREST_LIST_ITEM_KEYS,
  interestDetailFixture,
  interestFixture,
  interestListItemFixture,
} from './fixtures/interest.fixture';
import { type FetchHandler, installMockFetch } from './helpers/mock-fetch';

describe('GoldpanClient Interest methods', () => {
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

  // --- getInterests ---

  describe('getInterests', () => {
    it('GETs /tracking/rules and returns { data, total } (round-trip fixture preserves list-item key set)', async () => {
      handler = (url, init) => {
        expect(url).toBe('http://localhost:3001/tracking/rules');
        expect(init?.method).toBe('GET');
        return { status: 200, body: { data: [interestListItemFixture], total: 1 } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const res = await client.getInterests();
      expect(res.data).toEqual([interestListItemFixture]);
      expect(res.total).toBe(1);
      // Drift defense: SDK must not drop or rename keys on deserialization.
      expect(Object.keys(res.data[0]).sort()).toEqual(INTEREST_LIST_ITEM_KEYS);
    });

    it('falls back to data.length when server omits total', async () => {
      handler = () => ({ status: 200, body: { data: [interestListItemFixture] } });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const res = await client.getInterests();
      expect(res.total).toBe(1);
    });
  });

  // --- getInterest ---

  describe('getInterest', () => {
    it('GETs /tracking/rules/:id and unwraps { data } to InterestDetail (round-trip preserves detail + inner Interest key sets)', async () => {
      handler = (url, init) => {
        expect(url).toBe('http://localhost:3001/tracking/rules/42');
        expect(init?.method).toBe('GET');
        return { status: 200, body: { data: interestDetailFixture } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const res = await client.getInterest(42);
      expect(res).toEqual(interestDetailFixture);
      expect(Object.keys(res).sort()).toEqual(INTEREST_DETAIL_KEYS);
      expect(Object.keys(res.interest).sort()).toEqual(INTEREST_KEYS);
    });

    it('throws GoldpanApiError with code "not_found" on 404', async () => {
      handler = () => ({
        status: 404,
        body: { type: 'error', code: 'not_found', message: 'Interest not found' },
      });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await expect(client.getInterest(99999)).rejects.toThrow(GoldpanApiError);
      try {
        await client.getInterest(99999);
      } catch (e) {
        expect((e as GoldpanApiError).code).toBe('not_found');
        expect((e as GoldpanApiError).status).toBe(404);
      }
    });
  });

  // --- createInterest ---

  describe('createInterest', () => {
    it('POSTs JSON body to /tracking/rules and unwraps { data }', async () => {
      handler = (url, init) => {
        expect(url).toBe('http://localhost:3001/tracking/rules');
        expect(init?.method).toBe('POST');
        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({ name: 'New Rule', searchQueries: ['x', 'y'] });
        return { status: 201, body: { data: interestFixture } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const res = await client.createInterest({ name: 'New Rule', searchQueries: ['x', 'y'] });
      expect(res).toEqual(interestFixture);
      expect(Object.keys(res).sort()).toEqual(INTEREST_KEYS);
    });

    it('propagates 400 validation_error as GoldpanApiError', async () => {
      handler = () => ({
        status: 400,
        body: {
          type: 'error',
          code: 'validation_error',
          message: 'Required fields: name (string) and searchQueries (string[])',
        },
      });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await expect(client.createInterest({ name: '', searchQueries: [] })).rejects.toBeInstanceOf(
        GoldpanApiError,
      );
    });
  });

  // --- updateInterest ---

  describe('updateInterest', () => {
    it('PUTs JSON body to /tracking/rules/:id and unwraps { data }', async () => {
      handler = (url, init) => {
        expect(url).toBe('http://localhost:3001/tracking/rules/1');
        expect(init?.method).toBe('PUT');
        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({ name: 'Renamed' });
        return { status: 200, body: { data: { ...interestFixture, id: 1, name: 'Renamed' } } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const res = await client.updateInterest(1, { name: 'Renamed' });
      expect(res.name).toBe('Renamed');
    });
  });

  // --- deleteInterest ---

  describe('deleteInterest', () => {
    it('DELETEs /tracking/rules/:id and returns void on 204', async () => {
      handler = (url, init) => {
        expect(url).toBe('http://localhost:3001/tracking/rules/7');
        expect(init?.method).toBe('DELETE');
        return { status: 204 };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await expect(client.deleteInterest(7)).resolves.toBeUndefined();
    });
  });

  // --- enableInterest / disableInterest ---

  describe('enableInterest', () => {
    it('POSTs /tracking/rules/:id/enable and unwraps { data } to Interest', async () => {
      handler = (url, init) => {
        expect(url).toBe('http://localhost:3001/tracking/rules/5/enable');
        expect(init?.method).toBe('POST');
        return { status: 200, body: { data: { ...interestFixture, id: 5, enabled: true } } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const res = await client.enableInterest(5);
      expect(res.enabled).toBe(true);
      expect(res.id).toBe(5);
    });
  });

  describe('disableInterest', () => {
    it('POSTs /tracking/rules/:id/disable and unwraps { data } to Interest', async () => {
      handler = (url, init) => {
        expect(url).toBe('http://localhost:3001/tracking/rules/5/disable');
        expect(init?.method).toBe('POST');
        return { status: 200, body: { data: { ...interestFixture, id: 5, enabled: false } } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      const res = await client.disableInterest(5);
      expect(res.enabled).toBe(false);
    });
  });

  // --- triggerInterest ---

  describe('triggerInterest', () => {
    it('POSTs /tracking/rules/:id/run and returns void', async () => {
      handler = (url, init) => {
        expect(url).toBe('http://localhost:3001/tracking/rules/3/run');
        expect(init?.method).toBe('POST');
        return { status: 202, body: { triggered: true, message: 'Execution triggered' } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await expect(client.triggerInterest(3)).resolves.toBeUndefined();
    });

    // 409 scheduler_disabled is a legitimate business response the caller
    // must see (to surface "scheduler disabled" UI). The SDK MUST NOT
    // swallow it — it surfaces as a GoldpanApiError with that code.
    it('propagates 409 scheduler_disabled as GoldpanApiError (caller must catch)', async () => {
      handler = () => ({
        status: 409,
        body: {
          type: 'error',
          code: 'scheduler_disabled',
          message: 'Tracking scheduler is not enabled',
        },
      });
      const client = new GoldpanClient({ baseUrl: 'http://localhost:3001' });
      await expect(client.triggerInterest(3)).rejects.toThrow(GoldpanApiError);
      try {
        await client.triggerInterest(3);
      } catch (e) {
        const err = e as GoldpanApiError;
        expect(err.code).toBe('scheduler_disabled');
        expect(err.status).toBe(409);
      }
    });
  });
});
