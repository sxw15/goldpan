import { initI18n, resetI18n } from '@goldpan/core/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDB } from '../../../packages/core/tests/helpers/test-db';
import { goldpanPlugin } from '../src/index';

// ─── Helpers ─────────────────────────────────────────────

function createMockCallLlm() {
  const fn = vi.fn() as any;
  fn.mockResolvedOutput = (output: unknown) => fn.mockResolvedValue(output);
  fn.mockRejectedError = (error: Error) => fn.mockRejectedValue(error);
  return fn;
}

function createMockPluginRegistry() {
  return {
    registerService: vi.fn((_name: string, svc: unknown) => svc),
    resolveToolProvider: vi.fn(),
  };
}

// Tracking's `initialize` subscribes to `context.configStore.onChange` for an
// observability log line. These intent / wiring tests don't need a real
// ConfigStore — a no-op stub keeps them focused on the registry contract.
function makeStubContext(logger: unknown = console) {
  return {
    logger: logger as never,
    pluginConfig: {},
    configStore: {
      getSnapshot: () => ({ config: {}, origins: new Map(), generation: 0 }),
      commit: async () => ({ kind: 'ok' as const, snapshot: {} as never }),
      onChange: () => () => {},
      refresh: async () => ({ config: {}, origins: new Map(), generation: 0 }) as never,
      setPluginEnvKeys: () => {},
    } as never,
  } as never;
}

// ─── Tests ───────────────────────────────────────────────

describe('goldpanPlugin', () => {
  let db: any;
  let cleanup: () => void;
  let mockPluginRegistry: ReturnType<typeof createMockPluginRegistry>;
  let mockSubmitInput: ReturnType<typeof vi.fn>;
  let mockCallLlm: ReturnType<typeof createMockCallLlm>;

  beforeEach(() => {
    resetI18n();
    initI18n('en');
    const testDb = createTestDB();
    db = testDb.db;
    cleanup = testDb.cleanup;
    mockPluginRegistry = createMockPluginRegistry();
    mockSubmitInput = vi.fn().mockResolvedValue({ status: 'accepted', taskId: 1, sourceId: 1 });
    mockCallLlm = createMockCallLlm();
  });

  afterEach(async () => {
    // Ensure plugin is destroyed to clear module-level state
    try {
      await goldpanPlugin.destroy!();
    } catch {
      // ignore if not initialized
    }
    cleanup();
  });

  // ─── Metadata ──────────────────────────────────────────

  it('has correct metadata', () => {
    expect(goldpanPlugin.name).toBe('tracking');
    expect(goldpanPlugin.version).toBe('0.1.0');
    expect(goldpanPlugin.type).toBe('intent');
    expect(goldpanPlugin.intents).toHaveLength(3);
    expect(goldpanPlugin.requiredCapabilities).toEqual(
      expect.arrayContaining(['db', 'config', 'pluginRegistry', 'submitInput', 'callLlm']),
    );
  });

  it('declares manage_tracking, check_tracking, and create_tracking intents', () => {
    const names = goldpanPlugin.intents.map((i) => i.name);
    expect(names).toContain('manage_tracking');
    expect(names).toContain('check_tracking');
    expect(names).toContain('create_tracking');
  });

  it('manage_tracking declares correct resultTypes', () => {
    const manage = goldpanPlugin.intents.find((i) => i.name === 'manage_tracking')!;
    expect(manage.resultTypes).toEqual(expect.arrayContaining(['action', 'clarify', 'content']));
  });

  it('check_tracking declares correct resultTypes', () => {
    const check = goldpanPlugin.intents.find((i) => i.name === 'check_tracking')!;
    expect(check.resultTypes).toEqual(['content']);
  });

  it('create_tracking declares correct resultTypes including tracking_pending', () => {
    const create = goldpanPlugin.intents.find((i) => i.name === 'create_tracking')!;
    expect(create).toBeDefined();
    expect(create.resultTypes).toEqual(
      expect.arrayContaining(['action', 'tracking_pending', 'clarify']),
    );
    // examples / classificationHints present so classifier has data to route with
    expect(create.examples?.length ?? 0).toBeGreaterThan(0);
    expect(create.classificationHints?.length ?? 0).toBeGreaterThan(0);
    // zh description populated for Chinese classifier path
    expect(create.descriptions?.zh).toBeTruthy();
  });

  // ─── initialize ────────────────────────────────────────

  it('initialize() creates tables and registers service', async () => {
    await goldpanPlugin.initialize!(makeStubContext(), {
      db,
      config: {} as any,
      pluginRegistry: mockPluginRegistry as any,
      submitInput: mockSubmitInput,
      callLlm: mockCallLlm,
    });

    expect(mockPluginRegistry.registerService).toHaveBeenCalledWith(
      'tracking',
      expect.objectContaining({
        getInterests: expect.any(Function),
        createInterest: expect.any(Function),
      }),
    );
  });

  // ─── execute ───────────────────────────────────────────

  it('execute("manage_tracking") dispatches to handler and returns IntentPluginResult', async () => {
    await goldpanPlugin.initialize!(makeStubContext(), {
      db,
      config: {} as any,
      pluginRegistry: mockPluginRegistry as any,
      submitInput: mockSubmitInput,
      callLlm: mockCallLlm,
    });

    // Mock LLM to return a "list" action (empty list → content result)
    mockCallLlm.mockResolvedOutput({ action: 'list' });

    const result = await goldpanPlugin.execute('manage_tracking', 'list my rules', {} as any);

    expect(result.type).toBe('content');
    expect((result as any).text).toBeDefined();
  });

  it('execute("manage_tracking") returns action result on create', async () => {
    await goldpanPlugin.initialize!(makeStubContext(), {
      db,
      config: {} as any,
      pluginRegistry: mockPluginRegistry as any,
      submitInput: mockSubmitInput,
      callLlm: mockCallLlm,
    });

    mockCallLlm.mockResolvedOutput({
      action: 'create',
      name: 'AI News',
      searchQueries: ['ai', 'llm'],
    });

    const result = await goldpanPlugin.execute('manage_tracking', 'Track AI news', {} as any);

    expect(result.type).toBe('action');
    expect((result as any).message).toContain('AI News');
    expect((result as any).message).toContain('created');
  });

  it('execute("manage_tracking") returns clarify result', async () => {
    await goldpanPlugin.initialize!(makeStubContext(), {
      db,
      config: {} as any,
      pluginRegistry: mockPluginRegistry as any,
      submitInput: mockSubmitInput,
      callLlm: mockCallLlm,
    });

    mockCallLlm.mockResolvedOutput({ action: 'clarify', question: 'What keywords?' });

    const result = await goldpanPlugin.execute('manage_tracking', 'track something', {} as any);

    expect(result.type).toBe('clarify');
    expect((result as any).question).toBe('What keywords?');
  });

  it('execute("check_tracking") returns content', async () => {
    await goldpanPlugin.initialize!(makeStubContext(), {
      db,
      config: {} as any,
      pluginRegistry: mockPluginRegistry as any,
      submitInput: mockSubmitInput,
      callLlm: mockCallLlm,
    });

    const result = await goldpanPlugin.execute(
      'check_tracking',
      'what is tracking status?',
      {} as any,
    );

    expect(result.type).toBe('content');
    expect((result as any).text).toBeDefined();
  });

  // ─── destroy ───────────────────────────────────────────

  it('destroy() clears state — execute throws after destroy', async () => {
    await goldpanPlugin.initialize!(makeStubContext(), {
      db,
      config: {} as any,
      pluginRegistry: mockPluginRegistry as any,
      submitInput: mockSubmitInput,
      callLlm: mockCallLlm,
    });

    await goldpanPlugin.destroy!();

    await expect(goldpanPlugin.execute('manage_tracking', 'test', {} as any)).rejects.toThrow(
      'Tracking plugin not initialized',
    );
  });

  // ─── Unknown intent ────────────────────────────────────

  it('execute with unknown intent throws', async () => {
    await goldpanPlugin.initialize!(makeStubContext(), {
      db,
      config: {} as any,
      pluginRegistry: mockPluginRegistry as any,
      submitInput: mockSubmitInput,
      callLlm: mockCallLlm,
    });

    await expect(goldpanPlugin.execute('unknown_intent', 'test', {} as any)).rejects.toThrow(
      'Unknown tracking intent: unknown_intent',
    );
  });
});
