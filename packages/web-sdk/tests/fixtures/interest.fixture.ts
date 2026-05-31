// packages/web-sdk/tests/fixtures/interest.fixture.ts
//
// Review round B-Te-4: canonical single source of truth for the Interest
// duck-typing contract across THREE sides that each maintain their own TS /
// JSON shape with no compile-time binding:
//
//   1. plugin TS:       plugins/tracking/src/types.ts (Interest)
//   2. server route JSON: apps/server/src/routes/tracking.ts (GET /tracking/rules/*)
//   3. SDK TS:          packages/web-sdk/src/types.ts (Interest)
//
// Field drift on any side compiles cleanly and may not fail any single suite.
// Defense is runtime: each side asserts its actual key-set against the
// `INTEREST_*_KEYS` constants exported here. Adding / removing / renaming a
// field requires updating the fixture AND all three sides — any drift leaves
// at least one key-set assertion failing.
//
// Import paths (kept as relative `./fixtures/...` from each consumer test,
// NOT routed through package.json `exports` so this file never leaks into
// the published bundle):
//   - SDK tests:     ./fixtures/interest.fixture.js
//   - server tests:  ../../../packages/web-sdk/tests/fixtures/interest.fixture.js
//   - plugin tests:  ../../../packages/web-sdk/tests/fixtures/interest.fixture.js
//
// Vitest (esbuild on-the-fly) handles cross-package relative TS imports out
// of the box. The `.js` suffix in import specifiers follows the repo's
// NodeNext convention (TS sources, resolved at runtime).

import type {
  Interest,
  InterestDetail,
  InterestExecution,
  InterestExecutionDetail,
  InterestItem,
  InterestLinkedEntity,
  InterestListItem,
} from '../../src/types.js';

export const interestFixture: Interest = {
  id: 42,
  name: 'AI News',
  description: 'Daily AI updates',
  searchQueries: ['AI', 'LLM'],
  toolProvider: null,
  intervalMinutes: 60,
  enabled: true,
  status: 'idle',
  lastRunAt: null,
  nextRunAt: Date.parse('2026-05-01T00:00:00Z'),
  linkedEntityIds: [10],
  createdAt: Date.parse('2026-04-01T00:00:00Z'),
  updatedAt: Date.parse('2026-04-01T00:00:00Z'),
};

export const interestListItemFixture: InterestListItem = {
  ...interestFixture,
  linkedEntityCount: 1,
  totalHits: 0,
  newHits24h: 0,
  ingestedTotal: 0,
  sparkline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

export const interestExecutionFixture: InterestExecution = {
  id: 1,
  interestId: 42,
  status: 'done',
  itemsFound: 5,
  itemsSubmitted: 2,
  startedAt: Date.parse('2026-04-10T00:00:00Z'),
  finishedAt: Date.parse('2026-04-10T00:05:00Z'),
  errorMessage: null,
};

export const interestLinkedEntityFixture: InterestLinkedEntity = {
  id: 10,
  name: 'LLM Tools',
  categoryPaths: ['Tech/AI'],
};

export const interestDetailFixture: InterestDetail = {
  interest: interestFixture,
  linkedEntities: [interestLinkedEntityFixture],
  recentExecutions: [interestExecutionFixture],
};

/**
 * SDK / server-side shape. The plugin-layer `InterestItem` (see
 * plugins/tracking/src/types.ts) additionally carries `sourceId`; the server
 * route strips it before responding. Plugin tests assert the observed key-set
 * is `INTEREST_ITEM_KEYS ∪ {sourceId}` so the two layers stay aligned.
 */
export const interestItemFixture: InterestItem = {
  id: 1,
  url: 'https://example.com/article',
  title: 'Example',
  snippet: 'snippet',
  publishedAt: null,
  status: 'submitted',
};

export const interestExecutionDetailFixture: InterestExecutionDetail = {
  ...interestExecutionFixture,
  items: [interestItemFixture],
};

// Canonical key sets — three-side shape tests compare their observed keys to these.
export const INTEREST_KEYS: string[] = Object.keys(interestFixture).sort();
export const INTEREST_LIST_ITEM_KEYS: string[] = Object.keys(interestListItemFixture).sort();
export const INTEREST_EXECUTION_KEYS: string[] = Object.keys(interestExecutionFixture).sort();
export const INTEREST_LINKED_ENTITY_KEYS: string[] = Object.keys(
  interestLinkedEntityFixture,
).sort();
export const INTEREST_DETAIL_KEYS: string[] = Object.keys(interestDetailFixture).sort();
export const INTEREST_ITEM_KEYS: string[] = Object.keys(interestItemFixture).sort();
export const INTEREST_EXECUTION_DETAIL_KEYS: string[] = Object.keys(
  interestExecutionDetailFixture,
).sort();
