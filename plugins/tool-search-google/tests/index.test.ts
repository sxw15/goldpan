import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock Playwright before any import that touches it ---
const mockPage = {
  goto: vi.fn(),
  $: vi.fn(),
  $$: vi.fn(),
  close: vi.fn(),
};

const mockBrowser = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn(),
};

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  },
}));

// Mock SharedResourceManager as a class to support `new`
const mockAcquire = vi.fn().mockResolvedValue(mockBrowser);
const mockDestroyWithCooldown = vi.fn().mockResolvedValue(undefined);
const mockManagerDestroy = vi.fn().mockResolvedValue(undefined);

class MockSharedResourceManager {
  acquire = mockAcquire;
  destroyWithCooldown = mockDestroyWithCooldown;
  destroy = mockManagerDestroy;
  get isAvailable() {
    return true;
  }
}

vi.mock('@goldpan/core/plugins', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SharedResourceManager: MockSharedResourceManager,
  };
});

describe('tool-search-google', () => {
  const mockRegisterService = vi
    .fn()
    .mockImplementation((_name: string, manager: unknown) => manager);
  const mockCapabilities = {
    pluginRegistry: { registerService: mockRegisterService },
  };
  const mockContext = { logger: console as never, pluginConfig: {} };

  beforeEach(() => {
    vi.stubEnv('GOLDPAN_GOOGLE_SEARCH_ENABLED', 'true');
    vi.stubEnv('GOLDPAN_GOOGLE_SEARCH_HOURLY_LIMIT', '20');
    vi.stubEnv('GOLDPAN_GOOGLE_SEARCH_DELAY_MIN_MS', '0');
    vi.stubEnv('GOLDPAN_GOOGLE_SEARCH_DELAY_MAX_MS', '0');

    mockPage.goto.mockReset().mockResolvedValue(undefined);
    mockPage.$.mockReset().mockResolvedValue(null);
    mockPage.$$.mockReset().mockResolvedValue([]);
    mockPage.close.mockReset().mockResolvedValue(undefined);
    mockBrowser.newPage.mockReset().mockResolvedValue(mockPage);
    mockBrowser.close.mockReset().mockResolvedValue(undefined);
    mockRegisterService
      .mockReset()
      .mockImplementation((_name: string, manager: unknown) => manager);
    mockAcquire.mockReset().mockResolvedValue(mockBrowser);
    mockDestroyWithCooldown.mockReset().mockResolvedValue(undefined);
    mockManagerDestroy.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exports goldpanPlugin with correct metadata', async () => {
    const { goldpanPlugin } = await import('../src/index');
    expect(goldpanPlugin.name).toBe('tool-search-google');
    expect(goldpanPlugin.type).toBe('tool');
    expect(goldpanPlugin.priority).toBe(5);
    expect(goldpanPlugin.requiredCapabilities).toContain('pluginRegistry');
    expect(goldpanPlugin.description).toBeTruthy();
    expect(goldpanPlugin.version).toBe('0.1.0');
  });

  it('throws on executeTool when GOLDPAN_GOOGLE_SEARCH_ENABLED != "true" (no restart needed to fix)', async () => {
    vi.stubEnv('GOLDPAN_GOOGLE_SEARCH_ENABLED', '');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.(mockContext, mockCapabilities as never);
    // Tool 仍然 register（lazy browser），只在 execute 时拒绝
    expect(goldpanPlugin.tools).toHaveLength(1);
    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(
      /disabled/,
    );
  });

  it('registers shared-browser service during initialize', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.(mockContext, mockCapabilities as never);

    expect(mockRegisterService).toHaveBeenCalledWith('shared-browser', expect.any(Object));
    expect(goldpanPlugin.tools).toHaveLength(1);
    expect(goldpanPlugin.tools[0].name).toBe('search');

    // Cleanup
    await goldpanPlugin.destroy?.();
  });

  it('executeTool parses Google search results', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.(mockContext, mockCapabilities as never);

    // No captcha
    mockPage.$.mockResolvedValue(null);

    // Mock search result elements
    const mockElement = {
      $: vi
        .fn()
        .mockResolvedValueOnce({ textContent: () => Promise.resolve('Result Title') })
        .mockResolvedValueOnce({ getAttribute: () => Promise.resolve('https://example.com') })
        .mockResolvedValueOnce({ textContent: () => Promise.resolve('Result snippet text') }),
    };
    mockPage.$$.mockResolvedValue([mockElement]);

    const result = await goldpanPlugin.executeTool('search', { query: 'test query' });
    expect(result).toBeDefined();

    const output = result as {
      results: Array<{ url: string; title: string; snippet: string }>;
      searchEngine: string;
    };
    expect(output.results).toHaveLength(1);
    expect(output.results[0].url).toBe('https://example.com');
    expect(output.results[0].title).toBe('Result Title');
    expect(output.results[0].snippet).toBe('Result snippet text');
    expect(output.searchEngine).toBe('google');

    // Verify navigation happened
    expect(mockPage.goto).toHaveBeenCalledWith(
      expect.stringContaining('google.com/search?q=test%20query'),
      expect.any(Object),
    );

    await goldpanPlugin.destroy?.();
  });

  it('filters out non-http links', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.(mockContext, mockCapabilities as never);

    mockPage.$.mockResolvedValue(null);

    const httpElement = {
      $: vi
        .fn()
        .mockResolvedValueOnce({ textContent: () => Promise.resolve('HTTP Link') })
        .mockResolvedValueOnce({ getAttribute: () => Promise.resolve('https://example.com') })
        .mockResolvedValueOnce({ textContent: () => Promise.resolve('snippet') }),
    };
    const nonHttpElement = {
      $: vi
        .fn()
        .mockResolvedValueOnce({ textContent: () => Promise.resolve('Bad Link') })
        .mockResolvedValueOnce({ getAttribute: () => Promise.resolve('/relative/path') })
        .mockResolvedValueOnce({ textContent: () => Promise.resolve('snippet') }),
    };
    mockPage.$$.mockResolvedValue([httpElement, nonHttpElement]);

    const result = await goldpanPlugin.executeTool('search', { query: 'test' });
    const output = result as { results: Array<{ url: string }> };
    expect(output.results).toHaveLength(1);
    expect(output.results[0].url).toBe('https://example.com');

    await goldpanPlugin.destroy?.();
  });

  it('throws when hourly limit is reached', async () => {
    vi.stubEnv('GOLDPAN_GOOGLE_SEARCH_HOURLY_LIMIT', '1');

    // Need resetModules + re-import so module-level state resets with new env
    vi.resetModules();
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.(mockContext, mockCapabilities as never);

    // No captcha
    mockPage.$.mockResolvedValue(null);
    mockPage.$$.mockResolvedValue([]);

    // First search succeeds, consuming the only allowed request
    await goldpanPlugin.executeTool('search', { query: 'first' });

    // Second search should hit the limit
    await expect(goldpanPlugin.executeTool('search', { query: 'second' })).rejects.toThrow(
      /Hourly search limit/,
    );

    await goldpanPlugin.destroy?.();
  });

  it('honors zero delay settings instead of falling back to defaults', async () => {
    vi.resetModules();
    vi.stubEnv('GOLDPAN_GOOGLE_SEARCH_DELAY_MIN_MS', '0');
    vi.stubEnv('GOLDPAN_GOOGLE_SEARCH_DELAY_MAX_MS', '0');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.(mockContext, mockCapabilities as never);
    mockPage.$.mockResolvedValue(null);
    mockPage.$$.mockResolvedValue([]);

    await goldpanPlugin.executeTool('search', { query: 'first' });
    timeoutSpy.mockClear();
    await goldpanPlugin.executeTool('search', { query: 'second' });

    expect(timeoutSpy).not.toHaveBeenCalled();
    randomSpy.mockRestore();
    timeoutSpy.mockRestore();
    await goldpanPlugin.destroy?.();
  });

  it('detects CAPTCHA and triggers cooldown', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.(mockContext, mockCapabilities as never);

    // Return a truthy element to simulate captcha presence
    mockPage.$.mockResolvedValue({ tagName: 'FORM' });

    await expect(goldpanPlugin.executeTool('search', { query: 'captcha test' })).rejects.toThrow(
      /CAPTCHA/,
    );
    expect(mockDestroyWithCooldown).toHaveBeenCalled();
    expect(mockPage.close).toHaveBeenCalled();

    await goldpanPlugin.destroy?.();
  });

  it('throws on unknown tool name', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.(mockContext, mockCapabilities as never);

    await expect(goldpanPlugin.executeTool('unknown-tool', {})).rejects.toThrow(/Unknown tool/);

    await goldpanPlugin.destroy?.();
  });

  it('throws when plugin not initialized', async () => {
    vi.resetModules();
    const { goldpanPlugin } = await import('../src/index');

    // Don't call initialize — browserManager is null
    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(
      /not initialized/,
    );
  });

  it('destroy releases browserManager (tools stay statically registered)', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.(mockContext, mockCapabilities as never);

    expect(goldpanPlugin.tools).toHaveLength(1);

    await goldpanPlugin.destroy?.();

    expect(mockManagerDestroy).toHaveBeenCalled();
    // tools 是 plugin definition 上的静态字段，destroy 不再清空 —— 让 ENABLED
    // 开关可以热更，registry 不需要重新 register 整个 plugin。
    expect(goldpanPlugin.tools).toHaveLength(1);
  });

  it('always closes page even on error', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.(mockContext, mockCapabilities as never);

    // Simulate captcha (will throw)
    mockPage.$.mockResolvedValue({ tagName: 'FORM' });

    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow();
    expect(mockPage.close).toHaveBeenCalled();

    await goldpanPlugin.destroy?.();
  });
});
