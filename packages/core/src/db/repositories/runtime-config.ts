import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../connection';
import { runtimeConfigOverrides } from '../schema';
import type { RuntimeConfigOverrideRepository } from './types';

export class SqliteRuntimeConfigOverrideRepository implements RuntimeConfigOverrideRepository {
  constructor(private readonly db: DrizzleDB) {}

  list(): Map<string, string> {
    const rows = this.db.select().from(runtimeConfigOverrides).all();
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.key, row.value);
    return map;
  }

  upsert(key: string, value: string): void {
    this.db
      .insert(runtimeConfigOverrides)
      .values({ key, value })
      .onConflictDoUpdate({
        target: runtimeConfigOverrides.key,
        set: { value },
      })
      .run();
  }

  remove(key: string): void {
    this.db.delete(runtimeConfigOverrides).where(eq(runtimeConfigOverrides.key, key)).run();
  }

  applyPatch(patch: ReadonlyMap<string, string | null>): void {
    // Single drizzle txn — without this, a partial commit could leave DB and
    // process.env out of sync if the second statement fails.
    this.db.transaction((tx) => {
      for (const [key, value] of patch) {
        if (value === null) {
          tx.delete(runtimeConfigOverrides).where(eq(runtimeConfigOverrides.key, key)).run();
        } else {
          tx.insert(runtimeConfigOverrides)
            .values({ key, value })
            .onConflictDoUpdate({
              target: runtimeConfigOverrides.key,
              set: { value },
            })
            .run();
        }
      }
    });
  }
}
