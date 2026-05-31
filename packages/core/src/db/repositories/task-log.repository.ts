import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../connection';
import { taskLogs } from '../schema';
import { utcNowMs } from '../timestamp';
import type { CreateTaskLogInput, TaskLog, TaskLogRepository } from './types';

export class SqliteTaskLogRepository implements TaskLogRepository {
  constructor(private db: DrizzleDB) {}

  create(input: CreateTaskLogInput): TaskLog {
    const rows = this.db
      .insert(taskLogs)
      .values({
        taskId: input.taskId,
        step: input.step,
        event: input.event,
        message: input.message ?? null,
        inputSummary: input.inputSummary ?? null,
        outputSummary: input.outputSummary ?? null,
        timestamp: utcNowMs(),
      })
      .returning()
      .all();
    return rows[0];
  }

  getByTaskId(taskId: number): TaskLog[] {
    return this.db.select().from(taskLogs).where(eq(taskLogs.taskId, taskId)).all();
  }

  deleteByTaskId(taskId: number): void {
    this.db.delete(taskLogs).where(eq(taskLogs.taskId, taskId)).run();
  }
}
