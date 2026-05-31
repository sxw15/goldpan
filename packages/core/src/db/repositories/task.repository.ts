import type Database from 'better-sqlite3';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../connection';
import { processingTasks } from '../schema';
import { utcNowMs } from '../timestamp';
import type {
  CreateTaskInput,
  InputType,
  PipelineStep,
  ProcessingTask,
  TaskErrorKind,
  TaskRepository,
  TaskStatus,
  TaskStatusCounts,
} from './types';

export class SqliteTaskRepository implements TaskRepository {
  constructor(
    private db: DrizzleDB,
    private rawDb: Database.Database,
  ) {}

  create(input: CreateTaskInput): ProcessingTask {
    const [task] = this.db
      .insert(processingTasks)
      .values({
        sourceId: input.sourceId,
        type: input.type,
        inputType: input.inputType ?? null,
      })
      .returning()
      .all();
    return task;
  }

  getById(id: number): ProcessingTask | undefined {
    return this.db.select().from(processingTasks).where(eq(processingTasks.id, id)).get();
  }

  hasProcessingTask(): boolean {
    const row = this.db
      .select({ id: processingTasks.id })
      .from(processingTasks)
      .where(eq(processingTasks.status, 'processing'))
      .limit(1)
      .get();
    return !!row;
  }

  claimNextPending(): ProcessingTask | undefined {
    const stmt = this.rawDb.prepare(`
      UPDATE processing_tasks
      SET status = 'processing', updated_at = ?
      WHERE id = (
        SELECT id FROM processing_tasks
        WHERE status = 'pending' AND type = 'pipeline'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      )
      RETURNING id
    `);

    const result = this.rawDb
      .transaction(() => {
        return stmt.get(utcNowMs()) as { id: number } | undefined;
      })
      .immediate();

    if (!result) return undefined;
    return this.getById(result.id);
  }

  updatePipelineStep(id: number, step: PipelineStep): void {
    const result = this.db
      .update(processingTasks)
      .set({ pipelineStep: step, updatedAt: utcNowMs() })
      .where(eq(processingTasks.id, id))
      .run();
    if (result.changes === 0) {
      throw new Error(`Task not found: ${id}`);
    }
  }

  updateInputType(id: number, inputType: InputType): void {
    const result = this.db
      .update(processingTasks)
      .set({ inputType, updatedAt: utcNowMs() })
      .where(eq(processingTasks.id, id))
      .run();
    if (result.changes === 0) {
      throw new Error(`Task not found: ${id}`);
    }
  }

  markDone(id: number, resultJson: string): void {
    const result = this.db
      .update(processingTasks)
      .set({
        status: 'done',
        result: resultJson,
        errorMessage: null,
        errorKind: null,
        updatedAt: utcNowMs(),
      })
      .where(and(eq(processingTasks.id, id), eq(processingTasks.status, 'processing')))
      .run();
    if (result.changes === 0) {
      const task = this.db.select().from(processingTasks).where(eq(processingTasks.id, id)).get();
      if (!task) throw new Error(`Task not found: ${id}`);
      throw new Error(`Only processing tasks can be marked done, current status: ${task.status}`);
    }
  }

  markError(
    id: number,
    pipelineStep: PipelineStep | null,
    errorMessage: string,
    errorKind: TaskErrorKind,
  ): void {
    const result = this.db
      .update(processingTasks)
      .set({
        status: 'error',
        pipelineStep,
        errorMessage,
        errorKind,
        updatedAt: utcNowMs(),
      })
      .where(
        and(eq(processingTasks.id, id), inArray(processingTasks.status, ['pending', 'processing'])),
      )
      .run();
    if (result.changes === 0) {
      const task = this.db.select().from(processingTasks).where(eq(processingTasks.id, id)).get();
      if (!task) throw new Error(`Task not found: ${id}`);
      throw new Error(
        `Cannot mark error: task ${id} has status '${task.status}', expected 'pending' or 'processing'`,
      );
    }
  }

  resetForRetry(id: number): void {
    const task = this.db.select().from(processingTasks).where(eq(processingTasks.id, id)).get();
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== 'error') {
      throw new Error(`Only error tasks can be retried, current status: ${task.status}`);
    }

    // Preserve URL (deterministic from source kind) and explicit `opinion`
    // (locked by submit for `record_thought` — the user's intent must not
    // be re-classified into `text` on retry, which would skip the
    // opinion-only extraction and tag persistence). Plain text stays
    // LLM-driven so a retry can re-detect when the model has improved.
    const preservedInputType =
      task.inputType === 'url' || task.inputType === 'opinion' ? task.inputType : null;

    const result = this.db
      .update(processingTasks)
      .set({
        status: 'pending',
        pipelineStep: null,
        inputType: preservedInputType,
        errorMessage: null,
        errorKind: null,
        result: null,
        updatedAt: utcNowMs(),
      })
      .where(and(eq(processingTasks.id, id), eq(processingTasks.status, 'error')))
      .run();
    if (result.changes === 0) {
      const current = this.getById(id);
      throw new Error(
        `Task ${id} status changed before retry could complete` +
          `, current status: ${current?.status ?? 'unknown'}`,
      );
    }
  }

  resetAllProcessing(): number {
    const result = this.db
      .update(processingTasks)
      .set({
        status: 'pending',
        pipelineStep: null,
        inputType: sql`CASE WHEN ${processingTasks.inputType} = 'url' THEN 'url' ELSE NULL END`,
        errorMessage: null,
        errorKind: null,
        result: null,
        updatedAt: utcNowMs(),
      })
      .where(eq(processingTasks.status, 'processing'))
      .run();
    return result.changes;
  }

  getRecent(limit = 50, statusFilter?: readonly TaskStatus[]): ProcessingTask[] {
    if (statusFilter && statusFilter.length > 0) {
      return this.db
        .select()
        .from(processingTasks)
        .where(inArray(processingTasks.status, statusFilter as TaskStatus[]))
        .orderBy(desc(processingTasks.id))
        .limit(limit)
        .all();
    }
    return this.db
      .select()
      .from(processingTasks)
      .orderBy(desc(processingTasks.id))
      .limit(limit)
      .all();
  }

  getCountsByStatus(): TaskStatusCounts {
    const rows = this.db
      .select({
        status: processingTasks.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(processingTasks)
      .groupBy(processingTasks.status)
      .all();
    const counts: TaskStatusCounts = { pending: 0, processing: 0, done: 0, error: 0 };
    for (const r of rows) {
      if (r.status in counts) {
        counts[r.status as TaskStatus] = Number(r.count) || 0;
      }
    }
    return counts;
  }
}
