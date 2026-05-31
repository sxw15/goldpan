export interface TaskSummary {
  id: number;
  sourceId: number;
  status: 'pending' | 'processing' | 'done' | 'error';
  createdAt: number;
  pipelineStep: string | null;
  inputType: string | null;
  result: Record<string, unknown> | null;
  errorKind: string | null;
  durationS: number | null;
  llmCount: number;
  retryCount: number;
  source: {
    originalUrl: string | null;
    normalizedUrl: string | null;
    title?: string | null;
    rawContentPreview?: string | null;
    status: string;
    kind: 'external' | 'user';
    origin: string;
  } | null;
}
