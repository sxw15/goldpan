import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validatePipelineOutput } from '../../../src/pipeline/steps/validate-output.js';
import type { EntityJudgment, IndexedPoint, RelationOutput } from '../../../src/pipeline/types.js';
import {
  createMockKnowledgeRepo,
  createTestContext,
  createTestEntity,
  createTestIndexedPoints,
  resetIdSequences,
} from '../fixtures/index.js';

vi.mock('../../../src/db/connection.js', () => ({
  getRawDatabase: vi.fn(),
}));

describe('validatePipelineOutput', () => {
  let knowledgeRepo: ReturnType<typeof createMockKnowledgeRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdSequences();
    knowledgeRepo = createMockKnowledgeRepo();
  });

  function makePoints(): IndexedPoint[] {
    return [
      { pointKey: 'kp:0', content: 'Fact 0', type: 'fact' },
      { pointKey: 'kp:1', content: 'Fact 1', type: 'fact' },
      { pointKey: 'kp:2', content: 'Opinion 2', type: 'opinion' },
    ];
  }

  function makeEntityJudgments(overrides: Partial<EntityJudgment> = {}): EntityJudgment[] {
    return [
      {
        entityKey: 'entity:1',
        entityName: 'E1',
        resolvedCategoryPath: 'Tech/AI',
        knowledgePointKeys: ['kp:0', 'kp:1', 'kp:2'],
        outputMode: 'full_summary',
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          { pointKey: 'kp:1', judgment: 'skipped', matchedPointId: 10, matchedContent: 'Existing' },
          { pointKey: 'kp:2', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
        ...overrides,
      },
    ];
  }

  describe('pointKey reference integrity', () => {
    it('ignores unknown pointKeys in judgments', async () => {
      const entityJudgments = makeEntityJudgments({
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          { pointKey: 'kp:999', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      });

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(createTestEntity({ id: 1 }));

      const result = await validatePipelineOutput(ctx, { knowledgeRepo });
      const judgments = result.validationResult?.validEntities[0].pointJudgments;
      expect(judgments.find((j) => j.pointKey === 'kp:999')).toBeUndefined();
      expect(result.validationWarnings.some((w) => w.includes('kp:999'))).toBe(true);
    });
  });

  describe('entityKey format validation', () => {
    it('isolates entity with invalid entityKey format', async () => {
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'invalid-format',
          entityName: 'Bad',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validEntities).toHaveLength(0);
      const invalidKeyDrops = result.validationResult?.droppedPoints.filter(
        (d) => d.reason === 'invalid_entity_key_format',
      );
      expect(invalidKeyDrops).toHaveLength(1);
      expect(invalidKeyDrops[0].pointKey).toBe('kp:0');
    });

    it('accepts entity:N format', async () => {
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(createTestEntity({ id: 1 }));

      const ctx = createTestContext({
        points: makePoints(),
        entityJudgments: makeEntityJudgments(),
      });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validEntities).toHaveLength(1);
    });

    it('accepts draft:xxx format', async () => {
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'draft:new-entity',
          entityName: 'New Entity',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validEntities).toHaveLength(1);
    });

    it('rejects draft: with empty suffix', async () => {
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'draft:',
          entityName: 'Bad Draft',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validEntities).toHaveLength(0);
      expect(result.validationResult?.droppedPoints[0].reason).toBe('invalid_entity_key_format');
    });
  });

  describe('entityKey reference integrity', () => {
    it('isolates entity group when entity:N does not exist in DB', async () => {
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(undefined);

      const ctx = createTestContext({
        points: makePoints(),
        entityJudgments: makeEntityJudgments(),
      });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validEntities).toHaveLength(0);
      expect(result.validationResult?.droppedPoints.length).toBeGreaterThan(0);
      expect(result.validationResult?.droppedPoints[0].reason).toBe('invalid_entity_ref');
    });
  });

  describe('matchedPointId validity', () => {
    it('degrades to judgment=new when matchedPointId is invalid', async () => {
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(createTestEntity({ id: 1 }));
      knowledgeRepo.getActiveFactPointsForEntity = vi
        .fn()
        .mockReturnValue([{ id: 10, content: 'Existing', type: 'fact', status: 'active' }]);

      const entityJudgments = makeEntityJudgments({
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          {
            pointKey: 'kp:1',
            judgment: 'skipped',
            matchedPointId: 999,
            matchedContent: 'Invalid match',
          },
          { pointKey: 'kp:2', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      });

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      const kp1 = result.validationResult?.validEntities[0].pointJudgments.find(
        (j) => j.pointKey === 'kp:1',
      );
      expect(kp1?.judgment).toBe('new');
      expect(
        result.validationWarnings.some((w) => w.includes('matchedPointId') && w.includes('999')),
      ).toBe(true);
    });

    it('degrades to judgment=new when skipped has null matchedPointId', async () => {
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(createTestEntity({ id: 1 }));
      knowledgeRepo.getActiveFactPointsForEntity = vi
        .fn()
        .mockReturnValue([{ id: 10, content: 'Existing', type: 'fact', status: 'active' }]);

      const entityJudgments = makeEntityJudgments({
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          { pointKey: 'kp:1', judgment: 'skipped', matchedPointId: null, matchedContent: null },
          { pointKey: 'kp:2', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      });

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      const kp1 = result.validationResult?.validEntities[0].pointJudgments.find(
        (j) => j.pointKey === 'kp:1',
      );
      expect(kp1?.judgment).toBe('new');
      expect(kp1?.matchedPointId).toBeNull();
      expect(
        result.validationWarnings.some((w) => w.includes('skipped') && w.includes('null')),
      ).toBe(true);
    });
  });

  describe('fact pointKey coverage', () => {
    it('defaults missing fact pointKey to judgment=new', async () => {
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(createTestEntity({ id: 1 }));

      const entityJudgments = makeEntityJudgments({
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          { pointKey: 'kp:2', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      });

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      const kp1 = result.validationResult?.validEntities[0].pointJudgments.find(
        (j) => j.pointKey === 'kp:1',
      );
      expect(kp1).toBeDefined();
      expect(kp1?.judgment).toBe('new');
    });

    it('takes first occurrence for duplicate fact pointKey', async () => {
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(createTestEntity({ id: 1 }));

      const entityJudgments = makeEntityJudgments({
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          { pointKey: 'kp:0', judgment: 'skipped', matchedPointId: 10, matchedContent: 'dup' },
          { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
          { pointKey: 'kp:2', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      });

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      const kp0 = result.validationResult?.validEntities[0].pointJudgments.find(
        (j) => j.pointKey === 'kp:0',
      );
      expect(kp0?.judgment).toBe('new');
    });
  });

  describe('opinion pointKey exclusion', () => {
    it('ignores opinion pointKeys that appear in comparing output', async () => {
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(createTestEntity({ id: 1 }));

      const ctx = createTestContext({
        points: makePoints(),
        entityJudgments: makeEntityJudgments(),
      });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      const kp2 = result.validationResult?.validEntities[0].pointJudgments.find(
        (j) => j.pointKey === 'kp:2',
      );
      expect(kp2?.judgment).toBe('new');
    });
  });

  describe('unassigned points', () => {
    it('drops points not assigned to any entity', async () => {
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'draft:e1',
          entityName: 'E1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.droppedPoints).toHaveLength(2);
      expect(result.validationResult?.droppedPoints.every((d) => d.reason === 'unassigned')).toBe(
        true,
      );
    });
  });

  describe('draft entity dedup', () => {
    it('merges same-name draft entities (normalize: trim + collapse spaces + lowercase)', async () => {
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'draft:claude-code',
          entityName: 'Claude Code',
          resolvedCategoryPath: 'Tech/AI',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
          keywords: ['cli', 'ai', 'tool'],
        },
        {
          entityKey: 'draft:claude-code-2',
          entityName: '  claude  code  ',
          resolvedCategoryPath: 'Tech/AI',
          knowledgePointKeys: ['kp:1'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
          keywords: ['cli', 'ai', 'tool'],
        },
      ];

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validEntities).toHaveLength(1);
      expect(result.validationResult?.validEntities[0].knowledgePointKeys).toContain('kp:0');
      expect(result.validationResult?.validEntities[0].knowledgePointKeys).toContain('kp:1');
    });

    it('downgrades draft to entity:N when name matches existing entity canonical name', async () => {
      const existingEntity = createTestEntity({ id: 5, name: 'Claude Code' });
      knowledgeRepo.getEntityRegistry = vi
        .fn()
        .mockReturnValue([{ ...existingEntity, categoryPaths: ['/Tech/AI'] }]);
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(existingEntity);

      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'draft:claude-code',
          entityName: 'Claude Code',
          resolvedCategoryPath: 'Tech/AI',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
          keywords: ['cli', 'ai', 'tool'],
        },
      ];

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validEntities[0].entityKey).toBe('entity:5');
    });

    it('keeps draft when name only matches existing entity alias (not canonical)', async () => {
      const existingEntity = createTestEntity({
        id: 5,
        name: 'Claude Code',
        aliases: JSON.stringify(['CC', 'claude cli']),
      });
      knowledgeRepo.getEntityRegistry = vi
        .fn()
        .mockReturnValue([{ ...existingEntity, categoryPaths: ['/Tech/AI'] }]);

      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'draft:cc',
          entityName: 'CC',
          resolvedCategoryPath: 'Tech/AI',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
          keywords: ['cli', 'ai', 'tool'],
        },
      ];

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validEntities[0].entityKey).toBe('draft:cc');
      expect(result.validationWarnings.some((w) => w.includes('alias'))).toBe(true);
    });
  });

  describe('entity:N reference dedup', () => {
    it('merges duplicate entity:N references', async () => {
      const existingEntity = createTestEntity({ id: 1 });
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(existingEntity);
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([existingEntity]);
      knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue([]);

      const points: IndexedPoint[] = [
        { pointKey: 'kp:0', content: 'Fact 0', type: 'fact' },
        { pointKey: 'kp:1', content: 'Fact 1', type: 'fact' },
        { pointKey: 'kp:2', content: 'Opinion 2', type: 'opinion' },
      ];

      // Two entityJudgments both referencing entity:1
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'entity:1',
          entityName: 'E1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
        {
          entityKey: 'entity:1',
          entityName: 'E1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:1'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      const ctx = createTestContext({ points, entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      // Should be merged into a single entity entry
      expect(result.validationResult?.validEntities).toHaveLength(1);
      const merged = result.validationResult?.validEntities[0];
      expect(merged.knowledgePointKeys).toContain('kp:0');
      expect(merged.knowledgePointKeys).toContain('kp:1');
      // pointJudgments should contain both points
      expect(merged.pointJudgments.find((j) => j.pointKey === 'kp:0')).toBeDefined();
      expect(merged.pointJudgments.find((j) => j.pointKey === 'kp:1')).toBeDefined();
      // Should generate a dedup warning
      expect(result.validationWarnings.some((w) => w.includes('Entity ref dedup'))).toBe(true);
    });

    it('resolves conflicting pointJudgments on entity:N merge (skipped wins over new)', async () => {
      const knowledgeRepo = createMockKnowledgeRepo();
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue({ id: 1, name: 'E1' });
      knowledgeRepo.getActiveFactPointsForEntity = vi
        .fn()
        .mockReturnValue([{ id: 100, content: 'existing fact', type: 'fact' }]);

      const points: IndexedPoint[] = [
        { pointKey: 'kp:0', content: 'fact A', type: 'fact' as const },
      ];

      // First judgment says kp:0 is 'new', second says 'skipped' with matchedPointId
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'entity:1',
          entityName: 'E1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
        {
          entityKey: 'entity:1',
          entityName: 'E1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            {
              pointKey: 'kp:0',
              judgment: 'skipped',
              matchedPointId: 100,
              matchedContent: 'existing fact',
            },
          ],
        },
      ];

      const ctx = createTestContext({ points, entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      const merged = result.validationResult?.validEntities[0];
      // 'skipped' with matchedPointId should win over 'new'
      const pj = merged.pointJudgments.find((j) => j.pointKey === 'kp:0');
      expect(pj?.judgment).toBe('skipped');
      expect(pj?.matchedPointId).toBe(100);
    });
  });

  describe('category path validation', () => {
    it('truncates draft category path deeper than 5 levels', async () => {
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'draft:e1',
          entityName: 'E1',
          resolvedCategoryPath: 'Tech/AI/Tools/SubCategory/SubSub/Deep',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
          keywords: ['a', 'b', 'c'],
        },
      ];

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      const path = result.validationResult?.validEntities[0].resolvedCategoryPath;
      expect(path.split('/').length).toBeLessThanOrEqual(5);
    });

    it('falls back to classifier categoryPath when draft has empty path', async () => {
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'draft:e1',
          entityName: 'E1',
          resolvedCategoryPath: '',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
          keywords: ['a', 'b', 'c'],
        },
      ];

      const ctx = createTestContext({
        points: makePoints(),
        entityJudgments,
        classification: { categoryPath: 'Tech/AI', keywords: ['AI'] },
      });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validEntities[0].resolvedCategoryPath).toBe('Tech/AI');
    });

    it('rejects segments longer than 50 characters (truncates path)', async () => {
      const longSegment = 'a'.repeat(51);
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'draft:e1',
          entityName: 'E1',
          resolvedCategoryPath: `Tech/${longSegment}`,
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
          keywords: ['a', 'b', 'c'],
        },
      ];

      const ctx = createTestContext({ points: makePoints(), entityJudgments });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(
        result.validationWarnings.some((w) => w.includes('segment') || w.includes('characters')),
      ).toBe(true);
    });
  });

  describe('normalizeName strengthened matching', () => {
    it('promotes draft when name differs only by spacing/punctuation', async () => {
      const knowledgeRepo = createMockKnowledgeRepo();
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([
        {
          id: 1,
          name: 'OpenAI',
          description: 'AI company',
          aliases: '[]',
          keywords: '[]',
          createdAt: '',
          updatedAt: '',
          categoryPaths: ['/Tech'],
          activePointCount: 1,
        },
      ]);
      knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue([]);
      knowledgeRepo.getEntityById = vi
        .fn()
        .mockReturnValue(createTestEntity({ id: 1, name: 'OpenAI' }));

      const ctx = createTestContext({
        points: makePoints(),
        entityJudgments: [
          {
            entityKey: 'draft:open-ai',
            entityName: 'Open AI',
            resolvedCategoryPath: 'Tech',
            knowledgePointKeys: ['kp:0'],
            outputMode: 'full_summary' as const,
            pointJudgments: [
              {
                pointKey: 'kp:0',
                judgment: 'new' as const,
                matchedPointId: null,
                matchedContent: null,
              },
            ],
          },
        ],
      });

      const result = await validatePipelineOutput(ctx, { knowledgeRepo });
      const entities = result.validationResult!.validEntities;
      expect(entities).toHaveLength(1);
      expect(entities[0].entityKey).toBe('entity:1');
    });

    it('promotes draft when name differs by hyphen', async () => {
      const knowledgeRepo = createMockKnowledgeRepo();
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([
        {
          id: 2,
          name: 'GPT-4o',
          description: '',
          aliases: '[]',
          keywords: '[]',
          createdAt: '',
          updatedAt: '',
          categoryPaths: ['/Tech'],
          activePointCount: 1,
        },
      ]);
      knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue([]);
      knowledgeRepo.getEntityById = vi
        .fn()
        .mockReturnValue(createTestEntity({ id: 2, name: 'GPT-4o' }));

      const ctx = createTestContext({
        points: makePoints(),
        entityJudgments: [
          {
            entityKey: 'draft:gpt4o',
            entityName: 'GPT4o',
            resolvedCategoryPath: 'Tech',
            knowledgePointKeys: ['kp:0'],
            outputMode: 'full_summary' as const,
            pointJudgments: [
              {
                pointKey: 'kp:0',
                judgment: 'new' as const,
                matchedPointId: null,
                matchedContent: null,
              },
            ],
          },
        ],
      });

      const result = await validatePipelineOutput(ctx, { knowledgeRepo });
      const entities = result.validationResult!.validEntities;
      expect(entities[0].entityKey).toBe('entity:2');
    });

    it('promotes draft via embedding similarity when string match fails', async () => {
      const knowledgeRepo = createMockKnowledgeRepo();
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([
        {
          id: 5,
          name: 'ChatGPT',
          description: 'AI chatbot by OpenAI',
          aliases: '[]',
          keywords: '[]',
          createdAt: '',
          updatedAt: '',
          categoryPaths: ['/Tech'],
          activePointCount: 1,
        },
      ]);
      knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue([]);
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue({
        id: 5,
        name: 'ChatGPT',
        description: 'AI chatbot by OpenAI',
        aliases: '[]',
        keywords: '[]',
        createdAt: '',
        updatedAt: '',
      });

      const mockEmbeddingProvider = {
        embedMany: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
        embed: vi.fn(),
        dimensions: 3,
        modelId: 'test',
      };

      const mockRawDb = {
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([{ rowid: 5, distance: 0.15 }]),
        }),
      };

      const { getRawDatabase } = await import('../../../src/db/connection.js');
      vi.mocked(getRawDatabase).mockReturnValue(mockRawDb as any);

      const ctx = createTestContext({
        points: makePoints(),
        entityJudgments: [
          {
            entityKey: 'draft:ai-chatbot',
            entityName: 'AI Chatbot',
            resolvedCategoryPath: 'Tech',
            knowledgePointKeys: ['kp:0'],
            outputMode: 'full_summary' as const,
            pointJudgments: [
              {
                pointKey: 'kp:0',
                judgment: 'new' as const,
                matchedPointId: null,
                matchedContent: null,
              },
            ],
          },
        ],
      });

      const result = await validatePipelineOutput(ctx, {
        knowledgeRepo,
        embeddingProvider: mockEmbeddingProvider,
        db: {} as any,
      });

      const entities = result.validationResult!.validEntities;
      expect(entities[0].entityKey).toBe('entity:5');
      expect(mockEmbeddingProvider.embedMany).toHaveBeenCalledTimes(1);
    });

    it('keeps draft when embedding distance exceeds threshold', async () => {
      const knowledgeRepo = createMockKnowledgeRepo();
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([
        {
          id: 5,
          name: 'ChatGPT',
          description: 'AI chatbot',
          aliases: '[]',
          keywords: '[]',
          createdAt: '',
          updatedAt: '',
          categoryPaths: ['/Tech'],
          activePointCount: 1,
        },
      ]);

      const mockEmbeddingProvider = {
        embedMany: vi.fn().mockResolvedValue([[0.9, 0.8, 0.7]]),
        embed: vi.fn(),
        dimensions: 3,
        modelId: 'test',
      };

      const mockRawDb = {
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([{ rowid: 5, distance: 0.95 }]),
        }),
      };

      const { getRawDatabase } = await import('../../../src/db/connection.js');
      vi.mocked(getRawDatabase).mockReturnValue(mockRawDb as any);

      const ctx = createTestContext({
        points: makePoints(),
        entityJudgments: [
          {
            entityKey: 'draft:quantum-computing',
            entityName: 'Quantum Computing',
            resolvedCategoryPath: 'Tech',
            knowledgePointKeys: ['kp:0'],
            outputMode: 'full_summary' as const,
            pointJudgments: [
              {
                pointKey: 'kp:0',
                judgment: 'new' as const,
                matchedPointId: null,
                matchedContent: null,
              },
            ],
          },
        ],
      });

      const result = await validatePipelineOutput(ctx, {
        knowledgeRepo,
        embeddingProvider: mockEmbeddingProvider,
        db: {} as any,
      });

      const entities = result.validationResult!.validEntities;
      expect(entities[0].entityKey).toBe('draft:quantum-computing');
    });

    it('merges two drafts promoted to same entity via entity:N dedup', async () => {
      const knowledgeRepo = createMockKnowledgeRepo();
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([
        {
          id: 10,
          name: 'OpenAI',
          description: 'AI research company',
          aliases: '[]',
          keywords: '[]',
          createdAt: '',
          updatedAt: '',
          categoryPaths: ['/Tech'],
          activePointCount: 1,
        },
      ]);
      knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue([]);
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue({
        id: 10,
        name: 'OpenAI',
        description: 'AI research company',
        aliases: '[]',
        keywords: '[]',
        createdAt: '',
        updatedAt: '',
      });

      const mockEmbeddingProvider = {
        embedMany: vi.fn().mockResolvedValue([
          [0.1, 0.2, 0.3],
          [0.1, 0.25, 0.35],
        ]),
        embed: vi.fn(),
        dimensions: 3,
        modelId: 'test',
      };

      const mockRawDb = {
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([{ rowid: 10, distance: 0.1 }]),
        }),
      };

      const { getRawDatabase } = await import('../../../src/db/connection.js');
      vi.mocked(getRawDatabase).mockReturnValue(mockRawDb as any);

      const ctx = createTestContext({
        points: createTestIndexedPoints(2),
        entityJudgments: [
          {
            entityKey: 'draft:openai-variant-1',
            entityName: 'OpenAI Inc',
            resolvedCategoryPath: 'Tech',
            knowledgePointKeys: ['kp:0'],
            outputMode: 'full_summary' as const,
            pointJudgments: [
              {
                pointKey: 'kp:0',
                judgment: 'new' as const,
                matchedPointId: null,
                matchedContent: null,
              },
            ],
          },
          {
            entityKey: 'draft:openai-variant-2',
            entityName: 'Open AI Corp',
            resolvedCategoryPath: 'Tech',
            knowledgePointKeys: ['kp:1'],
            outputMode: 'full_summary' as const,
            pointJudgments: [
              {
                pointKey: 'kp:1',
                judgment: 'new' as const,
                matchedPointId: null,
                matchedContent: null,
              },
            ],
          },
        ],
      });

      const result = await validatePipelineOutput(ctx, {
        knowledgeRepo,
        embeddingProvider: mockEmbeddingProvider,
        db: {} as any,
      });

      const entities = result.validationResult!.validEntities;
      const openaiEntities = entities.filter((e) => e.entityKey === 'entity:10');
      expect(openaiEntities).toHaveLength(1);
      expect(openaiEntities[0].knowledgePointKeys).toContain('kp:0');
      expect(openaiEntities[0].knowledgePointKeys).toContain('kp:1');
    });

    it('skips embedding check when embeddingProvider is null', async () => {
      const knowledgeRepo = createMockKnowledgeRepo();
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([]);

      const ctx = createTestContext({
        points: makePoints(),
        entityJudgments: [
          {
            entityKey: 'draft:new-thing',
            entityName: 'New Thing',
            resolvedCategoryPath: 'Tech',
            knowledgePointKeys: ['kp:0'],
            outputMode: 'full_summary' as const,
            pointJudgments: [
              {
                pointKey: 'kp:0',
                judgment: 'new' as const,
                matchedPointId: null,
                matchedContent: null,
              },
            ],
          },
        ],
      });

      const result = await validatePipelineOutput(ctx, { knowledgeRepo });
      const entities = result.validationResult!.validEntities;
      expect(entities[0].entityKey).toBe('draft:new-thing');
    });
  });

  describe('relation validation', () => {
    it('passes valid relations through', async () => {
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(createTestEntity({ id: 1 }));
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([]);

      const points = makePoints();
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'entity:1',
          entityName: 'E1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
        {
          entityKey: 'entity:2',
          entityName: 'E2',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:1'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];
      knowledgeRepo.getEntityById = vi.fn().mockImplementation((id: number) => {
        if (id === 1) return createTestEntity({ id: 1, name: 'E1' });
        if (id === 2) return createTestEntity({ id: 2, name: 'E2' });
        return undefined;
      });

      const relations: RelationOutput[] = [
        {
          sourceEntityKey: 'entity:1',
          targetEntityKey: 'entity:2',
          relationType: 'collaborative',
          description: 'E1 collaborates with E2',
        },
      ];

      const ctx = createTestContext({ points, entityJudgments, relations });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validRelations).toHaveLength(1);
      expect(result.validationResult?.validRelations?.[0].relationType).toBe('collaborative');
      expect(result.validationResult?.droppedRelations).toHaveLength(0);
    });

    it('drops relations with invalid entityKey', async () => {
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(createTestEntity({ id: 1 }));
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([]);

      const points = makePoints();
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'entity:1',
          entityName: 'E1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0', 'kp:1', 'kp:2'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
            { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
            { pointKey: 'kp:2', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      const relations: RelationOutput[] = [
        {
          sourceEntityKey: 'entity:1',
          targetEntityKey: 'entity:999',
          relationType: 'competitive',
          description: 'Does not exist',
        },
      ];

      const ctx = createTestContext({ points, entityJudgments, relations });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validRelations).toHaveLength(0);
      expect(result.validationResult?.droppedRelations).toHaveLength(1);
      expect(result.validationResult?.droppedRelations?.[0].reason).toBe('invalid_entity_ref');
    });

    it('drops self-referencing relations', async () => {
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(createTestEntity({ id: 1 }));
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([]);

      const points = makePoints();
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'entity:1',
          entityName: 'E1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0', 'kp:1', 'kp:2'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
            { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
            { pointKey: 'kp:2', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      const relations: RelationOutput[] = [
        {
          sourceEntityKey: 'entity:1',
          targetEntityKey: 'entity:1',
          relationType: 'general',
          description: 'Self ref',
        },
      ];

      const ctx = createTestContext({ points, entityJudgments, relations });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validRelations).toHaveLength(0);
      expect(result.validationResult?.droppedRelations).toHaveLength(1);
      expect(result.validationResult?.droppedRelations?.[0].reason).toBe('self_reference');
    });

    it('updates relation entityKeys when draft is promoted', async () => {
      const existingEntity = createTestEntity({ id: 100, name: 'OpenAI' });
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([
        {
          ...existingEntity,
          categoryPaths: ['/Tech'],
          activePointCount: 0,
        },
      ]);
      knowledgeRepo.getEntityById = vi.fn().mockImplementation((id: number) => {
        if (id === 100) return existingEntity;
        if (id === 2) return createTestEntity({ id: 2, name: 'E2' });
        return undefined;
      });
      knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue([]);

      const points = makePoints();
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'draft:openai',
          entityName: 'OpenAI',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
        {
          entityKey: 'entity:2',
          entityName: 'E2',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:1'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      const relations: RelationOutput[] = [
        {
          sourceEntityKey: 'draft:openai',
          targetEntityKey: 'entity:2',
          relationType: 'organizational',
          description: 'OpenAI org relation',
        },
      ];

      const ctx = createTestContext({ points, entityJudgments, relations });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validRelations).toHaveLength(1);
      expect(result.validationResult?.validRelations?.[0].sourceEntityKey).toBe('entity:100');
      expect(result.validationResult?.validRelations?.[0].targetEntityKey).toBe('entity:2');
    });

    it('returns empty validRelations when ctx.relations is undefined', async () => {
      knowledgeRepo.getEntityById = vi.fn().mockReturnValue(createTestEntity({ id: 1 }));
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([]);

      const ctx = createTestContext({
        points: makePoints(),
        entityJudgments: makeEntityJudgments(),
      });
      // Do NOT set ctx.relations
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validRelations).toHaveLength(0);
      expect(result.validationResult?.droppedRelations).toHaveLength(0);
    });

    it('drops relations with invalid type', async () => {
      knowledgeRepo.getEntityById = vi.fn().mockImplementation((id: number) => {
        if (id === 1) return createTestEntity({ id: 1, name: 'E1' });
        if (id === 2) return createTestEntity({ id: 2, name: 'E2' });
        return undefined;
      });
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([]);

      const points = makePoints();
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'entity:1',
          entityName: 'E1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
        {
          entityKey: 'entity:2',
          entityName: 'E2',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:1'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      const relations: RelationOutput[] = [
        {
          sourceEntityKey: 'entity:1',
          targetEntityKey: 'entity:2',
          relationType: 'invalid_type_here' as any,
          description: 'Bad type',
        },
      ];

      const ctx = createTestContext({ points, entityJudgments, relations });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validRelations).toHaveLength(0);
      expect(result.validationResult?.droppedRelations).toHaveLength(1);
      expect(result.validationResult?.droppedRelations?.[0].reason).toBe('invalid_type');
      expect(result.validationResult?.droppedRelations?.[0].relationType).toBe('invalid_type_here');
    });

    it('deduplicates relations after draft promotion', async () => {
      const existingEntity = createTestEntity({ id: 50, name: 'SameThing' });
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([
        {
          ...existingEntity,
          categoryPaths: ['/Tech'],
          activePointCount: 0,
        },
      ]);
      knowledgeRepo.getEntityById = vi.fn().mockImplementation((id: number) => {
        if (id === 50) return existingEntity;
        if (id === 2) return createTestEntity({ id: 2, name: 'E2' });
        return undefined;
      });
      knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue([]);

      const points: IndexedPoint[] = [
        { pointKey: 'kp:0', content: 'Fact 0', type: 'fact' },
        { pointKey: 'kp:1', content: 'Fact 1', type: 'fact' },
        { pointKey: 'kp:2', content: 'Fact 2', type: 'fact' },
      ];

      // Two drafts with the same normalized name → both promote to entity:50
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'draft:same-thing-a',
          entityName: 'SameThing',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
        {
          entityKey: 'entity:2',
          entityName: 'E2',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:1'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      // Two relations from different draft keys (both will become entity:50 after promotion)
      // creating a duplicate relation after promotion
      const relations: RelationOutput[] = [
        {
          sourceEntityKey: 'draft:same-thing-a',
          targetEntityKey: 'entity:2',
          relationType: 'technical',
          description: 'Rel from draft A',
        },
        {
          sourceEntityKey: 'entity:50',
          targetEntityKey: 'entity:2',
          relationType: 'technical',
          description: 'Rel from entity:50 directly',
        },
      ];

      const ctx = createTestContext({ points, entityJudgments, relations });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validRelations).toHaveLength(1);
      expect(
        result.validationResult?.droppedRelations?.some(
          (d) => d.reason === 'duplicate_after_promotion',
        ),
      ).toBe(true);
    });

    it('resolves relation keys when loser draft is merged into winner draft', async () => {
      knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([]);

      const points: IndexedPoint[] = [
        { pointKey: 'kp:0', content: 'Fact 0', type: 'fact' },
        { pointKey: 'kp:1', content: 'Fact 1', type: 'fact' },
        { pointKey: 'kp:2', content: 'Fact 2', type: 'fact' },
      ];

      // Two drafts with same normalized name — second (loser) merges into first (winner)
      const entityJudgments: EntityJudgment[] = [
        {
          entityKey: 'draft:acme-corp',
          entityName: 'Acme Corp',
          resolvedCategoryPath: 'Business',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
        {
          entityKey: 'draft:acme-corp-2',
          entityName: 'AcmeCorp',
          resolvedCategoryPath: 'Business',
          knowledgePointKeys: ['kp:1'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
        {
          entityKey: 'draft:other-co',
          entityName: 'Other Co',
          resolvedCategoryPath: 'Business',
          knowledgePointKeys: ['kp:2'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:2', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      // Relation references the loser draft key
      const relations: RelationOutput[] = [
        {
          sourceEntityKey: 'draft:acme-corp-2',
          targetEntityKey: 'draft:other-co',
          relationType: 'competitive',
          description: 'They compete',
        },
      ];

      const ctx = createTestContext({ points, entityJudgments, relations });
      const result = await validatePipelineOutput(ctx, { knowledgeRepo });

      expect(result.validationResult?.validRelations).toHaveLength(1);
      expect(result.validationResult?.validRelations?.[0].sourceEntityKey).toBe('draft:acme-corp');
      expect(result.validationResult?.validRelations?.[0].targetEntityKey).toBe('draft:other-co');
      expect(result.validationResult?.droppedRelations).toHaveLength(0);
    });
  });
});
