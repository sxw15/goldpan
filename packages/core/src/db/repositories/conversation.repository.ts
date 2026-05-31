import { SqliteError } from 'better-sqlite3';
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { stripInternalKeys } from '../../conversation/metadata-utils';
import type { ConversationContext } from '../../conversation/types';
import type { DrizzleDB } from '../connection';
import { conversationMessages, conversations } from '../schema';
import { dateToMs, utcNowMs } from '../timestamp';
import type {
  BufferedMessageCandidate,
  ConversationArchiveReason,
  ConversationListItem,
  ConversationMessageInput,
  ConversationMessageRecord,
  ConversationMessageWithSession,
  ConversationRepository,
  ConversationSessionListQuery,
  ExpiredBufferedMessage,
} from './types';

function deriveTitle(firstUserMsg: string | null): string | null {
  if (!firstUserMsg) return null;
  const trimmed = firstUserMsg.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 50) return trimmed;
  return `${trimmed.slice(0, 50)}…`;
}

export class ConversationNotFoundError extends Error {
  readonly code = 'conversation_not_found';
  constructor(public readonly conversationId: number) {
    super(`Conversation #${conversationId} not found`);
    this.name = 'ConversationNotFoundError';
  }
}

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private db: DrizzleDB) {}

  findOrCreate(sessionKey: string, channelId: string): { id: number; created: boolean } {
    const existing = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.sessionKey, sessionKey), isNull(conversations.archivedAt)))
      .get();
    if (existing) return { id: existing.id, created: false };

    try {
      const [row] = this.db
        .insert(conversations)
        .values({ sessionKey, channelId })
        .returning({ id: conversations.id })
        .all();
      return { id: row.id, created: true };
    } catch (err) {
      if (err instanceof SqliteError && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const row = this.db
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.sessionKey, sessionKey), isNull(conversations.archivedAt)))
          .get();
        if (row) return { id: row.id, created: false };
      }
      throw err;
    }
  }

  findActiveBySessionKey(sessionKey: string): number | null {
    const row = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.sessionKey, sessionKey), isNull(conversations.archivedAt)))
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
      .limit(1)
      .get();
    return row?.id ?? null;
  }

  listBySessionKey(query: ConversationSessionListQuery): {
    items: ConversationListItem[];
    total: number;
  } {
    const { sessionKey, limit, offset, includeActive = false } = query;
    const whereCond = includeActive
      ? eq(conversations.sessionKey, sessionKey)
      : and(eq(conversations.sessionKey, sessionKey), isNotNull(conversations.archivedAt));

    const totalRow = this.db.select({ c: count() }).from(conversations).where(whereCond).get();
    const total = Number(totalRow?.c ?? 0);

    const convs = this.db
      .select({
        id: conversations.id,
        sessionKey: conversations.sessionKey,
        channelId: conversations.channelId,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
        lastMessageAt: conversations.lastMessageAt,
        archivedAt: conversations.archivedAt,
        archivedReason: conversations.archivedReason,
      })
      .from(conversations)
      .where(whereCond)
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
      .limit(limit)
      .offset(offset)
      .all();

    const ids = convs.map((c) => c.id);
    const titleMap = new Map<number, string | null>();
    const countMap = new Map<number, number>();

    if (ids.length > 0) {
      const titleRows = this.db
        .select({
          conversationId: conversationMessages.conversationId,
          content: conversationMessages.content,
        })
        .from(conversationMessages)
        .where(
          and(
            inArray(conversationMessages.conversationId, ids),
            eq(conversationMessages.role, 'user'),
          ),
        )
        .orderBy(conversationMessages.createdAt, conversationMessages.id)
        .all();

      for (const r of titleRows) {
        if (!titleMap.has(r.conversationId)) {
          titleMap.set(r.conversationId, r.content);
        }
      }

      const countRows = this.db
        .select({
          conversationId: conversationMessages.conversationId,
          c: count(),
        })
        .from(conversationMessages)
        .where(inArray(conversationMessages.conversationId, ids))
        .groupBy(conversationMessages.conversationId)
        .all();

      for (const r of countRows) {
        countMap.set(r.conversationId, Number(r.c));
      }
    }

    const items: ConversationListItem[] = convs.map((r) => ({
      id: r.id,
      sessionKey: r.sessionKey,
      channelId: r.channelId,
      title: deriveTitle(titleMap.get(r.id) ?? null),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastMessageAt: r.lastMessageAt,
      archivedAt: r.archivedAt,
      archivedReason: r.archivedReason,
      messageCount: countMap.get(r.id) ?? 0,
    }));
    return { items, total };
  }

  deleteById(id: number): void {
    this.db.delete(conversations).where(eq(conversations.id, id)).run();
  }

  unarchive(id: number): void {
    this.db.transaction((tx) => {
      const target = tx
        .select({
          sessionKey: conversations.sessionKey,
          archivedAt: conversations.archivedAt,
        })
        .from(conversations)
        .where(eq(conversations.id, id))
        .get();
      if (!target) throw new ConversationNotFoundError(id);
      if (target.archivedAt === null) return;

      const now = utcNowMs();
      const displaced = tx
        .update(conversations)
        .set({ archivedAt: now, archivedReason: 'user_reset', updatedAt: now })
        .where(
          and(eq(conversations.sessionKey, target.sessionKey), isNull(conversations.archivedAt)),
        )
        .returning({ id: conversations.id })
        .all();

      // 与 archive() 对称：被 inline-archive 的 conv 也要 consume 其 buffered_wait，
      // 否则 Path E cron 仍会 finalize 一条"幽灵" assistant turn 进归档会话。
      for (const d of displaced) {
        tx.update(conversationMessages)
          .set({ status: 'consumed' })
          .where(
            and(
              eq(conversationMessages.conversationId, d.id),
              eq(conversationMessages.status, 'buffered_wait'),
            ),
          )
          .run();
      }

      tx.update(conversations)
        .set({ archivedAt: null, archivedReason: null, updatedAt: now })
        .where(eq(conversations.id, id))
        .run();
    });
  }

  loadContext(sessionKey: string, windowSize: number): ConversationContext | null {
    const conv = this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.sessionKey, sessionKey), isNull(conversations.archivedAt)))
      .get();
    if (!conv) return null;

    const rows = this.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, conv.id),
          // P3: 跳过 consumed —— 它们已经被 finalize 成 follow-up turn，再 surface 会 echo
          sql`${conversationMessages.status} != 'consumed'`,
        ),
      )
      .orderBy(desc(conversationMessages.createdAt), desc(conversationMessages.id))
      .limit(windowSize)
      .all();

    const recentMessages = rows.reverse().map((r) => ({
      id: r.id,
      role: r.role as 'user' | 'assistant',
      content: r.content,
      metadata: r.metadata ? stripInternalKeys(this.parseMetadata(r.metadata)) : undefined,
      createdAt: new Date(r.createdAt),
      // P3: 暴露 status / bufferedExpiresAt 让 UI 渲染 indicator
      status: r.status as 'normal' | 'buffered_wait' | 'consumed' | undefined,
      bufferedExpiresAt: r.bufferedExpiresAt ?? undefined,
    }));

    return {
      sessionKey,
      conversationId: conv.id,
      channelId: conv.channelId,
      recentMessages,
      messageWindowSize: windowSize,
      startedAt: new Date(conv.createdAt),
    };
  }

  appendMessage(conversationId: number, msg: ConversationMessageInput): { id: number } {
    const now = utcNowMs();
    const result = this.db.transaction((tx) => {
      const [row] = tx
        .insert(conversationMessages)
        .values({
          conversationId,
          role: msg.role,
          content: msg.content,
          metadata: msg.metadata ? JSON.stringify(msg.metadata) : null,
          createdAt: now,
        })
        .returning({ id: conversationMessages.id })
        .all();
      tx.update(conversations)
        .set({ updatedAt: now, lastMessageAt: now })
        .where(eq(conversations.id, conversationId))
        .run();
      return { id: row.id };
    });
    return result;
  }

  markBufferedWait(
    messageId: number,
    expiresAt: number,
    classifierDecision: Record<string, unknown>,
    userMeta?: { waitReasonKey?: string },
  ): boolean {
    // 单 UPDATE 内用 SQL json_set() 把 classifierDecision 塞进 __internal namespace，
    // 不读不 parse 现有 metadata —— 避免 SELECT/UPDATE 两步之间 metadata 被并发写覆盖的
    // TOCTOU race（plan §"关键设计取舍" 第 11 条）。
    //
    // 表达式：json_set(COALESCE(metadata,'{}'),
    //   '$.__internal.classifierDecision', json(<jsonStr>),
    //   '$.waitReasonKey', <waitReasonKey>)
    //   - COALESCE 防 metadata 为 NULL 时 json_set 返 NULL
    //   - 第三个参数用 json(<jsonStr>) 让 SQLite 把字符串当 JSON 解析后嵌入（而非字符串字面量）
    //   - WHERE status='normal' 是真正的 CAS —— 已 buffered_wait/consumed 时 changes=0
    //
    // P3: 顶层 metadata.waitReasonKey 也一起写 —— stripInternalKeys 剥掉 __internal
    // 后 UI 仍能拿到 waitReasonKey 渲染等待提示。仅在 userMeta.waitReasonKey 存在时
    // 写入；否则保持原样（不污染历史 P2 caller 的 metadata 形状）。
    //
    // 注意：SQLite ≥3.38 支持 json_set 路径自动建中间对象（'$.__internal' 不存在时
    // 自动创建），better-sqlite3 内置版本满足（v11+）。
    const decisionJson = JSON.stringify(classifierDecision);
    const waitReasonKey = userMeta?.waitReasonKey;

    // 拼接 json_set：base 总写 __internal.classifierDecision；waitReasonKey 仅在
    // 提供时多带一对 path/value。SQLite json_set 支持可变 path/value 对。
    const metadataExpr =
      waitReasonKey !== undefined
        ? sql`json_set(
            COALESCE(${conversationMessages.metadata}, '{}'),
            '$.__internal.classifierDecision', json(${decisionJson}),
            '$.waitReasonKey', ${waitReasonKey}
          )`
        : sql`json_set(
            COALESCE(${conversationMessages.metadata}, '{}'),
            '$.__internal.classifierDecision', json(${decisionJson})
          )`;

    const result = this.db
      .update(conversationMessages)
      .set({
        status: 'buffered_wait',
        bufferedExpiresAt: expiresAt,
        metadata: metadataExpr,
      })
      .where(and(eq(conversationMessages.id, messageId), eq(conversationMessages.status, 'normal')))
      .run();

    return (result.changes ?? 0) > 0;
  }

  findActiveBufferedBySession(sessionKey: string): {
    id: number;
    content: string;
    conversationId: number;
    bufferedExpiresAt: number;
    classifierDecision: Record<string, unknown> | null;
  } | null {
    const now = Date.now();
    const row = this.db
      .select({
        id: conversationMessages.id,
        content: conversationMessages.content,
        conversationId: conversationMessages.conversationId,
        bufferedExpiresAt: conversationMessages.bufferedExpiresAt,
        metadata: conversationMessages.metadata,
      })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(
        and(
          eq(conversations.sessionKey, sessionKey),
          isNull(conversations.archivedAt),
          eq(conversationMessages.status, 'buffered_wait'),
          // expires_at > now (still active)
          sql`${conversationMessages.bufferedExpiresAt} > ${now}`,
        ),
      )
      .orderBy(desc(conversationMessages.bufferedExpiresAt))
      .limit(1)
      .get();

    if (!row) return null;
    const parsed = row.metadata ? this.parseMetadata(row.metadata) : null;
    const classifierDecision =
      (parsed?.__internal as { classifierDecision?: Record<string, unknown> } | undefined)
        ?.classifierDecision ?? null;
    return {
      id: row.id,
      content: row.content,
      conversationId: row.conversationId,
      bufferedExpiresAt: row.bufferedExpiresAt as number,
      classifierDecision,
    };
  }

  findAllActiveBufferedBySession(sessionKey: string): Array<{
    id: number;
    content: string;
    conversationId: number;
    bufferedExpiresAt: number;
  }> {
    const now = Date.now();
    return this.db
      .select({
        id: conversationMessages.id,
        content: conversationMessages.content,
        conversationId: conversationMessages.conversationId,
        bufferedExpiresAt: conversationMessages.bufferedExpiresAt,
      })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(
        and(
          eq(conversations.sessionKey, sessionKey),
          isNull(conversations.archivedAt),
          eq(conversationMessages.status, 'buffered_wait'),
          sql`${conversationMessages.bufferedExpiresAt} > ${now}`,
        ),
      )
      .orderBy(conversationMessages.createdAt)
      .all() as Array<{
      id: number;
      content: string;
      conversationId: number;
      bufferedExpiresAt: number;
    }>;
  }

  findPendingBufferedBySession(sessionKey: string): BufferedMessageCandidate | null {
    const row = this.db
      .select({
        id: conversationMessages.id,
        content: conversationMessages.content,
        conversationId: conversationMessages.conversationId,
        bufferedExpiresAt: conversationMessages.bufferedExpiresAt,
        metadata: conversationMessages.metadata,
      })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(
        and(
          eq(conversations.sessionKey, sessionKey),
          isNull(conversations.archivedAt),
          eq(conversationMessages.status, 'buffered_wait'),
        ),
      )
      .orderBy(desc(conversationMessages.bufferedExpiresAt))
      .limit(1)
      .get();

    if (!row) return null;
    return {
      id: row.id,
      content: row.content,
      conversationId: row.conversationId,
      bufferedExpiresAt: row.bufferedExpiresAt as number,
      classifierDecision: this.parseClassifierDecision(row.metadata),
    };
  }

  findExpiredBuffered(graceMs: number, limit: number): ExpiredBufferedMessage[] {
    const threshold = Date.now() - graceMs;
    const rows = this.db
      .select({
        id: conversationMessages.id,
        conversationId: conversationMessages.conversationId,
        sessionKey: conversations.sessionKey,
        content: conversationMessages.content,
        metadata: conversationMessages.metadata,
      })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(
        and(
          // 与 BySession / ByConversation 变体对齐：跳过已归档 conv 的 buffer，
          // 否则 Path E cron 会 finalize 一条"幽灵" assistant turn。
          isNull(conversations.archivedAt),
          eq(conversationMessages.status, 'buffered_wait'),
          sql`${conversationMessages.bufferedExpiresAt} < ${threshold}`,
        ),
      )
      .orderBy(conversationMessages.bufferedExpiresAt)
      .limit(limit)
      .all();

    return rows.map((r) => this.mapExpiredBufferedRow(r));
  }

  findExpiredBufferedBySession(
    sessionKey: string,
    graceMs: number,
    limit: number,
  ): ExpiredBufferedMessage[] {
    const threshold = Date.now() - graceMs;
    const rows = this.db
      .select({
        id: conversationMessages.id,
        conversationId: conversationMessages.conversationId,
        sessionKey: conversations.sessionKey,
        content: conversationMessages.content,
        metadata: conversationMessages.metadata,
      })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(
        and(
          eq(conversations.sessionKey, sessionKey),
          isNull(conversations.archivedAt),
          eq(conversationMessages.status, 'buffered_wait'),
          sql`${conversationMessages.bufferedExpiresAt} < ${threshold}`,
        ),
      )
      .orderBy(conversationMessages.bufferedExpiresAt)
      .limit(limit)
      .all();

    return rows.map((r) => this.mapExpiredBufferedRow(r));
  }

  findExpiredBufferedByConversation(
    conversationId: number,
    graceMs: number,
    limit: number,
  ): ExpiredBufferedMessage[] {
    const threshold = Date.now() - graceMs;
    const rows = this.db
      .select({
        id: conversationMessages.id,
        conversationId: conversationMessages.conversationId,
        sessionKey: conversations.sessionKey,
        content: conversationMessages.content,
        metadata: conversationMessages.metadata,
      })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(
        and(
          eq(conversationMessages.conversationId, conversationId),
          isNull(conversations.archivedAt),
          eq(conversationMessages.status, 'buffered_wait'),
          sql`${conversationMessages.bufferedExpiresAt} < ${threshold}`,
        ),
      )
      .orderBy(conversationMessages.bufferedExpiresAt)
      .limit(limit)
      .all();

    return rows.map((r) => this.mapExpiredBufferedRow(r));
  }

  consumeBuffered(messageId: number): {
    content: string;
    conversationId: number;
    classifierDecision: Record<string, unknown> | null;
  } | null {
    // SQLite 3.35+ 支持 UPDATE ... RETURNING；drizzle 用 .returning() 包装。
    // 单语句原子：CAS 失败时 .all() 返空数组，幂等。
    const result = this.db
      .update(conversationMessages)
      .set({ status: 'consumed' })
      .where(
        and(
          eq(conversationMessages.id, messageId),
          eq(conversationMessages.status, 'buffered_wait'),
        ),
      )
      .returning({
        content: conversationMessages.content,
        conversationId: conversationMessages.conversationId,
        metadata: conversationMessages.metadata,
      })
      .all();

    const row = result[0];
    if (!row) return null;
    const parsed = row.metadata ? this.parseMetadata(row.metadata) : null;
    const decision =
      (parsed?.__internal as { classifierDecision?: Record<string, unknown> } | undefined)
        ?.classifierDecision ?? null;
    return {
      content: row.content,
      conversationId: row.conversationId,
      classifierDecision: decision,
    };
  }

  // (consumeAllBufferedInConversation 已在 P3 二轮 review 中删除 ——
  //  archive 内 inline 写 SQL 即可，详见 Task 2 step 3)

  archive(
    sessionKey: string,
    reason: ConversationArchiveReason,
  ): { id: number; archivedAt: number } | null {
    const now = utcNowMs();
    // 用事务：先标 conversation archived，再批量 consume 该 conv 的 buffered。
    // 保证两步原子 —— 不会出现 conv 标了但 buffered 没清的中间态。
    return this.db.transaction((tx) => {
      const [updated] = tx
        .update(conversations)
        .set({ archivedAt: now, archivedReason: reason, updatedAt: now })
        .where(and(eq(conversations.sessionKey, sessionKey), isNull(conversations.archivedAt)))
        .returning({ id: conversations.id, archivedAt: conversations.archivedAt })
        .all();
      if (!updated) return null;

      // 同 tx 内把该 conversation 的 buffered_wait 全标 consumed（spec §"错误处理" #11）
      tx.update(conversationMessages)
        .set({ status: 'consumed' })
        .where(
          and(
            eq(conversationMessages.conversationId, updated.id),
            eq(conversationMessages.status, 'buffered_wait'),
          ),
        )
        .run();

      return { id: updated.id, archivedAt: updated.archivedAt as number };
    });
  }

  getMessageById(id: number): ConversationMessageWithSession | null {
    const row = this.db
      .select({
        id: conversationMessages.id,
        conversationId: conversationMessages.conversationId,
        sessionKey: conversations.sessionKey,
        archivedAt: conversations.archivedAt,
        role: conversationMessages.role,
        content: conversationMessages.content,
        metadata: conversationMessages.metadata,
        createdAt: conversationMessages.createdAt,
      })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversationMessages.conversationId, conversations.id))
      .where(eq(conversationMessages.id, id))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversationId,
      sessionKey: row.sessionKey,
      conversationArchivedAt: row.archivedAt,
      role: row.role as 'user' | 'assistant',
      content: row.content,
      metadata: row.metadata ? stripInternalKeys(this.parseMetadata(row.metadata)) : undefined,
      createdAt: row.createdAt,
    };
  }

  loadConversationById(conversationId: number): {
    id: number;
    sessionKey: string;
    channelId: string;
    archivedAt: number | null;
    messages: ConversationMessageRecord[];
  } | null {
    const conv = this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    if (!conv) return null;
    const rows = this.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conv.id))
      .orderBy(conversationMessages.createdAt, conversationMessages.id)
      .all();
    return {
      id: conv.id,
      sessionKey: conv.sessionKey,
      channelId: conv.channelId,
      archivedAt: conv.archivedAt,
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role as 'user' | 'assistant',
        content: r.content,
        metadata: r.metadata ? stripInternalKeys(this.parseMetadata(r.metadata)) : undefined,
        createdAt: r.createdAt,
        // P3: 透传 buffer 字段，让 UI 在加载历史对话时仍能渲染
        // BufferedWaitIndicator / consumed badge。
        status: r.status as 'normal' | 'buffered_wait' | 'consumed' | undefined,
        bufferedExpiresAt: r.bufferedExpiresAt ?? undefined,
      })),
    };
  }

  purgeArchived(olderThan: Date): number {
    const cutoff = dateToMs(olderThan);
    const result = this.db
      .delete(conversations)
      .where(and(isNotNull(conversations.archivedAt), lt(conversations.archivedAt, cutoff)))
      .run();
    return result.changes ?? 0;
  }

  private parseMetadata(raw: string): Record<string, unknown> | undefined {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  private parseClassifierDecision(raw: string | null): Record<string, unknown> | null {
    const parsed = raw ? this.parseMetadata(raw) : null;
    return (
      (parsed?.__internal as { classifierDecision?: Record<string, unknown> } | undefined)
        ?.classifierDecision ?? null
    );
  }

  private mapExpiredBufferedRow(row: {
    id: number;
    conversationId: number;
    sessionKey: string;
    content: string;
    metadata: string | null;
  }): ExpiredBufferedMessage {
    return {
      id: row.id,
      conversationId: row.conversationId,
      sessionKey: row.sessionKey,
      content: row.content,
      classifierDecision: this.parseClassifierDecision(row.metadata),
    };
  }
}
