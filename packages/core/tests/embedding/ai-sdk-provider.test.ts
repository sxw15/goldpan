import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({
  embed: vi.fn(),
  embedMany: vi.fn(),
}));

import { embed as aiEmbed, embedMany as aiEmbedMany } from 'ai';
import { AiSdkEmbeddingProvider } from '../../src/embedding/ai-sdk-provider';

const mockRegistry = {
  embeddingModel: vi.fn().mockReturnValue('mock-model'),
} as any;

describe('AiSdkEmbeddingProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('embeds single text', async () => {
    vi.mocked(aiEmbed).mockResolvedValueOnce({
      embedding: [0.1, 0.2, 0.3],
      usage: { tokens: 5 },
    } as any);
    const provider = new AiSdkEmbeddingProvider(mockRegistry, 'openai:text-embedding-3-small', 3);
    const result = await provider.embed('hello');
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(provider.dimensions).toBe(3);
    expect(provider.modelId).toBe('openai:text-embedding-3-small');
  });

  it('embeds multiple texts', async () => {
    vi.mocked(aiEmbedMany).mockResolvedValueOnce({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      usage: { tokens: 10 },
    } as any);
    const provider = new AiSdkEmbeddingProvider(mockRegistry, 'openai:text-embedding-3-small', 2);
    const result = await provider.embedMany(['hello', 'world']);
    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it('returns empty array for empty input', async () => {
    const provider = new AiSdkEmbeddingProvider(mockRegistry, 'openai:text-embedding-3-small', 2);
    const result = await provider.embedMany([]);
    expect(result).toEqual([]);
    expect(aiEmbedMany).not.toHaveBeenCalled();
  });
});
