import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectCaptures,
  collectNewEntities,
  collectStats,
  collectThoughts,
  collectTrackingFindings,
} from '../src/modules';
import { makeTestDbWithMetadata, seedDigestFixture } from './fixtures/seed';

const DATE = '2026-04-18';
const RANGE = {
  from: new Date(`${DATE}T00:00:00Z`).getTime(),
  to: new Date(`${DATE}T23:59:59.999Z`).getTime(),
};

describe('digest modules', () => {
  let db: ReturnType<typeof makeTestDbWithMetadata>['db'];
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTestDbWithMetadata();
    db = t.db;
    cleanup = t.cleanup;
  });
  afterEach(() => cleanup());

  it('tracking_findings returns items + hasMore hard-cap', () => {
    seedDigestFixture(db, { dateISO: DATE, findings: 15 });
    const mod = collectTrackingFindings(db, RANGE, 10);
    expect(mod.type).toBe('tracking_findings');
    expect(mod.items).toHaveLength(10);
    expect(mod.hasMore).toBe(true);
    expect(mod.hiddenCount).toBe(5);
  });

  it('captures returns items + hasMore=false when below cap', () => {
    seedDigestFixture(db, { dateISO: DATE, captures: 3 });
    const mod = collectCaptures(db, RANGE, 10);
    expect(mod.type).toBe('captures');
    expect(mod.items).toHaveLength(3);
    expect(mod.hasMore).toBe(false);
    expect(mod.hiddenCount).toBe(0);
  });

  it('thoughts respects cap', () => {
    seedDigestFixture(db, { dateISO: DATE, thoughts: 12 });
    const mod = collectThoughts(db, RANGE, 5);
    expect(mod.type).toBe('thoughts');
    expect(mod.items).toHaveLength(5);
    expect(mod.hasMore).toBe(true);
    expect(mod.hiddenCount).toBe(7);
  });

  it('new_entities respects cap', () => {
    seedDigestFixture(db, { dateISO: DATE, entities: 7 });
    const mod = collectNewEntities(db, RANGE, 10);
    expect(mod.type).toBe('new_entities');
    expect(mod.items).toHaveLength(7);
    expect(mod.hasMore).toBe(false);
    expect(mod.hiddenCount).toBe(0);
  });

  it('stats returns counts across 4 tables', () => {
    seedDigestFixture(db, {
      dateISO: DATE,
      captures: 2,
      findings: 3,
      thoughts: 1,
      entities: 4,
    });
    const stats = collectStats(db, RANGE);
    expect(stats).toEqual({
      type: 'stats',
      captures: 2,
      findings: 3,
      thoughts: 1,
      entities: 4,
    });
  });
});
