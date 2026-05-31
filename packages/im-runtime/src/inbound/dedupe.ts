import type { DrizzleDB } from '@goldpan/core/db';
import { imMessagesSeen } from '@goldpan/core/db/schema';
import { sql } from 'drizzle-orm';

export interface DedupeKey {
  channelId: string;
  accountId: string;
  chatId: string;
  platformMsgId: string;
}

export class MessageDedupe {
  constructor(private db: DrizzleDB) {}

  /** Returns true if the message was recorded (new), false if it was already seen. */
  markIfNew(key: DedupeKey): boolean {
    try {
      this.db.insert(imMessagesSeen).values(key).run();
      return true;
    } catch (err) {
      // Only swallow UNIQUE constraint violations — those are the legitimate
      // "we've seen this message" signal. Catching the parent SQLITE_CONSTRAINT
      // would also silently swallow NOT NULL / CHECK / FK errors, which would
      // mask real schema-level regressions and let bad rows escape upstream.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
      ) {
        return false;
      }
      throw err;
    }
  }

  /** Deletes rows with seen_at older than the given threshold. Returns delete count. */
  purgeBefore(threshold: Date): number {
    const thresholdMs = threshold.getTime();
    const r = this.db
      .delete(imMessagesSeen)
      .where(sql`${imMessagesSeen.seenAt} < ${thresholdMs}`)
      .run();
    return r.changes ?? 0;
  }
}
