export interface EmbeddingProvider {
  embedMany(texts: string[]): Promise<number[][]>;
  embed(text: string): Promise<number[]>;
  readonly dimensions: number;
  readonly modelId: string;
}
