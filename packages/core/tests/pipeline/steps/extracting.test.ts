import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineError } from '../../../src/pipeline/types.js';
import {
  createMockCallLlm,
  createMockLlmCallRepo,
  createTestContext,
  resetIdSequences,
} from '../fixtures/index.js';

vi.mock('../../../src/prompts/loader.js', () => ({
  loadPromptTemplate: vi.fn().mockReturnValue('mock extractor template'),
  compilePrompt: vi
    .fn()
    .mockImplementation((_t: string, vars: any) => `compiled: ${JSON.stringify(vars)}`),
  computePromptHash: vi.fn().mockReturnValue('abc12345'),
}));

describe('extracting step', () => {
  let mockLlm: ReturnType<typeof createMockCallLlm>;
  let llmCallRepo: ReturnType<typeof createMockLlmCallRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdSequences();
    mockLlm = createMockCallLlm();
    llmCallRepo = createMockLlmCallRepo();
  });

  it('extracts knowledge points and assigns pointKeys', async () => {
    const { executeExtracting } = await import('../../../src/pipeline/steps/extracting.js');
    mockLlm.mockResolvedOutput({
      points: [
        { content: 'Claude Code supports MCP protocol', type: 'fact' },
        { content: 'Claude Code is the best CLI tool', type: 'opinion' },
        { content: 'MCP enables plugin integration', type: 'fact' },
      ],
    });

    const ctx = createTestContext({ content: 'Article about Claude Code and MCP' });
    const result = await executeExtracting(ctx, { callLlm: mockLlm.fn, llmCallRepo });

    expect(result.points).toHaveLength(3);
    expect(result.points[0]).toEqual({
      pointKey: 'kp:0',
      content: 'Claude Code supports MCP protocol',
      type: 'fact',
    });
    expect(result.points[1]).toEqual({
      pointKey: 'kp:1',
      content: 'Claude Code is the best CLI tool',
      type: 'opinion',
    });
    expect(result.points[2]).toEqual({
      pointKey: 'kp:2',
      content: 'MCP enables plugin integration',
      type: 'fact',
    });
  });

  it('returns empty points array for zero extraction (not an error)', async () => {
    const { executeExtracting } = await import('../../../src/pipeline/steps/extracting.js');
    mockLlm.mockResolvedOutput({ points: [] });

    const ctx = createTestContext({ content: 'Just a greeting, nothing useful' });
    const result = await executeExtracting(ctx, { callLlm: mockLlm.fn, llmCallRepo });

    expect(result.points).toEqual([]);
  });

  it('throws PipelineError on LLM failure', async () => {
    const { executeExtracting } = await import('../../../src/pipeline/steps/extracting.js');
    mockLlm.mockRejectedError(new Error('LLM timeout'));

    const ctx = createTestContext({ content: 'test' });

    await expect(executeExtracting(ctx, { callLlm: mockLlm.fn, llmCallRepo })).rejects.toThrow(
      PipelineError,
    );
  });

  it('pointKey assignment is sequential starting from 0', async () => {
    const { executeExtracting } = await import('../../../src/pipeline/steps/extracting.js');
    const points = Array.from({ length: 10 }, (_, i) => ({
      content: `Point ${i}`,
      type: 'fact',
    }));
    mockLlm.mockResolvedOutput({ points });

    const ctx = createTestContext({ content: 'Long article' });
    const result = await executeExtracting(ctx, { callLlm: mockLlm.fn, llmCallRepo });

    result.points.forEach((p, i) => {
      expect(p.pointKey).toBe(`kp:${i}`);
    });
  });
});

describe('extracting.ts — incremental mode', () => {
  let llmCallRepo: ReturnType<typeof createMockLlmCallRepo>;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetIdSequences();
    llmCallRepo = createMockLlmCallRepo();

    // For this describe block we want the real template loader + real Handlebars
    // compilation + real hash function so we can verify rendered prompt content
    // and distinct hashes. The file-level vi.mock replaces these with stubs;
    // override them per-test with actual implementations.
    const actual = await vi.importActual<typeof import('../../../src/prompts/loader.js')>(
      '../../../src/prompts/loader.js',
    );
    const mocked = await import('../../../src/prompts/loader.js');
    (mocked.loadPromptTemplate as ReturnType<typeof vi.fn>).mockImplementation(
      actual.loadPromptTemplate,
    );
    (mocked.compilePrompt as ReturnType<typeof vi.fn>).mockImplementation(actual.compilePrompt);
    (mocked.computePromptHash as ReturnType<typeof vi.fn>).mockImplementation(
      actual.computePromptHash,
    );
  });

  async function executeExtractingWith({
    callLlm,
    updateMode,
  }: {
    callLlm: ReturnType<typeof vi.fn>;
    updateMode: 'initial' | 'incremental';
  }): Promise<void> {
    const { executeExtracting } = await import('../../../src/pipeline/steps/extracting.js');
    const ctx = createTestContext({
      content: 'Release notes: v18.4.0 introduced feature X.',
      updateMode,
    });
    await executeExtracting(ctx, { callLlm, llmCallRepo });
  }

  it("passes isIncrementalUpdate=true to prompt when ctx.updateMode='incremental'", async () => {
    const captured = { prompt: '', promptHash: '' };
    const callLlm = vi.fn(async (args: { prompt: string; promptHash: string }) => {
      captured.prompt = args.prompt;
      captured.promptHash = args.promptHash;
      return { points: [] };
    });
    await executeExtractingWith({ callLlm, updateMode: 'incremental' });
    expect(captured.prompt).toContain('Incremental Update Mode');
  });

  it('produces a different promptHash for incremental vs initial mode', async () => {
    const hashes: string[] = [];
    const callLlm = vi.fn(async (args: { promptHash: string }) => {
      hashes.push(args.promptHash);
      return { points: [] };
    });
    await executeExtractingWith({ callLlm, updateMode: 'initial' });
    await executeExtractingWith({ callLlm, updateMode: 'incremental' });
    expect(hashes[0]).not.toBe(hashes[1]);
  });
});
