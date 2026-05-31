import { SqliteKnowledgeRepository, SqliteSourceRepository } from '@goldpan/core/db/repositories';
import { initI18n, resetI18n } from '@goldpan/core/i18n';
import type {
  IntentExecutionContext,
  IntentPluginResult,
  ServiceCallLlmFn,
} from '@goldpan/core/plugins';
import type { ILogObj, Logger } from 'tslog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDB, type TestDB } from '../../../packages/core/tests/helpers/test-db';
import { handleCreateTracking } from '../src/create-tracking-handler';
import { ensureTrackingTables } from '../src/db';
import { TrackingCrudService } from '../src/service';
import type { TrackingService } from '../src/types';

// i18n needs to be initialized once for the whole file because
// `handleManageTracking` (path B) loads localized prompt templates.
beforeEach(() => {
  resetI18n();
  initI18n('en');
});

// ─── Test fixtures ───────────────────────────────────────────

function silentLogger(): Logger<ILogObj> {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    silly: () => undefined,
    getSubLogger: () => silentLogger(),
  } as unknown as Logger<ILogObj>;
}

/**
 * Insert a source row with the given status using raw SQL — the SourceRepository
 * doesn't expose a `create-with-status` shortcut (status is driven by pipeline
 * steps in production), but the create_tracking handler only reads `status`,
 * so a direct INSERT suffices for the test.
 */
function seedSource(tdb: TestDB, status: string, opts: { title?: string } = {}): number {
  const raw = (tdb.db as unknown as { $client: import('better-sqlite3').Database }).$client;
  const result = raw
    .prepare(
      `INSERT INTO sources (kind, raw_content, title, status, created_at, updated_at)
       VALUES ('user', 'seed', ?, ?, strftime('%s','now')*1000, strftime('%s','now')*1000)`,
    )
    .run(opts.title ?? null, status);
  return Number(result.lastInsertRowid);
}

/**
 * Seed an entity + knowledge_point + source_entity_points so the source has
 * an associated entity discoverable via KnowledgeRepository.getEntityIdsForSource.
 */
function seedEntityLinkedToSource(tdb: TestDB, sourceId: number, name: string): number {
  const raw = (tdb.db as unknown as { $client: import('better-sqlite3').Database }).$client;
  const entRow = raw
    .prepare(
      `INSERT INTO entities (name, created_at, updated_at)
       VALUES (?, strftime('%s','now')*1000, strftime('%s','now')*1000)
       RETURNING id`,
    )
    .get(name) as { id: number };
  const pointRow = raw
    .prepare(
      `INSERT INTO knowledge_points (content, type, created_at, updated_at)
       VALUES ('kp', 'fact', strftime('%s','now')*1000, strftime('%s','now')*1000)
       RETURNING id`,
    )
    .get() as { id: number };
  raw
    .prepare(
      `INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment, created_at)
       VALUES (?, ?, ?, 'new', strftime('%s','now')*1000)`,
    )
    .run(sourceId, entRow.id, pointRow.id);
  return entRow.id;
}

/**
 * Fake TrackingService that captures createInterestWithResolution calls for
 * assertion. createInterest goes through a separate path (path B's
 * handleManageTracking calls service.createInterest); also captured.
 */
interface FakeTrackingService extends TrackingService {
  created: Array<{
    name: string;
    searchQueries: string[];
    linkedEntityIds?: number[];
    enabled: boolean;
    resolutionStatus: string;
  }>;
  managedCreated: Array<{ name: string; searchQueries: string[] }>;
}

function makeFakeTrackingService(): FakeTrackingService {
  const created: FakeTrackingService['created'] = [];
  const managedCreated: FakeTrackingService['managedCreated'] = [];
  let nextId = 100;
  return {
    created,
    managedCreated,
    getInterests: vi.fn(() => []),
    getInterestListStats: vi.fn(() => new Map()),
    getInterest: vi.fn(),
    createInterest: vi.fn((data) => {
      managedCreated.push({ name: data.name, searchQueries: data.searchQueries });
      return {
        id: nextId++,
        name: data.name,
        description: null,
        searchQueries: data.searchQueries,
        toolProvider: null,
        intervalMinutes: data.intervalMinutes ?? 60,
        enabled: data.enabled ?? true,
        status: 'idle',
        lastRunAt: null,
        nextRunAt: null,
        linkedEntityIds: data.linkedEntityIds ?? [],
        createdAt: 0,
        updatedAt: 0,
      };
    }),
    createInterestWithResolution: vi.fn((data) => {
      created.push({
        name: data.name,
        searchQueries: data.searchQueries,
        linkedEntityIds: data.linkedEntityIds,
        enabled: data.enabled,
        resolutionStatus: data.resolutionStatus,
      });
      const id = nextId++;
      return { id, name: data.name };
    }),
    updateInterest: vi.fn(),
    deleteInterest: vi.fn(),
    enableInterest: vi.fn(),
    disableInterest: vi.fn(),
    triggerExecution: vi.fn(),
    getExecution: vi.fn(),
    getInterestExecutions: vi.fn(() => ({ executions: [], total: 0 })),
    startScheduler: vi.fn(),
    drainScheduler: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCtx(
  tdb: TestDB,
  overrides: Partial<IntentExecutionContext> = {},
): IntentExecutionContext {
  const sourceRepo = new SqliteSourceRepository(tdb.db);
  const knowledgeRepo = new SqliteKnowledgeRepository(tdb.db);
  return {
    logger: silentLogger(),
    config: {} as never,
    language: 'zh',
    db: tdb.db,
    repos: {
      llmCall: { record: vi.fn() } as never,
      submissionLog: {} as never,
      knowledge: knowledgeRepo,
      category: {} as never,
      notes: {} as never,
      source: sourceRepo,
      conversation: {} as never,
    },
    callLlm: vi.fn() as never,
    llmCallRepo: { record: vi.fn() } as never,
    logPayloads: false,
    llmTimeout: 10000,
    conversation: {
      sessionKey: 't',
      conversationId: 1,
      channelId: 'web',
      // 默认 recentMessages 含一条 assistant turn 引用 sourceId — 让
      // collectMentionedSourceIds 命中。具体测试用 overrides 改写。
      recentMessages: [],
      messageWindowSize: 6,
      startedAt: new Date(),
    },
    ...overrides,
  };
}

/** Helper — build a recentMessages list that mentions all given sourceIds. */
function withMentionedSources(sourceIds: number[]) {
  return sourceIds.map((sourceId, i) => ({
    id: i + 1,
    role: 'assistant' as const,
    content: `submitted ${sourceId}`,
    createdAt: new Date(),
    metadata: { sourceId },
  }));
}

// ─── Tests ───────────────────────────────────────────────────

describe('handleCreateTracking — path A confirmed source', () => {
  let tdb: TestDB;
  beforeEach(() => {
    tdb = createTestDB();
    ensureTrackingTables(tdb.db);
  });
  afterEach(() => {
    tdb.cleanup();
  });

  it('confirmed + 1 entity → resolved row + action message containing entity name', async () => {
    const sourceId = seedSource(tdb, 'confirmed', { title: 'Anthropic blog' });
    const entityId = seedEntityLinkedToSource(tdb, sourceId, 'Anthropic');

    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        recentMessages: withMentionedSources([sourceId]),
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });
    const service = makeFakeTrackingService();
    const result = await handleCreateTracking(
      '追踪这家公司',
      service,
      ctx,
      vi.fn() as unknown as ServiceCallLlmFn,
    );

    expect(result.type).toBe('action');
    if (result.type === 'action') {
      expect(result.message).toMatch(/Anthropic/);
    }
    expect(service.createInterest).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Anthropic',
        searchQueries: ['Anthropic'],
        linkedEntityIds: [entityId],
        enabled: true,
      }),
    );
    expect(service.created).toHaveLength(0);
  });

  it('confirmed + N entities → clarify chips, rule awaiting_clarify enabled=false', async () => {
    const sourceId = seedSource(tdb, 'confirmed', { title: 'multi' });
    const a = seedEntityLinkedToSource(tdb, sourceId, 'A');
    const b = seedEntityLinkedToSource(tdb, sourceId, 'B');

    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        recentMessages: withMentionedSources([sourceId]),
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });
    const service = makeFakeTrackingService();
    const result = await handleCreateTracking(
      '追踪',
      service,
      ctx,
      vi.fn() as unknown as ServiceCallLlmFn,
    );

    expect(result.type).toBe('clarify');
    if (result.type === 'clarify') {
      expect(result.questionKey).toBe('tracking_resolve_entity');
      expect(result.structuredOptions).toHaveLength(2);
      expect(result.structuredOptions?.map((opt) => opt.intentKey)).toEqual([
        'resolve_tracking_entity',
        'resolve_tracking_entity',
      ]);
      const payloads =
        result.structuredOptions?.map((opt) => JSON.parse(opt.payload ?? '{}')) ?? [];
      expect(payloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ entityId: a, entityName: 'A', trackingRuleId: 100 }),
          expect.objectContaining({ entityId: b, entityName: 'B', trackingRuleId: 100 }),
        ]),
      );
    }
    expect(service.created).toContainEqual(
      expect.objectContaining({
        enabled: false,
        resolutionStatus: 'awaiting_clarify',
      }),
    );
    // sanity: both candidate ids made it into the captured row
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });

  it('confirmed + 0 entities → action prompting user, no row written', async () => {
    const sourceId = seedSource(tdb, 'confirmed', { title: 'no entity' });
    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        recentMessages: withMentionedSources([sourceId]),
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });
    const service = makeFakeTrackingService();
    const result = await handleCreateTracking(
      '追踪',
      service,
      ctx,
      vi.fn() as unknown as ServiceCallLlmFn,
    );

    expect(result.type).toBe('action');
    if (result.type === 'action') {
      expect(result.message).toMatch(/未抽出实体|no entities/i);
    }
    expect(service.created).toHaveLength(0);
  });

  it('confirmed_empty status also enters the entity branch (status alias for confirmed)', async () => {
    const sourceId = seedSource(tdb, 'confirmed_empty', { title: 'empty' });
    seedEntityLinkedToSource(tdb, sourceId, 'X');
    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        recentMessages: withMentionedSources([sourceId]),
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });
    const result = await handleCreateTracking(
      '追踪',
      makeFakeTrackingService(),
      ctx,
      vi.fn() as unknown as ServiceCallLlmFn,
    );
    // 1 entity → resolved action
    expect(result.type).toBe('action');
  });
});

describe('handleCreateTracking — path A pipeline status branches', () => {
  let tdb: TestDB;
  beforeEach(() => {
    tdb = createTestDB();
    ensureTrackingTables(tdb.db);
  });
  afterEach(() => {
    tdb.cleanup();
  });

  it('processing → tracking_pending waiting_pipeline, enabled=false', async () => {
    const sourceId = seedSource(tdb, 'processing', { title: 't' });
    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        recentMessages: withMentionedSources([sourceId]),
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });
    const service = makeFakeTrackingService();
    const result = await handleCreateTracking(
      '追踪',
      service,
      ctx,
      vi.fn() as unknown as ServiceCallLlmFn,
    );

    expect(result.type).toBe('tracking_pending');
    if (result.type === 'tracking_pending') {
      expect(result.reasonKey).toBe('waiting_pipeline');
    }
    expect(service.created).toContainEqual(
      expect.objectContaining({
        enabled: false,
        resolutionStatus: 'pending_pipeline',
      }),
    );
  });

  it('failed → action with friendly message + failed_source_pipeline audit row, NO pending', async () => {
    const sourceId = seedSource(tdb, 'failed', { title: 'f' });
    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        recentMessages: withMentionedSources([sourceId]),
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });
    const service = makeFakeTrackingService();
    const result = await handleCreateTracking(
      '追踪',
      service,
      ctx,
      vi.fn() as unknown as ServiceCallLlmFn,
    );

    expect(result.type).toBe('action');
    if (result.type === 'action') {
      // 中文消息提到「失败」（status label is the friendly word, not the raw status)
      expect(result.message).toMatch(/失败|failed/i);
    }
    expect(service.created).toContainEqual(
      expect.objectContaining({
        enabled: false,
        resolutionStatus: 'failed_source_pipeline',
      }),
    );
  });

  it('discarded → action mentioning 丢弃, audit row with failed_source_pipeline', async () => {
    const sourceId = seedSource(tdb, 'discarded', { title: 'd' });
    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        recentMessages: withMentionedSources([sourceId]),
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });
    const service = makeFakeTrackingService();
    const result = await handleCreateTracking(
      '追踪',
      service,
      ctx,
      vi.fn() as unknown as ServiceCallLlmFn,
    );
    expect(result.type).toBe('action');
    if (result.type === 'action') {
      expect(result.message).toMatch(/丢弃|discarded/i);
    }
    expect(service.created).toContainEqual(
      expect.objectContaining({
        enabled: false,
        resolutionStatus: 'failed_source_pipeline',
      }),
    );
  });
});

describe('handleCreateTracking — path B (no linkedSourceId)', () => {
  let tdb: TestDB;
  beforeEach(() => {
    tdb = createTestDB();
    ensureTrackingTables(tdb.db);
  });
  afterEach(() => {
    tdb.cleanup();
  });

  it('no linkedSourceId → delegates to handleManageTracking, calls LLM, uses createInterest', async () => {
    const ctx = makeCtx(tdb); // no linkedSourceId
    const fakeCallLlm = vi.fn().mockResolvedValue({
      action: 'create',
      name: 'Claude news',
      searchQueries: ['Claude 4.7 release'],
      intervalMinutes: 60,
    }) as unknown as ServiceCallLlmFn;
    const service = makeFakeTrackingService();
    const result = await handleCreateTracking('追踪 Claude 的新闻', service, ctx, fakeCallLlm);

    expect(result.type).toBe('action');
    expect(service.managedCreated).toContainEqual(expect.objectContaining({ name: 'Claude news' }));
    // path B doesn't touch the pending-row code path
    expect(service.created).toHaveLength(0);
  });

  it('forces action=create even when LLM returns a different action (defense against destructive misclassification)', async () => {
    const ctx = makeCtx(tdb);
    // LLM "tries" to delete — handler should ignore and still create
    const fakeCallLlm = vi.fn().mockResolvedValue({
      action: 'delete',
      interestId: 99,
      name: 'Claude news',
      searchQueries: ['Claude 4.7'],
    }) as unknown as ServiceCallLlmFn;
    const service = makeFakeTrackingService();
    const result = await handleCreateTracking('追踪 Claude', service, ctx, fakeCallLlm);

    expect(result.type).toBe('action');
    expect(service.managedCreated).toContainEqual(expect.objectContaining({ name: 'Claude news' }));
    expect(service.deleteInterest).not.toHaveBeenCalled();
  });
});

describe('handleCreateTracking — safety / fallback', () => {
  let tdb: TestDB;
  beforeEach(() => {
    tdb = createTestDB();
    ensureTrackingTables(tdb.db);
  });
  afterEach(() => {
    tdb.cleanup();
  });

  // B2 修复后此测试不再适用：mention 校验已上浮到 handleInput 中央化（见
  // packages/core/tests/input.test.ts）。plugin 直接信任 ctx.linkedSourceId，
  // 跨 conversation hallucination 的 sourceId 会在 handleInput 构建
  // IntentExecutionContext 时被清成 undefined → 自动走 path B。
  // 留下契约 sanity check：ctx 已是 trusted 时，plugin 不再 drop。
  it('B2: 信任 ctx.linkedSourceId（mention 校验已在 handleInput 中央化）', async () => {
    const sourceId = seedSource(tdb, 'confirmed', { title: 'trusted' });
    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        recentMessages: [], // 即使 recentMessages 空 plugin 也信任 ctx
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });
    const fakeCallLlm = vi.fn() as unknown as ServiceCallLlmFn;
    const service = makeFakeTrackingService();
    const result: IntentPluginResult = await handleCreateTracking(
      'track',
      service,
      ctx,
      fakeCallLlm,
    );

    // 走 path A —— sourceId trusted，不再 fall through 到 LLM
    expect(fakeCallLlm).not.toHaveBeenCalled();
    expect(result.type).toBe('action');
  });

  it('linkedSourceId points to a missing source row → falls back to path B', async () => {
    const ctx = makeCtx(tdb, {
      // 99999 doesn't exist in `sources`
      linkedSourceId: 99999,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        // 通过 mentioned 校验，但 getById 返回 undefined
        recentMessages: withMentionedSources([99999]),
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });
    const fakeCallLlm = vi.fn().mockResolvedValue({
      action: 'create',
      name: 'recovered',
      searchQueries: ['x'],
    }) as unknown as ServiceCallLlmFn;
    const service = makeFakeTrackingService();
    const result = await handleCreateTracking('track', service, ctx, fakeCallLlm);

    expect(result.type).toBe('action');
    expect(fakeCallLlm).toHaveBeenCalled();
    expect(service.managedCreated).toContainEqual(expect.objectContaining({ name: 'recovered' }));
  });
});

describe('handleCreateTracking — integration with real TrackingCrudService', () => {
  let tdb: TestDB;
  beforeEach(() => {
    tdb = createTestDB();
    ensureTrackingTables(tdb.db);
  });
  afterEach(() => {
    tdb.cleanup();
  });

  it('end-to-end: confirmed + 1 entity branch writes via normal createInterest validation path', async () => {
    const sourceId = seedSource(tdb, 'confirmed', { title: 'Anthropic' });
    const entityId = seedEntityLinkedToSource(tdb, sourceId, 'Anthropic');

    const realService = new TrackingCrudService({
      db: tdb.db,
      pluginRegistry: {
        resolveToolProvider: () => undefined,
      } as never,
      scheduler: {
        startScheduler: () => undefined,
        drainScheduler: async () => undefined,
      },
      getMinRuleIntervalMinutes: () => 60,
    });

    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        recentMessages: withMentionedSources([sourceId]),
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });

    const result = await handleCreateTracking(
      '追踪',
      realService,
      ctx,
      vi.fn() as unknown as ServiceCallLlmFn,
    );

    expect(result.type).toBe('action');
    // Verify the row landed with the expected shape
    const raw = (tdb.db as unknown as { $client: import('better-sqlite3').Database }).$client;
    const row = raw.prepare('SELECT * FROM tracking_rules ORDER BY id DESC LIMIT 1').get() as {
      id: number;
      name: string;
      resolution_status: string;
      interval_minutes: number;
      enabled: number;
    };
    expect(row.resolution_status).toBe('resolved');
    expect(row.interval_minutes).toBe(60);
    expect(row.enabled).toBe(1);
    expect(row.name).toBe('Anthropic');
    const link = raw
      .prepare('SELECT * FROM interest_entity_links WHERE interest_id = ?')
      .get(row.id) as { entity_id: number };
    expect(link.entity_id).toBe(entityId);
  });

  it('end-to-end: processing branch writes pending row with pending_resolution JSON keyed on sourceId', async () => {
    const sourceId = seedSource(tdb, 'processing', { title: 't' });
    const realService = new TrackingCrudService({
      db: tdb.db,
      pluginRegistry: { resolveToolProvider: () => undefined } as never,
      scheduler: {
        startScheduler: () => undefined,
        drainScheduler: async () => undefined,
      },
      getMinRuleIntervalMinutes: () => 60,
    });
    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        recentMessages: withMentionedSources([sourceId]),
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });
    const result = await handleCreateTracking(
      '追踪',
      realService,
      ctx,
      vi.fn() as unknown as ServiceCallLlmFn,
    );

    expect(result.type).toBe('tracking_pending');

    const raw = (tdb.db as unknown as { $client: import('better-sqlite3').Database }).$client;
    const row = raw
      .prepare(
        `SELECT id, enabled, resolution_status, pending_resolution
         FROM tracking_rules ORDER BY id DESC LIMIT 1`,
      )
      .get() as {
      id: number;
      enabled: number;
      resolution_status: string;
      pending_resolution: string | null;
    };
    expect(row.enabled).toBe(0);
    expect(row.resolution_status).toBe('pending_pipeline');
    expect(row.pending_resolution).not.toBeNull();
    const parsed = JSON.parse(row.pending_resolution ?? '{}');
    expect(parsed.sourceId).toBe(sourceId);
    // P4: 落 conversationId 让 deferredResolver 反查 push 目标；web ctx 没有
    // sessionRef，仅 IM 路径才会带。
    expect(parsed.conversationId).toBe(1);
    expect(parsed.sessionRef).toBeUndefined();
  });

  it('end-to-end: processing branch with IM sessionRef snapshots conversationId + sessionRef', async () => {
    const sourceId = seedSource(tdb, 'processing', { title: 't-im' });
    const realService = new TrackingCrudService({
      db: tdb.db,
      pluginRegistry: { resolveToolProvider: () => undefined } as never,
      scheduler: {
        startScheduler: () => undefined,
        drainScheduler: async () => undefined,
      },
      getMinRuleIntervalMinutes: () => 60,
    });
    const ctxSessionRef = {
      channelId: 'telegram',
      accountId: 'acct-1',
      chatId: 'chat-42',
      userId: 'user-7',
    };
    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 'telegram:acct-1:chat-42',
        conversationId: 777,
        channelId: 'telegram',
        recentMessages: withMentionedSources([sourceId]),
        messageWindowSize: 6,
        startedAt: new Date(),
      },
      sessionRef: ctxSessionRef,
    });
    const result = await handleCreateTracking(
      '追踪',
      realService,
      ctx,
      vi.fn() as unknown as ServiceCallLlmFn,
    );

    expect(result.type).toBe('tracking_pending');
    const raw = (tdb.db as unknown as { $client: import('better-sqlite3').Database }).$client;
    const row = raw
      .prepare('SELECT pending_resolution FROM tracking_rules ORDER BY id DESC LIMIT 1')
      .get() as { pending_resolution: string };
    const parsed = JSON.parse(row.pending_resolution);
    expect(parsed.conversationId).toBe(777);
    expect(parsed.sessionRef).toEqual(ctxSessionRef);
  });

  it('end-to-end: awaiting_clarify branch snapshots conversationId + sessionRef', async () => {
    const sourceId = seedSource(tdb, 'confirmed', { title: 'multi-im' });
    seedEntityLinkedToSource(tdb, sourceId, 'EntA');
    seedEntityLinkedToSource(tdb, sourceId, 'EntB');
    const realService = new TrackingCrudService({
      db: tdb.db,
      pluginRegistry: { resolveToolProvider: () => undefined } as never,
      scheduler: {
        startScheduler: () => undefined,
        drainScheduler: async () => undefined,
      },
      getMinRuleIntervalMinutes: () => 60,
    });
    const ctxSessionRef = {
      channelId: 'telegram',
      accountId: 'acct-2',
      chatId: 'chat-9',
      userId: 'user-3',
    };
    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 'telegram:acct-2:chat-9',
        conversationId: 555,
        channelId: 'telegram',
        recentMessages: withMentionedSources([sourceId]),
        messageWindowSize: 6,
        startedAt: new Date(),
      },
      sessionRef: ctxSessionRef,
    });
    const result = await handleCreateTracking(
      '追踪',
      realService,
      ctx,
      vi.fn() as unknown as ServiceCallLlmFn,
    );

    expect(result.type).toBe('clarify');
    if (result.type === 'clarify') {
      expect(result.questionKey).toBe('tracking_resolve_entity');
      expect(result.structuredOptions).toHaveLength(2);
    }
    const raw = (tdb.db as unknown as { $client: import('better-sqlite3').Database }).$client;
    const row = raw
      .prepare('SELECT pending_resolution FROM tracking_rules ORDER BY id DESC LIMIT 1')
      .get() as { pending_resolution: string };
    const parsed = JSON.parse(row.pending_resolution);
    expect(parsed.conversationId).toBe(555);
    expect(parsed.sessionRef).toEqual(ctxSessionRef);
    expect(parsed.candidateEntityIds).toHaveLength(2);
  });
});
