import { vi } from 'vitest';
import type { GoldpanConfig } from '../../../src/config/index.js';
import type { CommitResult, ConfigSnapshot, ConfigStore } from '../../../src/config/store-types.js';
import type {
  Category,
  CategoryRepository,
  Entity,
  EventLogRepository,
  KnowledgePoint,
  KnowledgeRepository,
  PointType,
  ProcessingTask,
  Source,
  SourceRepository,
  TaskRepository,
} from '../../../src/db/repositories/types.js';
import type { IndexedPoint, PipelineContext } from '../../../src/pipeline/types.js';

// ─── Default Config ─────────────────────────────────────────

export function createTestConfig(overrides: Partial<GoldpanConfig> = {}): GoldpanConfig {
  const { llm, db, providerBaseUrls, ...topLevelOverrides } = overrides;
  return {
    llm: {
      classifier: 'openai:gpt-4o-mini',
      extractor: 'anthropic:claude-sonnet-4-20250514',
      matcher: 'anthropic:claude-sonnet-4-20250514',
      comparator: 'anthropic:claude-sonnet-4-20250514',
      verifier: 'openai:gpt-4o-mini',
      verifierEnabled: false,
      intent: 'openai:gpt-4o-mini',
      query: 'anthropic:claude-sonnet-4-20250514',
      digestSummary: 'anthropic:claude-sonnet-4-20250514',
      digestAction: 'openai:gpt-4o-mini',
      ...llm,
    },
    llmProviderOptions: {},
    llmStepTimeouts: {},
    embedding: {
      enabled: false,
      model: 'openai:text-embedding-3-small',
      dimensions: 0,
      batchSize: 100,
    },
    mediaCollectTimeout: 90,
    ytDlpAutoUpdate: false,
    ytDlpVersion: undefined,
    ytDlpBinaryPath: undefined,
    ytDlpDir: undefined,
    ytDlpUpdateCheckIntervalH: 24,
    ytDlpCookiesPath: undefined,
    ollamaEnabled: false,
    timezone: 'UTC',
    ssrfValidationEnabled: true,
    tracking: {
      schedulerEnabled: false,
    },
    digest: {
      enabled: false,
      dailyTime: '06:00',
      maxItemsPerModule: 10,
      linkTtlDays: 14,
    },
    im: {
      conversationWindowSize: 8,
      conversationTtlDays: 30,
      dedupeTtlHours: 72,
      dedupePurgeIntervalMinutes: 60,
    },
    customLlmProviders: [],
    providerModels: {},
    providerEmbeddingModels: {},
    translation: { translatePipelineOutput: false },
    workerInterval: 5,
    collectTimeout: 30,
    browserStrategy: 'auto',
    llmTimeout: 30,
    outputFullThreshold: 2,
    outputIncrementThreshold: 10,
    maxTextInputLength: 20000,
    maxContentLength: 30000,
    minContentLength: 50,
    intentClassificationCharLimit: 0,
    logLevel: 'warn',
    llmLogPayloads: false,
    db: { type: 'sqlite', sqlitePath: ':memory:', ...db },
    providerBaseUrls: {
      deepseek: 'https://api.deepseek.com/v1',
      ollama: 'http://localhost:11434/v1',
      ...providerBaseUrls,
    },
    authPassword: undefined,
    language: 'en',
    serverSocketTimeoutMs: 0,
    trustProxy: false,
    relation: {
      enabled: false,
    },
    nodeEnv: 'test',
    ...topLevelOverrides,
  };
}

// ─── Sample Data Factories ──────────────────────────────────

let sourceIdSeq = 100;
let taskIdSeq = 100;
let entityIdSeq = 100;
let pointIdSeq = 100;
let categoryIdSeq = 100;

export function resetIdSequences(): void {
  sourceIdSeq = 100;
  taskIdSeq = 100;
  entityIdSeq = 100;
  pointIdSeq = 100;
  categoryIdSeq = 100;
}

export function createTestSource(overrides: Partial<Source> = {}): Source {
  const id = sourceIdSeq++;
  return {
    id,
    kind: 'external',
    normalizedUrl: `https://example.com/article-${id}`,
    originalUrl: `https://example.com/article-${id}`,
    title: null,
    rawContent: null,
    metadata: null,
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createTestTask(overrides: Partial<ProcessingTask> = {}): ProcessingTask {
  const id = taskIdSeq++;
  return {
    id,
    sourceId: overrides.sourceId ?? 1,
    type: 'pipeline',
    inputType: 'url',
    status: 'processing',
    pipelineStep: null,
    result: null,
    errorMessage: null,
    errorKind: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createTestEntity(overrides: Partial<Entity> = {}): Entity {
  const id = entityIdSeq++;
  return {
    id,
    name: `Entity ${id}`,
    description: `Description for entity ${id}`,
    aliases: '[]',
    keywords: '["keyword1", "keyword2", "keyword3"]',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createTestPoint(overrides: Partial<KnowledgePoint> = {}): KnowledgePoint {
  const id = pointIdSeq++;
  return {
    id,
    content: `Knowledge point content ${id}`,
    type: 'fact',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createTestCategory(overrides: Partial<Category> = {}): Category {
  const id = categoryIdSeq++;
  return {
    id,
    name: `Category ${id}`,
    path: `/Category ${id}`,
    parentId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Sample Indexed Points ──────────────────────────────────

export function createTestIndexedPoints(count: number = 3): IndexedPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    pointKey: `kp:${i}`,
    content: `Knowledge point ${i}`,
    type: (i % 3 === 2 ? 'opinion' : 'fact') as PointType,
  }));
}

// ─── Pipeline Context Factory ───────────────────────────────

export function createTestContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const source = overrides.source ?? createTestSource();
  const task = overrides.task ?? createTestTask({ sourceId: source.id });
  return {
    task,
    source,
    config: overrides.config ?? createTestConfig(),
    inputType: overrides.inputType ?? 'url',
    content: overrides.content ?? 'This is test content for the pipeline.',
    classification: overrides.classification ?? null,
    points: overrides.points ?? [],
    matchingOutput: overrides.matchingOutput ?? null,
    entityJudgments: overrides.entityJudgments ?? [],
    verifierRejections: overrides.verifierRejections ?? [],
    validationResult: overrides.validationResult ?? null,
    validationWarnings: overrides.validationWarnings ?? [],
    ...overrides,
  };
}

// ─── Mock Repositories ──────────────────────────────────────

export function createMockCategoryRepo(): CategoryRepository {
  return {
    ensureCategoryPath: vi.fn().mockReturnValue(1),
    getAll: vi.fn().mockReturnValue([]),
    getById: vi.fn().mockReturnValue(undefined),
    getByPath: vi.fn().mockReturnValue(undefined),
    getChildren: vi.fn().mockReturnValue([]),
    getSubtree: vi.fn().mockReturnValue([]),
  };
}

export function createMockSourceRepo(): SourceRepository {
  return {
    create: vi.fn(),
    getById: vi.fn().mockReturnValue(undefined),
    getByIds: vi.fn().mockReturnValue([]),
    findActiveByNormalizedUrl: vi.fn().mockReturnValue(undefined),
    updateStatus: vi.fn(),
    emitTerminated: vi.fn(),
    updateAfterCollecting: vi.fn(),
    mergeMetadata: vi.fn(),
    getByStatus: vi.fn().mockReturnValue([]),
    resetFailedSourcesToProcessing: vi.fn().mockReturnValue(0),
  };
}

export function createMockKnowledgeRepo(): KnowledgeRepository {
  // Default: derive batched fact-point fetch from the per-entity mock so tests that
  // only override `getActiveFactPointsForEntity` still produce expected results.
  const repo: KnowledgeRepository = {
    createEntity: vi.fn().mockImplementation((input) => createTestEntity({ name: input.name })),
    getEntityById: vi.fn().mockReturnValue(undefined),
    getEntityRegistry: vi.fn().mockReturnValue([]),
    appendAliases: vi.fn(),
    linkEntityToCategory: vi.fn(),
    createPoint: vi.fn().mockImplementation((content, type) => createTestPoint({ content, type })),
    getPointById: vi.fn().mockReturnValue(undefined),
    getActiveFactPointsForEntity: vi.fn().mockReturnValue([]),
    getActiveFactPointsForEntities: vi.fn().mockImplementation((ids: number[]) => {
      const map = new Map();
      for (const id of ids) {
        const points = repo.getActiveFactPointsForEntity(id);
        if (points && points.length > 0) map.set(id, points);
      }
      return map;
    }),
    getActivePointsForEntity: vi.fn().mockReturnValue([]),
    createSourceEntityPoint: vi.fn(),
    discardPoint: vi.fn(),
    findOrphanPoints: vi.fn().mockReturnValue([]),
    getEntityIdsForSource: vi.fn().mockReturnValue([]),
    entityHasActivePoints: vi.fn().mockReturnValue(false),
    getPointsByIds: vi.fn().mockReturnValue([]),
    deleteSourceEntityPointsBySource: vi.fn(),
    getSourcesForEntity: vi.fn().mockReturnValue([]),
    getCategoryPathsForEntity: vi.fn().mockReturnValue([]),
    getRelationsForEntity: vi.fn().mockReturnValue([]),
    getRelationsBetweenEntities: vi.fn().mockReturnValue([]),
  };
  return repo;
}

export function createMockTaskRepo(): TaskRepository {
  return {
    create: vi.fn(),
    getById: vi.fn().mockReturnValue(undefined),
    hasProcessingTask: vi.fn().mockReturnValue(false),
    claimNextPending: vi.fn().mockReturnValue(undefined),
    updatePipelineStep: vi.fn(),
    updateInputType: vi.fn(),
    markDone: vi.fn(),
    markError: vi.fn(),
    resetForRetry: vi.fn(),
    resetAllProcessing: vi.fn().mockReturnValue(0),
    getRecent: vi.fn().mockReturnValue([]),
  };
}

export function createMockEventLogRepo(): EventLogRepository {
  return {
    create: vi.fn().mockImplementation((input) => ({
      id: 1,
      ...input,
      timestamp: new Date().toISOString(),
      summary: input.summary ?? null,
      entityId: input.entityId ?? null,
      pointId: input.pointId ?? null,
    })),
    getBySourceId: vi.fn().mockReturnValue([]),
    getByAction: vi.fn().mockReturnValue([]),
    getRecent: vi.fn().mockReturnValue([]),
  };
}

// ─── Mock LLM Call Wrapper ──────────────────────────────────

export interface MockCallLlm {
  fn: ReturnType<typeof vi.fn>;
  mockResolvedOutput: (output: unknown) => void;
  mockRejectedError: (error: Error) => void;
}

export function createMockCallLlm(): MockCallLlm {
  const fn = vi.fn();
  return {
    fn,
    mockResolvedOutput: (output: unknown) => {
      // Phase 2 callLlm returns z.infer<T> directly — not wrapped in { output, text, usage }
      fn.mockResolvedValue(output);
    },
    mockRejectedError: (error: Error) => {
      fn.mockRejectedValue(error);
    },
  };
}
/** Mock LlmCallRepository for dependency injection into pipeline steps */
export function createMockLlmCallRepo(): any {
  return {
    create: vi.fn().mockReturnValue({ id: 1 }),
    getBySourceId: vi.fn().mockReturnValue([]),
  };
}

// ─── Stub ConfigStore ───────────────────────────────────────
//
// Pipeline tests historically passed `config` directly to `createPipeline`,
// but the new `PipelineDepsInput` shape takes a `ConfigStore` instead so the
// orchestrator can pull a fresh snapshot per task. For tests that don't care
// about runtime config commits, this stub returns the same (mutable) config
// every time — `setConfig(next)` lets a test rewrite the underlying snapshot
// to simulate a mid-test commit when needed (used by the per-task invariant
// test). `commit / onChange / refresh` are intentionally inert: they aren't
// part of the orchestrator's contract, and exercising them belongs in the
// real `createConfigStore` tests under `tests/config/`.
export interface StubConfigStore extends ConfigStore {
  setConfig(next: GoldpanConfig): void;
}

export function createStubConfigStore(initial: GoldpanConfig): StubConfigStore {
  let current: GoldpanConfig = initial;
  const snapshot = (): ConfigSnapshot => ({
    config: current,
    origins: new Map(),
    generation: 0,
  });
  return {
    getSnapshot: snapshot,
    commit: async (): Promise<CommitResult> => ({ kind: 'ok', snapshot: snapshot() }),
    onChange: () => () => {},
    refresh: async () => snapshot(),
    setPluginEnvKeys: () => {
      // Stub: orchestrator tests don't exercise plugin-key whitelisting.
    },
    setConfig(next) {
      current = next;
    },
  };
}
