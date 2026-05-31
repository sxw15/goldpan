// packages/web-sdk/tests/fixtures/sources.fixture.ts
//
// Three-side drift contract for GET /sources (mirrors interest.fixture.ts):
//   1. core repo TS:    packages/core/src/db/repositories/types.ts (SourceListItem)
//   2. server route:    apps/server/src/routes/sources.ts (respond shape)
//   3. SDK TS:          packages/web-sdk/src/types.ts (SourceListItem / SourceListResponse)
//
// Field rename / addition / removal on any side compiles cleanly. Defense is
// runtime: each consumer asserts its observed key-set against the *_KEYS
// constants exported here.
//
// Imports stay relative (./fixtures/...) — never routed through package.json
// `exports`, so this fixture never leaks into the published bundle.

import type { SourceListItem, SourceListResponse, SourceStatusCounts } from '../../src/types.js';

// `satisfies Required<...>` instead of a plain `: SourceListItem` annotation:
// `Required<T>` strips `?` so adding ANY new field to the type (required OR
// optional) forces this fixture to declare it. Object.keys() then reflects the
// new field, and the locked drift contracts in *.test.ts fail loudly until
// updated. A plain annotation would silently accept missing optional fields
// and let drift slip through.
export const sourceListItemFixture = {
  id: 7,
  kind: 'external',
  originalUrl: 'https://example.com/article-7',
  normalizedUrl: 'https://example.com/article-7',
  title: 'Example Article 7',
  status: 'confirmed',
  origin: 'user',
  createdAt: Date.parse('2026-04-22T00:00:00Z'),
  kpCount: 12,
  entityCount: 3,
  topEntities: [
    { id: 1, name: 'Anthropic' },
    { id: 2, name: 'Claude' },
    { id: 3, name: 'Pricing' },
  ],
  entityCategoryPaths: ['/Tech/AI', '/Business'],
  preview: null,
} satisfies Required<SourceListItem>;

export const sourceStatusCountsFixture = {
  processing: 1,
  confirmed: 5,
  confirmed_empty: 2,
  failed: 1,
  discarded: 0,
} satisfies Required<SourceStatusCounts>;

export const sourceListResponseFixture = {
  data: [sourceListItemFixture],
  total: 1,
  counts: sourceStatusCountsFixture,
} satisfies Required<SourceListResponse>;

export const SOURCE_LIST_ITEM_KEYS: string[] = Object.keys(sourceListItemFixture).sort();
export const SOURCE_STATUS_COUNTS_KEYS: string[] = Object.keys(sourceStatusCountsFixture).sort();
export const SOURCE_LIST_RESPONSE_KEYS: string[] = Object.keys(sourceListResponseFixture).sort();
