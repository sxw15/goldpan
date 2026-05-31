import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineError } from '../../../src/pipeline/types.js';
import {
  createMockSourceRepo,
  createTestConfig,
  createTestContext,
  createTestSource,
} from '../fixtures/index.js';

// Mock PluginRegistry — Phase 3 dependency
const mockCollect = vi.fn();
const mockPluginRegistry = {
  getCollector: vi.fn().mockResolvedValue({ collect: mockCollect }),
};

describe('collecting step', () => {
  let sourceRepo: ReturnType<typeof createMockSourceRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    sourceRepo = createMockSourceRepo();
  });

  it('skips collecting for non-URL input', async () => {
    const { executeCollecting } = await import('../../../src/pipeline/steps/collecting.js');
    const textContent =
      'User text input with enough length to pass the minimum content validation check.';
    const ctx = createTestContext({
      inputType: 'text',
      source: createTestSource({
        kind: 'user',
        rawContent: textContent,
        normalizedUrl: null,
        originalUrl: null,
      }),
    });

    const result = await executeCollecting(ctx, {
      sourceRepo,
      pluginRegistry: mockPluginRegistry as any,
    });
    expect(result.content).toBe(textContent);
    expect(mockCollect).not.toHaveBeenCalled();
  });

  it('throws PipelineError when non-URL rawContent is too short (< 50 chars)', async () => {
    const { executeCollecting } = await import('../../../src/pipeline/steps/collecting.js');
    const ctx = createTestContext({
      inputType: 'text',
      source: createTestSource({
        kind: 'user',
        rawContent: 'Short text',
        normalizedUrl: null,
        originalUrl: null,
      }),
    });

    await expect(
      executeCollecting(ctx, { sourceRepo, pluginRegistry: mockPluginRegistry as any }),
    ).rejects.toThrow(PipelineError);
    await expect(
      executeCollecting(ctx, { sourceRepo, pluginRegistry: mockPluginRegistry as any }),
    ).rejects.toThrow(/too short/);
    // Length failures must be `content_length`, NOT `content_policy` (which is
    // reserved for genuine LLM moderation) — otherwise a short note is shown to
    // the user as a "content policy violation".
    await expect(
      executeCollecting(ctx, { sourceRepo, pluginRegistry: mockPluginRegistry as any }),
    ).rejects.toMatchObject({ kind: 'content_length' });
  });

  it('collects content for URL input and updates source', async () => {
    const { executeCollecting } = await import('../../../src/pipeline/steps/collecting.js');
    mockCollect.mockResolvedValue({
      content:
        '# Article Title\n\nThis is the article body with enough content to pass validation checks.',
      title: 'Article Title',
      metadata: { collector_author: 'Author Name' },
    });

    const source = createTestSource({
      kind: 'external',
      normalizedUrl: 'https://example.com/article',
      originalUrl: 'https://example.com/article',
      rawContent: null,
      metadata: JSON.stringify({ userAnnotation: 'interesting' }),
    });
    const ctx = createTestContext({ inputType: 'url', source });

    const result = await executeCollecting(ctx, {
      sourceRepo,
      pluginRegistry: mockPluginRegistry as any,
    });

    expect(result.content).toBe(
      '# Article Title\n\nThis is the article body with enough content to pass validation checks.',
    );
    expect(sourceRepo.updateAfterCollecting).toHaveBeenCalledWith(
      source.id,
      expect.objectContaining({
        title: 'Article Title',
        rawContent:
          '# Article Title\n\nThis is the article body with enough content to pass validation checks.',
      }),
    );
  });

  it('throws PipelineError if collected content is too short (< 50 chars)', async () => {
    const { executeCollecting } = await import('../../../src/pipeline/steps/collecting.js');
    mockCollect.mockResolvedValue({
      content: 'Short',
      title: 'T',
      metadata: {},
    });

    const source = createTestSource();
    const ctx = createTestContext({ inputType: 'url', source });

    await expect(
      executeCollecting(ctx, { sourceRepo, pluginRegistry: mockPluginRegistry as any }),
    ).rejects.toThrow(PipelineError);
    await expect(
      executeCollecting(ctx, { sourceRepo, pluginRegistry: mockPluginRegistry as any }),
    ).rejects.toThrow(/too short/);
    await expect(
      executeCollecting(ctx, { sourceRepo, pluginRegistry: mockPluginRegistry as any }),
    ).rejects.toMatchObject({ kind: 'content_length' });
  });

  it('throws PipelineError if collected content exceeds max length', async () => {
    const { executeCollecting } = await import('../../../src/pipeline/steps/collecting.js');
    const longContent = 'x'.repeat(30001);
    mockCollect.mockResolvedValue({
      content: longContent,
      title: 'Long Article',
      metadata: {},
    });

    const source = createTestSource();
    const config = createTestConfig({ maxContentLength: 30000 });
    const ctx = createTestContext({ inputType: 'url', source, config });

    await expect(
      executeCollecting(ctx, { sourceRepo, pluginRegistry: mockPluginRegistry as any }),
    ).rejects.toThrow(PipelineError);
    await expect(
      executeCollecting(ctx, { sourceRepo, pluginRegistry: mockPluginRegistry as any }),
    ).rejects.toThrow(/too long/);
    await expect(
      executeCollecting(ctx, { sourceRepo, pluginRegistry: mockPluginRegistry as any }),
    ).rejects.toMatchObject({ kind: 'content_length' });
  });

  it('throws PipelineError on collector failure', async () => {
    const { executeCollecting } = await import('../../../src/pipeline/steps/collecting.js');
    mockCollect.mockRejectedValue(new Error('Network timeout'));

    const source = createTestSource();
    const ctx = createTestContext({ inputType: 'url', source });

    await expect(
      executeCollecting(ctx, { sourceRepo, pluginRegistry: mockPluginRegistry as any }),
    ).rejects.toThrow(PipelineError);
  });

  it('attaches collectingDiagnostics when a collector emits diagnostics during collect', async () => {
    const { executeCollecting } = await import('../../../src/pipeline/steps/collecting.js');
    const { emitCollectDiagnostic } = await import('../../../src/plugins/collect-diagnostics.js');
    mockCollect.mockImplementation(async () => {
      emitCollectDiagnostic(
        'collector-browser：本机 Google Chrome 无法启动（x），已回退到 Playwright 自带的 Chromium。',
      );
      return {
        content:
          '# Title\n\nEnough body text here to satisfy the minimum content length requirement easily.',
        title: 'Title',
        metadata: { collectorPlugin: 'collector-browser' },
      };
    });

    const source = createTestSource({
      kind: 'external',
      normalizedUrl: 'https://example.com/a',
      originalUrl: 'https://example.com/a',
      rawContent: null,
    });
    const ctx = createTestContext({ inputType: 'url', source });

    const result = await executeCollecting(ctx, {
      sourceRepo,
      pluginRegistry: mockPluginRegistry as any,
    });

    expect(result.collectingDiagnostics).toEqual([
      'collector-browser：本机 Google Chrome 无法启动（x），已回退到 Playwright 自带的 Chromium。',
    ]);
  });

  it('merges collector metadata with existing source metadata', async () => {
    const { executeCollecting } = await import('../../../src/pipeline/steps/collecting.js');
    mockCollect.mockResolvedValue({
      content: 'Enough content to pass the minimum length validation check for the pipeline.',
      title: 'Title',
      metadata: { collector_author: 'Author' },
    });

    const source = createTestSource({
      metadata: JSON.stringify({ userAnnotation: 'my note' }),
    });
    const ctx = createTestContext({ inputType: 'url', source });

    await executeCollecting(ctx, { sourceRepo, pluginRegistry: mockPluginRegistry as any });

    const updateCall = (sourceRepo.updateAfterCollecting as any).mock.calls[0];
    const collectorMetadata = updateCall[1].collectorMetadata;
    expect(collectorMetadata).toEqual({ collector_author: 'Author' });
  });

  it('throws PipelineError when non-URL rawContent exceeds maxTextInputLength', async () => {
    const { executeCollecting } = await import('../../../src/pipeline/steps/collecting.js');
    const longContent = 'a'.repeat(25000);
    const source = createTestSource({
      kind: 'user',
      rawContent: longContent,
    });
    const ctx = createTestContext({
      inputType: 'text',
      source,
      config: createTestConfig({ maxTextInputLength: 20000 }),
    });

    await expect(
      executeCollecting(ctx, { sourceRepo, pluginRegistry: mockPluginRegistry as any }),
    ).rejects.toThrow(PipelineError);
  });

  it('throws PipelineError when no collector is available for URL', async () => {
    const { executeCollecting } = await import('../../../src/pipeline/steps/collecting.js');
    const source = createTestSource({
      kind: 'external',
      originalUrl: 'https://example.com',
      normalizedUrl: 'https://example.com',
    });
    const ctx = createTestContext({ inputType: 'url', source });
    const noCollectorRegistry = {
      getCollector: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      executeCollecting(ctx, { sourceRepo, pluginRegistry: noCollectorRegistry as any }),
    ).rejects.toThrow(PipelineError);
  });
});

describe('collecting.ts — updateMode boundary translation', () => {
  let sourceRepo: ReturnType<typeof createMockSourceRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    sourceRepo = createMockSourceRepo();
  });

  async function runCollectingWith({
    collectorMetadata,
  }: {
    collectorMetadata: Record<string, unknown>;
  }) {
    const { executeCollecting } = await import('../../../src/pipeline/steps/collecting.js');
    mockCollect.mockResolvedValue({
      // ≥50 chars so the content length validation passes
      content:
        '# Title\n\nEnough body text here to satisfy the minimum content length requirement.',
      title: 'Title',
      metadata: collectorMetadata,
    });
    const source = createTestSource({
      kind: 'external',
      normalizedUrl: 'https://example.com/update-mode',
      originalUrl: 'https://example.com/update-mode',
      rawContent: null,
    });
    const ctx = createTestContext({ inputType: 'url', source });
    return executeCollecting(ctx, {
      sourceRepo,
      pluginRegistry: mockPluginRegistry as any,
    });
  }

  it("sets ctx.updateMode='incremental' when metadata says so", async () => {
    const ctx = await runCollectingWith({
      collectorMetadata: { collector_update_mode: 'incremental' },
    });
    expect(ctx.updateMode).toBe('incremental');
    expect(ctx.collectorMetadata?.collector_update_mode).toBe('incremental');
  });

  it("sets ctx.updateMode='initial' when metadata says so", async () => {
    const ctx = await runCollectingWith({
      collectorMetadata: { collector_update_mode: 'initial' },
    });
    expect(ctx.updateMode).toBe('initial');
  });

  it('sets ctx.updateMode=null when metadata absent', async () => {
    const ctx = await runCollectingWith({ collectorMetadata: {} });
    expect(ctx.updateMode).toBeNull();
  });

  it('sets ctx.updateMode=null when metadata value is invalid', async () => {
    const ctx = await runCollectingWith({
      collectorMetadata: { collector_update_mode: 'weird' },
    });
    expect(ctx.updateMode).toBeNull();
  });
});
