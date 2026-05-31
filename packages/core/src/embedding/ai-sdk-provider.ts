import { embed as aiEmbed, embedMany as aiEmbedMany, type EmbeddingModel } from 'ai';
import type { LlmRegistry } from '../llm/registry';
import type { EmbeddingProvider } from './types';

export class AiSdkEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  private readonly model: EmbeddingModel;

  constructor(registry: LlmRegistry, modelId: string, dimensions: number) {
    this.modelId = modelId;
    this.model = registry.embeddingModel(modelId as `${string}:${string}`);
    this.dimensions = dimensions;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const { embeddings } = await aiEmbedMany({ model: this.model, values: texts });
    return embeddings;
  }

  async embed(text: string): Promise<number[]> {
    const { embedding } = await aiEmbed({ model: this.model, value: text });
    return embedding;
  }
}
