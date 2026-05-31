import { describe, expect, it, vi } from 'vitest';
import { fetchBotInfo } from '../../src/sdk/bot-info.js';

describe('fetchBotInfo', () => {
  it('extracts open_id from the /open-apis/bot/v3/info response shape', async () => {
    const fakeClient = {
      request: vi.fn().mockResolvedValue({ code: 0, msg: 'ok', bot: { open_id: 'ou_xyz' } }),
    } as never;
    const result = await fetchBotInfo(fakeClient);
    expect(result.open_id).toBe('ou_xyz');
    expect(fakeClient.request).toHaveBeenCalledWith({
      method: 'POST',
      url: '/open-apis/bot/v3/info',
    });
  });

  it('returns undefined when response lacks open_id', async () => {
    const fakeClient = {
      request: vi.fn().mockResolvedValue({ code: 0, bot: {} }),
    } as never;
    const result = await fetchBotInfo(fakeClient);
    expect(result.open_id).toBeUndefined();
  });

  it('returns undefined when response has no `bot` field at all', async () => {
    const fakeClient = {
      request: vi.fn().mockResolvedValue({ code: 99, msg: 'error' }),
    } as never;
    const result = await fetchBotInfo(fakeClient);
    expect(result.open_id).toBeUndefined();
  });
});
