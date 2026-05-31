import { describe, expect, it, vi } from 'vitest';
import { fetchBotOpenId } from '../src/bot-identity.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

describe('fetchBotOpenId', () => {
  it('returns the open_id from a successful SDK call', async () => {
    const fetcher = vi.fn().mockResolvedValue({ open_id: 'ou_bot_xyz' });
    const id = await fetchBotOpenId({ fetcher, logger: stubLogger });
    expect(id).toBe('ou_bot_xyz');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when the SDK call rejects', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));
    await expect(fetchBotOpenId({ fetcher, logger: stubLogger })).rejects.toThrow(
      /Feishu adapter: failed to fetch bot identity.*401 Unauthorized/,
    );
  });

  it('throws when the SDK returns no open_id', async () => {
    const fetcher = vi.fn().mockResolvedValue({});
    await expect(fetchBotOpenId({ fetcher, logger: stubLogger })).rejects.toThrow(
      /missing open_id/,
    );
  });
});
