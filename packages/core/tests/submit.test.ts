import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../src/db/connection.js';
import { sources } from '../src/db/schema.js';
import { type SubmitDeps, submitText } from '../src/submit.js';
import { createTestDB, type TestDB } from './helpers/test-db.js';

describe('submitInput — origin', () => {
  let testDB: TestDB;
  let db: DrizzleDB;
  let deps: SubmitDeps;

  beforeEach(() => {
    testDB = createTestDB();
    db = testDB.db;
    deps = { db, maxTextInputLength: 20000, ssrfValidationEnabled: true };
  });

  afterEach(() => {
    testDB.cleanup();
  });

  it('defaults origin to user', async () => {
    const result = await submitText('test content here for processing', deps);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('expected accepted');
    const source = db.select().from(sources).where(eq(sources.id, result.sourceId)).get();
    expect(source?.origin).toBe('user');
  });

  it('sets origin to tracking when specified', async () => {
    const result = await submitText('test content here for processing', {
      ...deps,
      origin: 'tracking',
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('expected accepted');
    const source = db.select().from(sources).where(eq(sources.id, result.sourceId)).get();
    expect(source?.origin).toBe('tracking');
  });
});
