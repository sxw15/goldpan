import { asc, eq, or, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../connection';
import { categories } from '../schema';
import type { Category, CategoryRepository } from './types';

const MAX_DEPTH = 5;

function normalizePathSegments(rawPath: string): string[] {
  const segments = rawPath
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((seg) => seg.trim().replace(/\s+/g, ' '))
    .filter((seg) => seg.length > 0);
  if (segments.length > MAX_DEPTH) {
    return segments.slice(0, MAX_DEPTH);
  }
  return segments;
}

export class SqliteCategoryRepository implements CategoryRepository {
  constructor(private db: DrizzleDB) {}

  /** Create category path segments, returning the leaf category ID.
   *  IMPORTANT: Caller must ensure this runs inside a transaction to prevent partial paths. */
  ensureCategoryPath(rawPath: string): number {
    const segments = normalizePathSegments(rawPath);
    if (segments.length === 0) {
      throw new Error('Category path must have at least one non-empty segment');
    }

    let parentId: number | null = null;
    let currentPath = '';
    let leafId = -1;

    for (const segment of segments) {
      currentPath += `/${segment}`;

      this.db
        .insert(categories)
        .values({ name: segment, path: currentPath, parentId })
        .onConflictDoNothing({ target: categories.path })
        .run();

      const row = this.db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.path, currentPath))
        .get();

      if (!row) {
        throw new Error(`Failed to find or create category at path: ${currentPath}`);
      }

      parentId = row.id;
      leafId = row.id;
    }

    return leafId;
  }

  getAll(): Category[] {
    return this.db.select().from(categories).orderBy(asc(categories.path)).all();
  }

  getById(id: number): Category | undefined {
    return this.db.select().from(categories).where(eq(categories.id, id)).get();
  }

  getByPath(path: string): Category | undefined {
    return this.db.select().from(categories).where(eq(categories.path, path)).get();
  }

  getChildren(parentId: number): Category[] {
    return this.db
      .select()
      .from(categories)
      .where(eq(categories.parentId, parentId))
      .orderBy(asc(categories.name))
      .all();
  }

  getSubtree(pathPrefix: string): Category[] {
    const escaped = pathPrefix.replace(/[\\%_]/g, '\\$&');
    return this.db
      .select()
      .from(categories)
      .where(
        or(
          eq(categories.path, pathPrefix),
          sql`${categories.path} LIKE ${`${escaped}/%`} ESCAPE '\\'`,
        ),
      )
      .orderBy(asc(categories.path))
      .all();
  }
}
