import { initI18n, resetI18n } from '@goldpan/core/i18n';
import type { ServiceCallLlmFn } from '@goldpan/core/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCheckTracking, handleManageTracking } from '../src/intent-handler';
import {
  compilePluginPrompt,
  computePluginPromptHash,
  loadPluginPrompt,
} from '../src/prompt-loader';
import type { Interest, TrackingService } from '../src/types';
import { TrackingServiceError } from '../src/types';

// ─── Helpers ─────────────────────────────────────────────

function makeInterest(overrides: Partial<Interest> = {}): Interest {
  return {
    id: 1,
    name: 'AI News',
    description: null,
    searchQueries: ['ai', 'llm'],
    toolProvider: null,
    intervalMinutes: 60,
    enabled: true,
    status: 'idle',
    lastRunAt: null,
    nextRunAt: '2025-01-01 00:00:00',
    linkedEntityIds: [],
    createdAt: '2025-01-01 00:00:00',
    updatedAt: '2025-01-01 00:00:00',
    ...overrides,
  };
}

function createMockService(interests: Interest[] = []): TrackingService {
  return {
    getInterests: vi.fn(() => interests),
    getInterest: vi.fn((id: number) => interests.find((r) => r.id === id)),
    createInterest: vi.fn((data) =>
      makeInterest({ name: data.name, searchQueries: data.searchQueries }),
    ),
    updateInterest: vi.fn((id, _data) => makeInterest({ id })),
    deleteInterest: vi.fn(),
    enableInterest: vi.fn((id) => makeInterest({ id, enabled: true })),
    disableInterest: vi.fn((id) => makeInterest({ id, enabled: false })),
    triggerExecution: vi.fn(),
    getExecution: vi.fn(),
    getInterestExecutions: vi.fn(() => ({ executions: [], total: 0 })),
    startScheduler: vi.fn(),
    drainScheduler: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockCallLlm() {
  const fn = vi.fn() as unknown as ServiceCallLlmFn & {
    mockResolvedOutput: (output: unknown) => void;
    mockRejectedError: (error: Error) => void;
    mockResolvedValue: (output: unknown) => void;
    mockRejectedValue: (error: Error) => void;
  };
  (fn as unknown as { mockResolvedOutput: (v: unknown) => void }).mockResolvedOutput = (
    output: unknown,
  ) => (fn as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(output);
  (fn as unknown as { mockRejectedError: (v: Error) => void }).mockRejectedError = (error: Error) =>
    (fn as unknown as { mockRejectedValue: (v: Error) => void }).mockRejectedValue(error);
  return fn;
}

// ─── Tests ───────────────────────────────────────────────

beforeEach(() => {
  resetI18n();
  initI18n('en');
});

describe('prompt files', () => {
  it('loads all 4 prompt files (en)', () => {
    const sysEn = loadPluginPrompt('tracking_action_parser', true);
    const userEn = loadPluginPrompt('tracking_action_parser', false);
    expect(sysEn).toContain('tracking interest parser');
    expect(userEn).toContain('gp_user_input');
  });

  it('loads all 4 prompt files (zh)', () => {
    resetI18n();
    initI18n('zh');
    const sysZh = loadPluginPrompt('tracking_action_parser', true);
    const userZh = loadPluginPrompt('tracking_action_parser', false);
    expect(sysZh).toContain('追踪项解析器');
    expect(userZh).toContain('gp_user_input');
  });

  it('compiles user template with variables', () => {
    const template = loadPluginPrompt('tracking_action_parser', false);
    const result = compilePluginPrompt(template, {
      input: 'track AI news',
      existingInterests: [{ id: 1, name: 'Test', searchQueries: 'ai, llm', enabled: true }],
    });
    expect(result).toContain('track AI news');
    expect(result).toContain('Interest #1');
    expect(result).toContain('enabled');
  });

  it('computes a prompt hash', () => {
    const hash = computePluginPromptHash('system', 'user');
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('handleManageTracking', () => {
  it('handles "create" action', async () => {
    const service = createMockService();
    const callLlm = createMockCallLlm();
    callLlm.mockResolvedOutput({
      action: 'create',
      name: 'AI Tracker',
      searchQueries: ['artificial intelligence', 'ml'],
    });

    const result = await handleManageTracking('Track AI news', service, callLlm);

    expect(result.type).toBe('action');
    expect(result.message).toContain('AI Tracker');
    expect(result.message).toContain('created');
    expect(service.createInterest).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'AI Tracker',
        searchQueries: ['artificial intelligence', 'ml'],
      }),
    );
  });

  it('dispatches create action with new searchQueries field shape', async () => {
    const service = createMockService();
    const callLlm: ServiceCallLlmFn = (async () => ({
      action: 'create',
      name: 'AI News',
      searchQueries: ['AI', 'LLM'],
      intervalMinutes: 30,
    })) as ServiceCallLlmFn;

    const result = await handleManageTracking('track AI news', service, callLlm);
    expect(result.type).toBe('action');
    expect(service.createInterest).toHaveBeenCalledWith({
      name: 'AI News',
      searchQueries: ['AI', 'LLM'],
      toolProvider: undefined,
      intervalMinutes: 30,
    });
  });

  it('dispatches update action with interestId field', async () => {
    const service = createMockService();
    const callLlm: ServiceCallLlmFn = (async () => ({
      action: 'update',
      interestId: 3,
      searchQueries: ['updated'],
    })) as ServiceCallLlmFn;

    await handleManageTracking('update rule 3', service, callLlm);
    expect(service.updateInterest).toHaveBeenCalledWith(3, {
      name: undefined,
      searchQueries: ['updated'],
      toolProvider: undefined,
      intervalMinutes: undefined,
    });
  });

  it('handles "list" action', async () => {
    const interests = [
      makeInterest({ id: 1, name: 'AI News' }),
      makeInterest({
        id: 2,
        name: 'Crypto',
        searchQueries: ['bitcoin'],
        enabled: false,
      }),
    ];
    const service = createMockService(interests);
    const callLlm = createMockCallLlm();
    callLlm.mockResolvedOutput({ action: 'list' });

    const result = await handleManageTracking('show my interests', service, callLlm);

    expect(result.type).toBe('content');
    expect(result.format).toBe('markdown');
    expect(result.text).toContain('AI News');
    expect(result.text).toContain('Crypto');
    expect(result.text).toContain('⏸ Disabled');
  });

  it('handles "delete" with interestId', async () => {
    const service = createMockService();
    const callLlm = createMockCallLlm();
    callLlm.mockResolvedOutput({ action: 'delete', interestId: 3 });

    const result = await handleManageTracking('delete interest #3', service, callLlm);

    expect(result.type).toBe('action');
    expect(result.message).toContain('#3');
    expect(result.message).toContain('deleted');
    expect(service.deleteInterest).toHaveBeenCalledWith(3);
  });

  it('handles "clarify" action from LLM', async () => {
    const service = createMockService();
    const callLlm = createMockCallLlm();
    callLlm.mockResolvedOutput({ action: 'clarify', question: 'What do you want to track?' });

    const result = await handleManageTracking('do something', service, callLlm);

    expect(result.type).toBe('clarify');
    expect(result.question).toBe('What do you want to track?');
  });

  it('returns clarify when create lacks name', async () => {
    const service = createMockService();
    const callLlm = createMockCallLlm();
    callLlm.mockResolvedOutput({ action: 'create', searchQueries: ['ai'] });

    const result = await handleManageTracking('track stuff', service, callLlm);

    expect(result.type).toBe('clarify');
    expect(result.question).toContain('name');
  });

  it('returns clarify when create lacks searchQueries', async () => {
    const service = createMockService();
    const callLlm = createMockCallLlm();
    callLlm.mockResolvedOutput({ action: 'create', name: 'My Interest' });

    const result = await handleManageTracking('create interest', service, callLlm);

    expect(result.type).toBe('clarify');
    expect(result.question).toContain('name');
  });

  it('returns clarify when delete lacks interestId', async () => {
    const service = createMockService();
    const callLlm = createMockCallLlm();
    callLlm.mockResolvedOutput({ action: 'delete' });

    const result = await handleManageTracking('delete an interest', service, callLlm);

    expect(result.type).toBe('clarify');
    expect(result.question).toContain('interest');
  });

  it('handles "update" action', async () => {
    const service = createMockService();
    const callLlm = createMockCallLlm();
    callLlm.mockResolvedOutput({ action: 'update', interestId: 2, name: 'Updated Name' });

    const result = await handleManageTracking('rename interest #2', service, callLlm);

    expect(result.type).toBe('action');
    expect(result.message).toContain('#2');
    expect(result.message).toContain('updated');
    expect(service.updateInterest).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ name: 'Updated Name' }),
    );
  });

  it('handles "enable" action', async () => {
    const service = createMockService();
    const callLlm = createMockCallLlm();
    callLlm.mockResolvedOutput({ action: 'enable', interestId: 5 });

    const result = await handleManageTracking('enable interest #5', service, callLlm);

    expect(result.type).toBe('action');
    expect(result.message).toContain('#5');
    expect(result.message).toContain('enabled');
    expect(service.enableInterest).toHaveBeenCalledWith(5);
  });

  it('handles "disable" action', async () => {
    const service = createMockService();
    const callLlm = createMockCallLlm();
    callLlm.mockResolvedOutput({ action: 'disable', interestId: 4 });

    const result = await handleManageTracking('disable interest #4', service, callLlm);

    expect(result.type).toBe('action');
    expect(result.message).toContain('#4');
    expect(result.message).toContain('disabled');
    expect(service.disableInterest).toHaveBeenCalledWith(4);
  });

  it('propagates LLM call failure', async () => {
    const service = createMockService();
    const callLlm = createMockCallLlm();
    callLlm.mockRejectedError(new Error('LLM timeout'));

    await expect(handleManageTracking('anything', service, callLlm)).rejects.toThrow('LLM timeout');
  });

  it('catches TrackingServiceError gracefully', async () => {
    const service = createMockService();
    (service.deleteInterest as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new TrackingServiceError('not_found', 'Interest 99 not found');
    });
    const callLlm = createMockCallLlm();
    callLlm.mockResolvedOutput({ action: 'delete', interestId: 99 });

    const result = await handleManageTracking('delete interest #99', service, callLlm);

    expect(result.type).toBe('action');
    expect(result.message).toBe('Interest 99 not found');
  });

  it('list with empty interests returns interest_list_empty', async () => {
    const service = createMockService([]);
    const callLlm = createMockCallLlm();
    callLlm.mockResolvedOutput({ action: 'list' });

    const result = await handleManageTracking('list interests', service, callLlm);

    expect(result.type).toBe('content');
    expect(result.text).toBe('No tracking interests configured yet.');
  });
});

describe('handleCheckTracking', () => {
  it('returns markdown status table', async () => {
    const interests = [
      makeInterest({ id: 1, name: 'AI News', lastRunAt: '2025-01-01 12:00:00' }),
      makeInterest({
        id: 2,
        name: 'Crypto',
        searchQueries: ['bitcoin'],
        enabled: false,
        status: 'idle',
      }),
    ];
    const service = createMockService(interests);

    const result = await handleCheckTracking(service);

    expect(result.type).toBe('content');
    expect(result.format).toBe('markdown');
    expect(result.text).toContain('Tracking Status');
    expect(result.text).toContain('AI News');
    expect(result.text).toContain('2025-01-01 12:00:00');
    expect(result.text).toContain('⏸ Disabled');
  });

  it('returns empty message when no interests', async () => {
    const service = createMockService([]);

    const result = await handleCheckTracking(service);

    expect(result.type).toBe('content');
    expect(result.text).toBe('No tracking interests configured yet.');
  });

  it('shows running status for executing interests', async () => {
    const interests = [makeInterest({ id: 1, name: 'Active Interest', status: 'executing' })];
    const service = createMockService(interests);

    const result = await handleCheckTracking(service);

    expect(result.text).toContain('🔄 Running');
  });
});
