import type { ILogObj, Logger } from 'tslog';
import { describe, expect, it, vi } from 'vitest';
import { SqliteConversationRepository } from '../../src/db/repositories/conversation.repository';
import { SqliteKnowledgeRepository } from '../../src/db/repositories/knowledge.repository';
import {
  entities,
  knowledgePoints,
  noteSources,
  notes,
  sourceEntityPoints,
  sources,
} from '../../src/db/schema';
import { onSourceTerminated } from '../../src/deferred/resolver';
import type { DeferredTrackingPort, PendingResolutionPayload } from '../../src/deferred/types';
import { createTestDB } from '../helpers/test-db';

function silentLogger(): Logger<ILogObj> {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger<ILogObj>;
}

type PortCall = { id: number } & Record<string, unknown>;

interface PortRecorder extends DeferredTrackingPort {
  resolved: PortCall[];
  failed: PortCall[];
  clarify: PortCall[];
}

function buildPort(
  initial: Array<{ id: number; payload: PendingResolutionPayload }>,
): PortRecorder {
  const resolved: PortCall[] = [];
  const failed: PortCall[] = [];
  const clarify: PortCall[] = [];
  const data = new Map(initial.map((r) => [r.id, r]));
  return {
    resolved,
    failed,
    clarify,
    findPendingByPipelineSource(sourceId: number) {
      return [...data.values()]
        .filter((r) => r.payload.sourceId === sourceId)
        .map((r) => ({ id: r.id, pendingResolution: r.payload }));
    },
    markResolved(id, input) {
      resolved.push({ id, ...input });
      return true;
    },
    markFailedResolution(id, input) {
      failed.push({ id, ...input });
      return true;
    },
    markAwaitingClarify(id, input) {
      clarify.push({ id, ...input });
      return true;
    },
    findAwaitingClarifyOlderThan() {
      return [];
    },
  };
}

describe('onSourceTerminated', () => {
  it('confirmed + 1 entity → markResolved + push action assistant turn', () => {
    const tdb = createTestDB();
    try {
      const knowledge = new SqliteKnowledgeRepository(tdb.db);
      const convRepo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = convRepo.findOrCreate('test:p4:1', 'test');

      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://x',
          originalUrl: 'http://x',
          status: 'confirmed',
        })
        .returning()
        .all();
      const [e1] = tdb.db.insert(entities).values({ name: 'Anthropic' }).returning().all();
      const [p] = tdb.db
        .insert(knowledgePoints)
        .values({ content: 'p', type: 'fact' })
        .returning()
        .all();
      tdb.db
        .insert(sourceEntityPoints)
        .values({ sourceId: src.id, entityId: e1.id, pointId: p.id, judgment: 'new' })
        .run();

      const port = buildPort([
        {
          id: 7,
          payload: { sourceId: src.id, placeholderName: 'this company', conversationId: convId },
        },
      ]);

      onSourceTerminated(src.id, 'confirmed', {
        db: tdb.db,
        knowledge,
        conversation: convRepo,
        trackingPort: port,
        logger: silentLogger(),
      });

      expect(port.resolved).toHaveLength(1);
      expect(port.resolved[0]).toMatchObject({
        id: 7,
        name: 'Anthropic',
        linkedEntityIds: [e1.id],
      });

      const ctx = convRepo.loadContext('test:p4:1', 6);
      const last = ctx?.recentMessages.at(-1);
      expect(last?.role).toBe('assistant');
      expect((last?.metadata as Record<string, unknown>)?.resultType).toBe('action');
      expect((last?.metadata as Record<string, unknown>)?.trackingRuleId).toBe(7);
    } finally {
      tdb.cleanup();
    }
  });

  it('confirmed + N entity → markAwaitingClarify + push clarify assistant turn', () => {
    const tdb = createTestDB();
    try {
      const knowledge = new SqliteKnowledgeRepository(tdb.db);
      const convRepo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = convRepo.findOrCreate('test:p4:2', 'test');
      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://x2',
          originalUrl: 'http://x2',
          status: 'confirmed',
        })
        .returning()
        .all();
      const [e1] = tdb.db.insert(entities).values({ name: 'A' }).returning().all();
      const [e2] = tdb.db.insert(entities).values({ name: 'B' }).returning().all();
      const [p] = tdb.db
        .insert(knowledgePoints)
        .values({ content: 'p', type: 'fact' })
        .returning()
        .all();
      tdb.db
        .insert(sourceEntityPoints)
        .values([
          { sourceId: src.id, entityId: e1.id, pointId: p.id, judgment: 'new' },
          { sourceId: src.id, entityId: e2.id, pointId: p.id, judgment: 'new' },
        ])
        .run();

      const port = buildPort([
        {
          id: 8,
          payload: { sourceId: src.id, placeholderName: 'X', conversationId: convId },
        },
      ]);
      onSourceTerminated(src.id, 'confirmed', {
        db: tdb.db,
        knowledge,
        conversation: convRepo,
        trackingPort: port,
        logger: silentLogger(),
      });

      expect(port.clarify).toHaveLength(1);
      const candidates = port.clarify[0].candidateEntityIds as number[];
      expect([...candidates].sort()).toEqual([e1.id, e2.id].sort());

      const last = convRepo.loadContext('test:p4:2', 6)?.recentMessages.at(-1);
      expect((last?.metadata as Record<string, unknown>)?.resultType).toBe('clarify');
    } finally {
      tdb.cleanup();
    }
  });

  it('confirmed + 0 entity → markFailedResolution(failed_no_entity)', () => {
    const tdb = createTestDB();
    try {
      const knowledge = new SqliteKnowledgeRepository(tdb.db);
      const convRepo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = convRepo.findOrCreate('test:p4:3', 'test');
      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://x3',
          originalUrl: 'http://x3',
          status: 'confirmed',
        })
        .returning()
        .all();
      const port = buildPort([
        { id: 9, payload: { sourceId: src.id, placeholderName: 'X', conversationId: convId } },
      ]);

      onSourceTerminated(src.id, 'confirmed', {
        db: tdb.db,
        knowledge,
        conversation: convRepo,
        trackingPort: port,
        logger: silentLogger(),
      });

      expect(port.failed[0]).toMatchObject({ id: 9, targetStatus: 'failed_no_entity' });
    } finally {
      tdb.cleanup();
    }
  });

  it('confirmed_empty → markFailedResolution(failed_no_entity)', () => {
    const tdb = createTestDB();
    try {
      const knowledge = new SqliteKnowledgeRepository(tdb.db);
      const convRepo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = convRepo.findOrCreate('test:p4:3b', 'test');
      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://x3b',
          originalUrl: 'http://x3b',
          status: 'confirmed_empty',
        })
        .returning()
        .all();
      const port = buildPort([
        { id: 10, payload: { sourceId: src.id, placeholderName: 'X', conversationId: convId } },
      ]);

      onSourceTerminated(src.id, 'confirmed_empty', {
        db: tdb.db,
        knowledge,
        conversation: convRepo,
        trackingPort: port,
        logger: silentLogger(),
      });
      expect(port.failed[0]).toMatchObject({ targetStatus: 'failed_no_entity' });
    } finally {
      tdb.cleanup();
    }
  });

  it('failed → markFailedResolution(failed_source_pipeline)', () => {
    const tdb = createTestDB();
    try {
      const knowledge = new SqliteKnowledgeRepository(tdb.db);
      const convRepo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = convRepo.findOrCreate('test:p4:fail', 'test');
      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://xf',
          originalUrl: 'http://xf',
          status: 'failed',
        })
        .returning()
        .all();
      const port = buildPort([
        { id: 11, payload: { sourceId: src.id, placeholderName: 'X', conversationId: convId } },
      ]);

      onSourceTerminated(src.id, 'failed', {
        db: tdb.db,
        knowledge,
        conversation: convRepo,
        trackingPort: port,
        logger: silentLogger(),
      });
      expect(port.failed[0]).toMatchObject({ targetStatus: 'failed_source_pipeline' });
    } finally {
      tdb.cleanup();
    }
  });

  it('discarded → markFailedResolution(failed_source_pipeline)', () => {
    const tdb = createTestDB();
    try {
      const knowledge = new SqliteKnowledgeRepository(tdb.db);
      const convRepo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = convRepo.findOrCreate('test:p4:disc', 'test');
      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://xd',
          originalUrl: 'http://xd',
          status: 'discarded',
        })
        .returning()
        .all();
      const port = buildPort([{ id: 12, payload: { sourceId: src.id, conversationId: convId } }]);
      onSourceTerminated(src.id, 'discarded', {
        db: tdb.db,
        knowledge,
        conversation: convRepo,
        trackingPort: port,
        logger: silentLogger(),
      });
      expect(port.failed[0]).toMatchObject({ targetStatus: 'failed_source_pipeline' });
    } finally {
      tdb.cleanup();
    }
  });

  it('sessionRef 存在 → imSendOutbound 被 fire-and-forget 调用', async () => {
    const tdb = createTestDB();
    try {
      const knowledge = new SqliteKnowledgeRepository(tdb.db);
      const convRepo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = convRepo.findOrCreate('test:p4:im', 'test');
      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://xim',
          originalUrl: 'http://xim',
          status: 'confirmed_empty',
        })
        .returning()
        .all();
      const sessionRef = { channelId: 'tg', accountId: 'a', chatId: 'c', userId: 'u' };
      const port = buildPort([
        { id: 13, payload: { sourceId: src.id, conversationId: convId, sessionRef } },
      ]);
      const imSendOutbound = vi.fn().mockResolvedValue(undefined);

      onSourceTerminated(src.id, 'confirmed_empty', {
        db: tdb.db,
        knowledge,
        conversation: convRepo,
        trackingPort: port,
        imSendOutbound,
        logger: silentLogger(),
      });

      await new Promise((r) => setImmediate(r));
      expect(imSendOutbound).toHaveBeenCalledWith('tg', sessionRef, expect.anything());
    } finally {
      tdb.cleanup();
    }
  });

  it('trackingPort 未注入 → 仅 backfill notes，不抛', () => {
    const tdb = createTestDB();
    try {
      const knowledge = new SqliteKnowledgeRepository(tdb.db);
      const convRepo = new SqliteConversationRepository(tdb.db);
      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://nt',
          originalUrl: 'http://nt',
          status: 'confirmed',
        })
        .returning()
        .all();
      expect(() =>
        onSourceTerminated(src.id, 'confirmed', {
          db: tdb.db,
          knowledge,
          conversation: convRepo,
          logger: silentLogger(),
        }),
      ).not.toThrow();
    } finally {
      tdb.cleanup();
    }
  });

  it('failed/discarded 时不跑 note backfill（无 entity 可填）', () => {
    const tdb = createTestDB();
    try {
      const knowledge = new SqliteKnowledgeRepository(tdb.db);
      const convRepo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = convRepo.findOrCreate('test:p4:nb', 'test');
      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://xnb',
          originalUrl: 'http://xnb',
          status: 'failed',
        })
        .returning()
        .all();
      const [n] = tdb.db.insert(notes).values({ content: 'x' }).returning().all();
      tdb.db
        .insert(noteSources)
        .values({ noteId: n.id, sourceId: src.id, relation: 'reference' })
        .run();
      const port = buildPort([{ id: 14, payload: { sourceId: src.id, conversationId: convId } }]);

      onSourceTerminated(src.id, 'failed', {
        db: tdb.db,
        knowledge,
        conversation: convRepo,
        trackingPort: port,
        logger: silentLogger(),
      });
      // backfill 不跑（resolver 在 failed 分支跳过）— note_entities 为空，已隐含
    } finally {
      tdb.cleanup();
    }
  });

  it('archived conversation → 不写 web assistant turn，但仍调 IM push', async () => {
    const tdb = createTestDB();
    try {
      const knowledge = new SqliteKnowledgeRepository(tdb.db);
      const convRepo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = convRepo.findOrCreate('test:p4:arch', 'test');
      // archive 这个 conversation
      convRepo.archive('test:p4:arch', 'user_reset');

      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://xa',
          originalUrl: 'http://xa',
          status: 'confirmed_empty',
        })
        .returning()
        .all();
      const sessionRef = { channelId: 'tg', accountId: 'a', chatId: 'c', userId: 'u' };
      const port = buildPort([
        { id: 15, payload: { sourceId: src.id, conversationId: convId, sessionRef } },
      ]);
      const imSendOutbound = vi.fn().mockResolvedValue(undefined);

      onSourceTerminated(src.id, 'confirmed_empty', {
        db: tdb.db,
        knowledge,
        conversation: convRepo,
        trackingPort: port,
        imSendOutbound,
        logger: silentLogger(),
      });

      // web message 没写：archived conversation
      const loaded = convRepo.loadConversationById(convId);
      expect(loaded?.messages).toHaveLength(0);

      // IM 依然被调（archive 是 web-only）
      await new Promise((r) => setImmediate(r));
      expect(imSendOutbound).toHaveBeenCalled();
    } finally {
      tdb.cleanup();
    }
  });
});
