import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SharedResourceManager } from '../../src/plugins/shared-resource-manager';

describe('SharedResourceManager', () => {
  let launchCount: number;
  let destroyCount: number;
  let manager: SharedResourceManager<{ id: number }>;

  beforeEach(() => {
    launchCount = 0;
    destroyCount = 0;
    manager = new SharedResourceManager({
      launcher: async () => {
        launchCount++;
        return { id: launchCount };
      },
      destroyer: async () => {
        destroyCount++;
      },
      cooldownMs: 100,
    });
  });

  afterEach(async () => {
    try {
      await manager.destroy();
    } catch {
      /* ok */
    }
  });

  it('acquire() launches on first call', async () => {
    const resource = await manager.acquire();
    expect(resource.id).toBe(1);
    expect(launchCount).toBe(1);
  });

  it('second acquire() returns same instance', async () => {
    const r1 = await manager.acquire();
    const r2 = await manager.acquire();
    expect(r1).toBe(r2);
    expect(launchCount).toBe(1);
  });

  it('destroy() cleans up without cooldown', async () => {
    await manager.acquire();
    await manager.destroy();
    expect(destroyCount).toBe(1);
    expect(manager.isAvailable).toBe(false);
    // Can re-acquire immediately (no cooldown)
    const r = await manager.acquire();
    expect(r.id).toBe(2);
  });

  it('destroyWithCooldown() blocks acquire during cooldown', async () => {
    await manager.acquire();
    await manager.destroyWithCooldown();
    expect(destroyCount).toBe(1);
    await expect(manager.acquire()).rejects.toThrow(/cooldown/i);
  });

  it('acquire works after cooldown expires', async () => {
    await manager.acquire();
    await manager.destroyWithCooldown();
    await new Promise((r) => setTimeout(r, 150)); // wait > cooldownMs
    const resource = await manager.acquire();
    expect(resource.id).toBe(2);
  });

  it('concurrent acquire() calls only launch once', async () => {
    const [r1, r2, r3] = await Promise.all([
      manager.acquire(),
      manager.acquire(),
      manager.acquire(),
    ]);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(launchCount).toBe(1);
  });

  it('isAvailable reflects state', async () => {
    expect(manager.isAvailable).toBe(false);
    await manager.acquire();
    expect(manager.isAvailable).toBe(true);
    await manager.destroy();
    expect(manager.isAvailable).toBe(false);
  });

  it('destroy() waits for stale resource cleanup before returning', async () => {
    let destroyerDone = false;
    const slowManager = new SharedResourceManager({
      launcher: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { id: 1 };
      },
      destroyer: async () => {
        await new Promise((r) => setTimeout(r, 100));
        destroyerDone = true;
      },
      cooldownMs: 0,
    });

    const acquiring = slowManager.acquire().catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    await slowManager.destroy();
    await acquiring;
    expect(destroyerDone).toBe(true);
  });

  it('launcher failure enters cooldown (prevents rapid retry)', async () => {
    const failManager = new SharedResourceManager({
      launcher: async () => {
        throw new Error('OOM');
      },
      destroyer: async () => {},
      cooldownMs: 100,
    });
    await expect(failManager.acquire()).rejects.toThrow('OOM');
    // Immediate retry should be blocked by cooldown
    await expect(failManager.acquire()).rejects.toThrow(/cooldown/i);
    // After cooldown expires, acquire retries the launcher
    await new Promise((r) => setTimeout(r, 150));
    await expect(failManager.acquire()).rejects.toThrow('OOM'); // still fails, but was attempted
  });
});
