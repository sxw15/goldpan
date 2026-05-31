import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteCategoryRepository } from '../../../src/db/repositories/category.repository.js';
import { createTestDB, type TestDB } from '../../helpers/test-db.js';

describe('CategoryRepository', () => {
  let t: TestDB;
  let repo: SqliteCategoryRepository;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteCategoryRepository(t.db);
  });

  afterEach(() => {
    t.cleanup();
  });

  describe('ensureCategoryPath', () => {
    it('creates full path from scratch', () => {
      const leafId = repo.ensureCategoryPath('Tech/AI/Tools');
      expect(leafId).toBeGreaterThan(0);
      const all = repo.getAll();
      expect(all).toHaveLength(3);
      expect(all.map((c) => c.path)).toEqual(['/Tech', '/Tech/AI', '/Tech/AI/Tools']);
    });

    it('is idempotent — returns same leaf ID', () => {
      const id1 = repo.ensureCategoryPath('Tech/AI/Tools');
      const id2 = repo.ensureCategoryPath('Tech/AI/Tools');
      expect(id1).toBe(id2);
      const all = repo.getAll();
      expect(all).toHaveLength(3);
    });

    it('reuses existing prefix', () => {
      repo.ensureCategoryPath('Tech/AI');
      repo.ensureCategoryPath('Tech/AI/Tools');
      const all = repo.getAll();
      expect(all).toHaveLength(3);
    });

    it('handles leading slash in input', () => {
      const id = repo.ensureCategoryPath('/Tech/AI');
      expect(id).toBeGreaterThan(0);
      const cat = repo.getByPath('/Tech/AI');
      expect(cat).toBeDefined();
    });

    it('handles trailing slash', () => {
      const id = repo.ensureCategoryPath('Tech/AI/');
      const cat = repo.getByPath('/Tech/AI');
      expect(cat).toBeDefined();
      expect(cat?.id).toBe(id);
    });

    it('normalizes whitespace in segments', () => {
      const id = repo.ensureCategoryPath('  Tech  /  AI  /  Tools  ');
      const cat = repo.getByPath('/Tech/AI/Tools');
      expect(cat).toBeDefined();
      expect(cat?.id).toBe(id);
    });

    it('filters empty segments', () => {
      const _id = repo.ensureCategoryPath('Tech//AI///Tools');
      const all = repo.getAll();
      expect(all).toHaveLength(3);
    });

    it('truncates path exceeding max depth 5 (silently)', () => {
      const _id = repo.ensureCategoryPath('a/b/c/d/e/f/g');
      // Should create exactly 5 segments (truncated from 7)
      const all = repo.getAll();
      expect(all).toHaveLength(5);
    });

    it('throws on empty path', () => {
      expect(() => repo.ensureCategoryPath('')).toThrow();
      expect(() => repo.ensureCategoryPath('   ')).toThrow();
      expect(() => repo.ensureCategoryPath('/')).toThrow();
    });
  });

  describe('getAll', () => {
    it('returns categories ordered by path', () => {
      repo.ensureCategoryPath('Finance/Stocks');
      repo.ensureCategoryPath('Tech/AI');
      const all = repo.getAll();
      const paths = all.map((c) => c.path);
      expect(paths).toEqual(['/Finance', '/Finance/Stocks', '/Tech', '/Tech/AI']);
    });
  });

  describe('getChildren', () => {
    it('returns direct children', () => {
      repo.ensureCategoryPath('Tech/AI/Tools');
      repo.ensureCategoryPath('Tech/AI/Models');
      repo.ensureCategoryPath('Tech/Web');
      const root = repo.getByPath('/Tech')!;
      const children = repo.getChildren(root.id);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.name).sort()).toEqual(['AI', 'Web']);
    });
  });

  describe('getSubtree', () => {
    it('returns all descendants under a path prefix', () => {
      repo.ensureCategoryPath('Tech/AI/Tools');
      repo.ensureCategoryPath('Tech/AI/Models');
      repo.ensureCategoryPath('Tech/Web');
      const subtree = repo.getSubtree('/Tech/AI');
      expect(subtree).toHaveLength(3);
    });

    it('does not match sibling with same prefix', () => {
      repo.ensureCategoryPath('Tech/AI');
      repo.ensureCategoryPath('Tech/AI Frontier');
      const subtree = repo.getSubtree('/Tech/AI');
      expect(subtree).toHaveLength(1);
      expect(subtree[0].path).toBe('/Tech/AI');
    });
  });
});
