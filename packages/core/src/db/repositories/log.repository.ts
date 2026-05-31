import { desc, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../connection';
import { eventLogs, submissionLogs } from '../schema';
import { utcNowMs } from '../timestamp';
import type {
  CreateEventLogInput,
  CreateSubmissionLogInput,
  EventAction,
  EventLog,
  EventLogRepository,
  SubmissionLog,
  SubmissionLogRepository,
} from './types';

export class SqliteEventLogRepository implements EventLogRepository {
  constructor(private db: DrizzleDB) {}

  create(input: CreateEventLogInput): EventLog {
    const [entry] = this.db
      .insert(eventLogs)
      .values({
        sourceId: input.sourceId,
        entityId: input.entityId ?? null,
        pointId: input.pointId ?? null,
        action: input.action,
        summary: input.summary ?? null,
        timestamp: utcNowMs(),
      })
      .returning()
      .all();
    return entry;
  }

  getBySourceId(sourceId: number): EventLog[] {
    return this.db
      .select()
      .from(eventLogs)
      .where(eq(eventLogs.sourceId, sourceId))
      .orderBy(desc(eventLogs.id))
      .all();
  }

  getByAction(action: EventAction, limit = 50): EventLog[] {
    return this.db
      .select()
      .from(eventLogs)
      .where(eq(eventLogs.action, action))
      .orderBy(desc(eventLogs.id))
      .limit(limit)
      .all();
  }

  getRecent(limit = 50): EventLog[] {
    return this.db.select().from(eventLogs).orderBy(desc(eventLogs.id)).limit(limit).all();
  }
}

export class SqliteSubmissionLogRepository implements SubmissionLogRepository {
  constructor(private db: DrizzleDB) {}

  create(input: CreateSubmissionLogInput): SubmissionLog {
    if (input.result === 'accepted' && (input.sourceId == null || input.taskId == null)) {
      throw new Error('accepted submission requires both sourceId and taskId');
    }
    const [entry] = this.db
      .insert(submissionLogs)
      .values({
        rawInput: input.rawInput,
        result: input.result,
        reason: input.reason ?? null,
        taskId: input.taskId ?? null,
        sourceId: input.sourceId ?? null,
        createdAt: utcNowMs(),
      })
      .returning()
      .all();
    return entry;
  }

  getByTaskId(taskId: number): SubmissionLog[] {
    return this.db
      .select()
      .from(submissionLogs)
      .where(eq(submissionLogs.taskId, taskId))
      .orderBy(desc(submissionLogs.id))
      .all();
  }

  getRecent(limit = 50): SubmissionLog[] {
    return this.db
      .select()
      .from(submissionLogs)
      .orderBy(desc(submissionLogs.id))
      .limit(limit)
      .all();
  }
}
