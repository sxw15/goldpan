import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../connection';
import { dbMetadata } from '../schema';
import type { MetadataRepository } from './types';

export class SqliteMetadataRepository implements MetadataRepository {
  constructor(private db: DrizzleDB) {}

  get(key: string): string | undefined {
    const row = this.db.select().from(dbMetadata).where(eq(dbMetadata.key, key)).get();
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db
      .insert(dbMetadata)
      .values({ key, value })
      .onConflictDoUpdate({ target: dbMetadata.key, set: { value } })
      .run();
  }

  delete(key: string): void {
    this.db.delete(dbMetadata).where(eq(dbMetadata.key, key)).run();
  }
}
