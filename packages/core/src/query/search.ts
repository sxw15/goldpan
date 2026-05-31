import type Database from 'better-sqlite3';
import type { DrizzleDB } from '../db/connection';
import { getRawDatabase } from '../db/connection';
import { parseJsonStringArray } from '../db/json-columns';
import type { Language } from '../i18n/types';
import type { QueryUnderstanding } from './schema';

// ─── Types ──────────────────────────────────────────────────

export interface SearchResultPoint {
  id: number;
  content: string;
  type: 'fact' | 'opinion';
}

export interface SearchResultEntity {
  id: number;
  name: string;
  description: string | null;
  aliases: string[];
  keywords: string[];
  categoryPaths: string[];
  /** Most recent source date for this entity, for temporal ranking */
  lastSourceDate: string | null;
  points: SearchResultPoint[];
  /** Which search strategies matched this entity */
  matchedBy: (
    | 'fts'
    | 'vec'
    | 'time'
    | 'category'
    | 'keyword_json'
    | 'relation'
    | 'source_fts'
    | 'note_fts'
  )[];
}

export interface SearchResult {
  readonly entities: readonly SearchResultEntity[];
}

// ─── Constants ──────────────────────────────────────────────

const MAX_ENTITIES = 20;
const MAX_POINTS_PER_ENTITY = 10;

// ─── Helpers ────────────────────────────────────────────────

/** Escape FTS5 special characters for safe MATCH queries. */
function escapeFts5(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** Escape LIKE pattern special characters (\, % and _). */
function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
}

// ─── Search strategies ──────────────────────────────────────

/**
 * Per-entity FTS sub-source tags. Each entity can be hit by multiple FTS5
 * virtual tables (entity name vs. its knowledge_points content vs. its
 * source raw_content vs. linked note content) — we track which ones fired
 * so the final `matchedBy` array can surface them individually.
 */
type FtsSubSource = 'entities_fts' | 'kp_fts' | 'source_fts' | 'note_fts';

interface FtsResult {
  entityIds: Set<number>;
  /** Best (most negative = most relevant) FTS5 rank per entity. */
  scores: Map<number, number>;
  /** Which FTS sub-sources contributed to each entity (P2). */
  subSources: Map<number, Set<FtsSubSource>>;
}

function searchByFts(raw: Database.Database, keywords: string[], language: Language): FtsResult {
  const entityIds = new Set<number>();
  const scores = new Map<number, number>();
  const subSources = new Map<number, Set<FtsSubSource>>();

  if (keywords.length === 0) return { entityIds, scores, subSources };

  const validKeywords = keywords.filter((k) => k.trim().length > 0);
  if (validKeywords.length === 0) return { entityIds, scores, subSources };

  // Ranks from entities_fts and knowledge_points_fts use different column
  // structures, so absolute bm25 values aren't directly comparable across
  // tables. We keep the best (most negative) rank per entity as a rough
  // relevance signal; the primary sort key is strategy count, not score.
  // `source` lets the final `matchedBy` distinguish which FTS path matched.
  function trackScore(entityId: number, rank: number, source: FtsSubSource) {
    entityIds.add(entityId);
    const prev = scores.get(entityId);
    if (prev === undefined || rank < prev) {
      scores.set(entityId, rank);
    }
    const set = subSources.get(entityId) ?? new Set<FtsSubSource>();
    set.add(source);
    subSources.set(entityId, set);
  }

  // For trigram tokenizer (zh), keywords shorter than 3 characters can't match
  // any trigram. Split into FTS-eligible and LIKE-fallback lists.
  const isTrigram = language === 'zh';
  const ftsKeywords = isTrigram ? validKeywords.filter((k) => k.length >= 3) : validKeywords;
  const likeKeywords = isTrigram ? validKeywords.filter((k) => k.length < 3) : [];

  // FTS5 MATCH search (with bm25 rank)
  if (ftsKeywords.length > 0) {
    const ftsQuery = ftsKeywords.map(escapeFts5).join(' OR ');

    const entityRows = raw
      .prepare(
        'SELECT rowid, rank FROM entities_fts WHERE entities_fts MATCH ? ORDER BY rank LIMIT 50',
      )
      .all(ftsQuery) as Array<{ rowid: number; rank: number }>;
    for (const row of entityRows) {
      trackScore(row.rowid, row.rank, 'entities_fts');
    }

    const pointRows = raw
      .prepare(
        'SELECT rowid, rank FROM knowledge_points_fts WHERE knowledge_points_fts MATCH ? ORDER BY rank LIMIT 100',
      )
      .all(ftsQuery) as Array<{ rowid: number; rank: number }>;

    if (pointRows.length > 0) {
      const pointScoreMap = new Map<number, number>();
      for (const r of pointRows) {
        pointScoreMap.set(r.rowid, r.rank);
      }
      const pointIds = pointRows.map((r) => r.rowid);
      const placeholders = pointIds.map(() => '?').join(',');
      const sepRows = raw
        .prepare(
          `SELECT DISTINCT entity_id, point_id FROM source_entity_points WHERE point_id IN (${placeholders}) LIMIT 50`,
        )
        .all(...pointIds) as Array<{ entity_id: number; point_id: number }>;

      for (const row of sepRows) {
        const pointRank = pointScoreMap.get(row.point_id) ?? 0;
        trackScore(row.entity_id, pointRank, 'kp_fts');
      }
    }

    // ─── P2: sources_fts → 投影回 entity ─────────────────────
    // Source-level full-text hits (title + raw_content) are projected back
    // to entities via source_entity_points. The trigger only indexes
    // confirmed / confirmed_empty sources, so no explicit status filter here.
    const sourceRows = raw
      .prepare(
        'SELECT rowid, rank FROM sources_fts WHERE sources_fts MATCH ? ORDER BY rank LIMIT 50',
      )
      .all(ftsQuery) as Array<{ rowid: number; rank: number }>;

    if (sourceRows.length > 0) {
      const sourceRankMap = new Map<number, number>();
      for (const r of sourceRows) {
        sourceRankMap.set(r.rowid, r.rank);
      }
      const sourceIds = sourceRows.map((r) => r.rowid);
      const placeholders = sourceIds.map(() => '?').join(',');
      const sepRows = raw
        .prepare(
          `SELECT DISTINCT entity_id, source_id FROM source_entity_points WHERE source_id IN (${placeholders}) LIMIT 50`,
        )
        .all(...sourceIds) as Array<{ entity_id: number; source_id: number }>;

      for (const row of sepRows) {
        const srcRank = sourceRankMap.get(row.source_id) ?? 0;
        trackScore(row.entity_id, srcRank, 'source_fts');
      }
    }

    // ─── P2: notes_fts → 投影回 entity ────────────────────────
    // User-note full-text hits projected via note_entities. The trigger only
    // indexes archived=0 notes, so archived notes never reach this branch.
    const noteRows = raw
      .prepare('SELECT rowid, rank FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT 50')
      .all(ftsQuery) as Array<{ rowid: number; rank: number }>;

    if (noteRows.length > 0) {
      const noteRankMap = new Map<number, number>();
      for (const r of noteRows) {
        noteRankMap.set(r.rowid, r.rank);
      }
      const noteIds = noteRows.map((r) => r.rowid);
      const placeholders = noteIds.map(() => '?').join(',');
      const neRows = raw
        .prepare(
          `SELECT note_id, entity_id FROM note_entities WHERE note_id IN (${placeholders}) LIMIT 50`,
        )
        .all(...noteIds) as Array<{ note_id: number; entity_id: number }>;

      for (const row of neRows) {
        const nRank = noteRankMap.get(row.note_id) ?? 0;
        trackScore(row.entity_id, nRank, 'note_fts');
      }
    }
  }

  // LIKE fallback for short keywords that can't use trigram FTS.
  // No rank available — these entities get default score 0 in the final sort,
  // placing them after FTS-matched entities (which have negative bm25 scores).
  if (likeKeywords.length > 0) {
    const conditions = likeKeywords.map(
      () =>
        "(name LIKE ? ESCAPE '\\' OR COALESCE(description, '') LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\')",
    );
    const params = likeKeywords.flatMap((k) => {
      const pattern = `%${escapeLike(k)}%`;
      return [pattern, pattern, pattern];
    });

    const rows = raw
      .prepare(`SELECT id FROM entities WHERE ${conditions.join(' OR ')} LIMIT 50`)
      .all(...params) as Array<{ id: number }>;
    for (const row of rows) {
      entityIds.add(row.id);
    }

    const kpConditions = likeKeywords.map(() => "kp.content LIKE ? ESCAPE '\\'");
    const kpParams = likeKeywords.map((k) => `%${escapeLike(k)}%`);
    const kpRows = raw
      .prepare(
        `SELECT DISTINCT sep.entity_id FROM knowledge_points kp
         JOIN source_entity_points sep ON sep.point_id = kp.id
         WHERE kp.status = 'active' AND (${kpConditions.join(' OR ')}) LIMIT 50`,
      )
      .all(...kpParams) as Array<{ entity_id: number }>;
    for (const row of kpRows) {
      entityIds.add(row.entity_id);
    }

    const sourceConditions = likeKeywords.map(
      () =>
        "(COALESCE(s.title, '') LIKE ? ESCAPE '\\' OR COALESCE(s.raw_content, '') LIKE ? ESCAPE '\\')",
    );
    const sourceParams = likeKeywords.flatMap((k) => {
      const pattern = `%${escapeLike(k)}%`;
      return [pattern, pattern];
    });
    const sourceRows = raw
      .prepare(
        `SELECT DISTINCT sep.entity_id
         FROM sources s
         JOIN source_entity_points sep ON sep.source_id = s.id
         WHERE s.status IN ('confirmed', 'confirmed_empty')
           AND (${sourceConditions.join(' OR ')}) LIMIT 50`,
      )
      .all(...sourceParams) as Array<{ entity_id: number }>;
    for (const row of sourceRows) {
      trackScore(row.entity_id, 0, 'source_fts');
    }

    const noteConditions = likeKeywords.map(
      () =>
        "(n.content LIKE ? ESCAPE '\\' OR COALESCE(n.content_translated, '') LIKE ? ESCAPE '\\')",
    );
    const noteParams = likeKeywords.flatMap((k) => {
      const pattern = `%${escapeLike(k)}%`;
      return [pattern, pattern];
    });
    const noteRows = raw
      .prepare(
        `SELECT DISTINCT ne.entity_id
         FROM notes n
         JOIN note_entities ne ON ne.note_id = n.id
         WHERE n.archived = 0
           AND (${noteConditions.join(' OR ')}) LIMIT 50`,
      )
      .all(...noteParams) as Array<{ entity_id: number }>;
    for (const row of noteRows) {
      trackScore(row.entity_id, 0, 'note_fts');
    }
  }

  return { entityIds, scores, subSources };
}

function searchByTime(
  raw: Database.Database,
  sourceKind: 'external' | 'user' | 'any',
  limit: number = MAX_ENTITIES,
): Set<number> {
  const entityIds = new Set<number>();

  let sourceFilter = "s.status = 'confirmed'";
  const params: string[] = [];

  if (sourceKind !== 'any') {
    sourceFilter += ' AND s.kind = ?';
    params.push(sourceKind);
  }

  const query = `
    SELECT sep.entity_id
    FROM source_entity_points sep
    JOIN sources s ON s.id = sep.source_id
    WHERE ${sourceFilter}
    GROUP BY sep.entity_id
    ORDER BY MAX(s.created_at) DESC
    LIMIT ${limit}
  `;

  const rows = raw.prepare(query).all(...params) as Array<{ entity_id: number }>;
  for (const row of rows) {
    entityIds.add(row.entity_id);
  }

  return entityIds;
}

function searchByCategory(raw: Database.Database, categoryHints: string[]): Set<number> {
  const entityIds = new Set<number>();

  const validHints = categoryHints.filter((h) => h.trim().length > 0);
  if (validHints.length === 0) return entityIds;

  // Find matching categories
  const conditions = validHints.map(
    () => "(c.name LIKE ? ESCAPE '\\' OR c.path LIKE ? ESCAPE '\\')",
  );
  const params = validHints.flatMap((h) => {
    const escaped = `%${escapeLike(h)}%`;
    return [escaped, escaped];
  });

  const rows = raw
    .prepare(
      `
      SELECT DISTINCT ec.entity_id
      FROM categories c
      JOIN entity_categories ec ON ec.category_id = c.id
      WHERE ${conditions.join(' OR ')}
      LIMIT 50
    `,
    )
    .all(...params) as Array<{ entity_id: number }>;

  for (const row of rows) {
    entityIds.add(row.entity_id);
  }

  return entityIds;
}

function searchByKeywordJson(raw: Database.Database, keywords: string[]): Set<number> {
  const entityIds = new Set<number>();

  const validKeywords = keywords.filter((k) => k.trim().length > 0);
  if (validKeywords.length === 0) return entityIds;

  // Use json_each to search within the JSON keywords array
  const conditions = validKeywords.map(() => "je.value LIKE ? ESCAPE '\\'");
  const params = validKeywords.map((k) => `%${escapeLike(k)}%`);

  const rows = raw
    .prepare(
      `
      SELECT DISTINCT e.id
      FROM entities e, json_each(e.keywords) je
      WHERE ${conditions.join(' OR ')}
      LIMIT 50
    `,
    )
    .all(...params) as Array<{ id: number }>;

  for (const row of rows) {
    entityIds.add(row.id);
  }

  return entityIds;
}

// ─── Vector search ──────────────────────────────────────────

interface VecResult {
  entityIds: Set<number>;
  ranks: Map<number, number>;
}

function searchByVec(raw: Database.Database, queryEmbedding: number[]): VecResult {
  const entityIds = new Set<number>();
  const ranks = new Map<number, number>();

  const entityRows = raw
    .prepare(
      'SELECT rowid, distance FROM entities_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 50',
    )
    .all(new Float32Array(queryEmbedding)) as Array<{ rowid: number; distance: number }>;

  let rank = 1;
  for (const row of entityRows) {
    entityIds.add(row.rowid);
    ranks.set(row.rowid, rank++);
  }

  const pointRows = raw
    .prepare(
      'SELECT rowid, distance FROM knowledge_points_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 100',
    )
    .all(new Float32Array(queryEmbedding)) as Array<{ rowid: number; distance: number }>;

  if (pointRows.length > 0) {
    const pointIds = pointRows.map((r) => r.rowid);
    const placeholders = pointIds.map(() => '?').join(',');

    const activeIds = new Set(
      (
        raw
          .prepare(
            `SELECT id FROM knowledge_points WHERE id IN (${placeholders}) AND status = 'active'`,
          )
          .all(...pointIds) as Array<{ id: number }>
      ).map((r) => r.id),
    );
    const activePointRows = pointRows.filter((r) => activeIds.has(r.rowid));

    if (activePointRows.length === 0) {
      return { entityIds, ranks };
    }

    const activePlaceholders = activePointRows.map(() => '?').join(',');
    const sepRows = raw
      .prepare(
        `SELECT DISTINCT entity_id, point_id FROM source_entity_points WHERE point_id IN (${activePlaceholders}) LIMIT 50`,
      )
      .all(...activePointRows.map((r) => r.rowid)) as Array<{
      entity_id: number;
      point_id: number;
    }>;

    const pointRankMap = new Map(activePointRows.map((r, i) => [r.rowid, i + 1]));
    for (const row of sepRows) {
      const pointRank = pointRankMap.get(row.point_id) ?? 999;
      entityIds.add(row.entity_id);
      const prev = ranks.get(row.entity_id);
      if (prev === undefined || pointRank < prev) {
        ranks.set(row.entity_id, pointRank);
      }
    }
  }

  return { entityIds, ranks };
}

// ─── RRF scoring ─────────────────────────────────────────────

const RRF_K = 60;

function computeRrfScore(
  entityId: number,
  ftsRanks: Map<number, number>,
  vecRanks: Map<number, number>,
): number {
  let score = 0;
  const ftsRank = ftsRanks.get(entityId);
  if (ftsRank !== undefined) score += 1 / (RRF_K + ftsRank);
  const vecRank = vecRanks.get(entityId);
  if (vecRank !== undefined) score += 1 / (RRF_K + vecRank);
  return score;
}

// ─── Hydration ──────────────────────────────────────────────

interface RawEntity {
  id: number;
  name: string;
  description: string | null;
  aliases: string;
  keywords: string;
}

function hydrateEntities(
  raw: Database.Database,
  allEntityIds: Set<number>,
  matchedByMap: Map<number, Set<SearchStrategy>>,
  pointType: 'fact' | 'opinion' | 'any',
  maxEntities: number = MAX_ENTITIES,
): SearchResultEntity[] {
  if (allEntityIds.size === 0) return [];

  const ids = [...allEntityIds].slice(0, maxEntities);
  const placeholders = ids.map(() => '?').join(',');

  // Load entities
  const entities = raw
    .prepare(
      `SELECT id, name, description, aliases, keywords FROM entities WHERE id IN (${placeholders})`,
    )
    .all(...ids) as RawEntity[];

  // Load category paths per entity
  const categoryRows = raw
    .prepare(
      `
      SELECT ec.entity_id, c.path
      FROM entity_categories ec
      JOIN categories c ON c.id = ec.category_id
      WHERE ec.entity_id IN (${placeholders})
    `,
    )
    .all(...ids) as Array<{ entity_id: number; path: string }>;

  const categoryMap = new Map<number, string[]>();
  for (const row of categoryRows) {
    const paths = categoryMap.get(row.entity_id) ?? [];
    paths.push(row.path);
    categoryMap.set(row.entity_id, paths);
  }

  // Load active points per entity, using window function to guarantee each entity
  // gets a fair share of points (prevents a single entity with many points from
  // crowding out others).
  let typeFilter = '';
  const pointParams: (number | string)[] = [...ids];

  if (pointType !== 'any') {
    typeFilter = 'AND kp.type = ?';
    pointParams.push(pointType);
  }

  const pointQuery = `
    SELECT entity_id, id, content, type FROM (
      SELECT entity_id, id, content, type,
             ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY id DESC) AS rn
      FROM (
        SELECT DISTINCT sep.entity_id, kp.id, kp.content, kp.type
        FROM source_entity_points sep
        JOIN knowledge_points kp ON kp.id = sep.point_id
        WHERE sep.entity_id IN (${placeholders})
          AND kp.status = 'active'
          ${typeFilter}
      )
    ) WHERE rn <= ${MAX_POINTS_PER_ENTITY}
  `;

  const pointRows = raw.prepare(pointQuery).all(...pointParams) as Array<{
    entity_id: number;
    id: number;
    content: string;
    type: string;
  }>;

  const pointMap = new Map<number, SearchResultPoint[]>();
  for (const row of pointRows) {
    const points = pointMap.get(row.entity_id) ?? [];
    points.push({
      id: row.id,
      content: row.content,
      type: row.type as 'fact' | 'opinion',
    });
    pointMap.set(row.entity_id, points);
  }

  // Load last source date per entity
  const sourceDateRows = raw
    .prepare(
      `
      SELECT sep.entity_id, MAX(s.created_at) AS last_date
      FROM source_entity_points sep
      JOIN sources s ON s.id = sep.source_id
      WHERE sep.entity_id IN (${placeholders})
        AND s.status = 'confirmed'
      GROUP BY sep.entity_id
    `,
    )
    .all(...ids) as Array<{ entity_id: number; last_date: string | null }>;

  const sourceDateMap = new Map<number, string | null>();
  for (const row of sourceDateRows) {
    sourceDateMap.set(row.entity_id, row.last_date);
  }

  return entities
    .map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      aliases: parseJsonStringArray(e.aliases),
      keywords: parseJsonStringArray(e.keywords),
      categoryPaths: categoryMap.get(e.id) ?? [],
      lastSourceDate: sourceDateMap.get(e.id) ?? null,
      points: pointMap.get(e.id) ?? [],
      matchedBy: [...(matchedByMap.get(e.id) ?? [])],
    }))
    .filter((e) => e.points.length > 0);
}

// ─── Main search function ───────────────────────────────────

type SearchStrategy = SearchResultEntity['matchedBy'][number];

export interface SearchOptions {
  embeddingProvider?: import('../embedding/types').EmbeddingProvider | null;
  rawQuery?: string;
  maxEntities?: number;
  emphasizeTime?: boolean;
}

export async function searchKnowledge(
  params: QueryUnderstanding,
  db: DrizzleDB,
  language: Language = 'en',
  options?: SearchOptions,
): Promise<SearchResult> {
  const raw = getRawDatabase(db);
  const effectiveMaxEntities = options?.maxEntities ?? MAX_ENTITIES;
  const allEntityIds = new Set<number>();
  const matchedByMap = new Map<number, Set<SearchStrategy>>();
  const ftsScoreMap = new Map<number, number>();

  function addIds(ids: Set<number>, strategy: SearchStrategy) {
    for (const id of ids) {
      allEntityIds.add(id);
      const strategies = matchedByMap.get(id) ?? new Set();
      strategies.add(strategy);
      matchedByMap.set(id, strategies);
    }
  }

  // Strategy 1: FTS5 text search (with bm25 ranking)
  if (params.keywords.length > 0) {
    const ftsResult = searchByFts(raw, params.keywords, language);
    addIds(ftsResult.entityIds, 'fts');
    for (const [entityId, score] of ftsResult.scores) {
      ftsScoreMap.set(entityId, score);
    }
    // P2: surface sub-source tags so callers see whether the hit came from
    // the entity row itself, a related knowledge_point, a linked source's
    // raw_content, or a user note linked via note_entities.
    for (const [entityId, subs] of ftsResult.subSources) {
      if (subs.has('source_fts')) addIds(new Set([entityId]), 'source_fts');
      if (subs.has('note_fts')) addIds(new Set([entityId]), 'note_fts');
    }
  }

  // Strategy 2: Time-based recency search
  if (params.hasTimeHint) {
    const entityIds = searchByTime(raw, params.sourceKind, effectiveMaxEntities);
    addIds(entityIds, 'time');
  }

  // Strategy 3: Category path search
  if (params.categoryHints.length > 0) {
    const entityIds = searchByCategory(raw, params.categoryHints);
    addIds(entityIds, 'category');
  }

  // Strategy 4: JSON keyword search (supplementary to FTS)
  if (params.keywords.length > 0) {
    const entityIds = searchByKeywordJson(raw, params.keywords);
    addIds(entityIds, 'keyword_json');
  }

  // Strategy 5: Vector search (when embedding is available)
  let vecRanks = new Map<number, number>();
  const embeddingProvider = options?.embeddingProvider;
  const rawQuery = options?.rawQuery;
  if (embeddingProvider && rawQuery) {
    try {
      const queryEmbedding = await embeddingProvider.embed(rawQuery);
      const vecResult = searchByVec(raw, queryEmbedding);
      addIds(vecResult.entityIds, 'vec');
      vecRanks = vecResult.ranks;
    } catch (err) {
      // Vec search failed — degrade gracefully to FTS-only
      if (typeof process !== 'undefined') {
        console.debug('[search] Vec search failed, falling back to FTS-only', err);
      }
    }
  }

  // Sorting helper: boost time-matched entities when emphasizeTime is set
  const timeBonus = (id: number) =>
    options?.emphasizeTime && matchedByMap.get(id)?.has('time') ? 1 : 0;

  // Sort: RRF when vec search produced results, legacy when not
  if (vecRanks.size > 0) {
    const ftsRanks = new Map<number, number>();
    const sortedFts = [...ftsScoreMap.entries()].sort((a, b) => a[1] - b[1]);
    sortedFts.forEach(([entityId], index) => {
      ftsRanks.set(entityId, index + 1);
    });

    const rankedIds = [...allEntityIds].sort((a, b) => {
      const rrfA = computeRrfScore(a, ftsRanks, vecRanks);
      const rrfB = computeRrfScore(b, ftsRanks, vecRanks);
      if (rrfA !== rrfB) return rrfB - rrfA;
      const stratA = (matchedByMap.get(a)?.size ?? 0) + timeBonus(a);
      const stratB = (matchedByMap.get(b)?.size ?? 0) + timeBonus(b);
      if (stratA !== stratB) return stratB - stratA;
      return a - b;
    });
    const topIds = new Set(rankedIds.slice(0, effectiveMaxEntities));
    const resultEntities = hydrateEntities(
      raw,
      topIds,
      matchedByMap,
      params.pointType,
      effectiveMaxEntities,
    );
    resultEntities.sort((a, b) => {
      const rrfA = computeRrfScore(a.id, ftsRanks, vecRanks);
      const rrfB = computeRrfScore(b.id, ftsRanks, vecRanks);
      if (rrfA !== rrfB) return rrfB - rrfA;
      const stratA = (matchedByMap.get(a.id)?.size ?? 0) + timeBonus(a.id);
      const stratB = (matchedByMap.get(b.id)?.size ?? 0) + timeBonus(b.id);
      const stratDiff = stratB - stratA;
      if (stratDiff !== 0) return stratDiff;
      return a.id - b.id;
    });
    return { entities: resultEntities };
  }

  // Legacy sort (embedding not enabled)
  const rankedIds = [...allEntityIds].sort((a, b) => {
    const stratA = (matchedByMap.get(a)?.size ?? 0) + timeBonus(a);
    const stratB = (matchedByMap.get(b)?.size ?? 0) + timeBonus(b);
    if (stratA !== stratB) return stratB - stratA;
    const scoreA = ftsScoreMap.get(a) ?? 0;
    const scoreB = ftsScoreMap.get(b) ?? 0;
    if (scoreA !== scoreB) return scoreA - scoreB;
    return a - b;
  });
  const topIds = new Set(rankedIds.slice(0, effectiveMaxEntities));

  const entities = hydrateEntities(
    raw,
    topIds,
    matchedByMap,
    params.pointType,
    effectiveMaxEntities,
  );

  entities.sort((a, b) => {
    const stratA = (matchedByMap.get(a.id)?.size ?? 0) + timeBonus(a.id);
    const stratB = (matchedByMap.get(b.id)?.size ?? 0) + timeBonus(b.id);
    const strategyDiff = stratB - stratA;
    if (strategyDiff !== 0) return strategyDiff;
    const scoreA = ftsScoreMap.get(a.id) ?? 0;
    const scoreB = ftsScoreMap.get(b.id) ?? 0;
    if (scoreA !== scoreB) return scoreA - scoreB;
    return a.id - b.id;
  });

  return { entities };
}
