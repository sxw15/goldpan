import { describe, expect, it } from 'vitest';
import { renderDigestMarkdown } from '../src/render/markdown.js';
import type { DataSnapshot } from '../src/types.js';

function baseSnapshot(overrides: Partial<DataSnapshot> = {}): DataSnapshot {
  return {
    digestId: { channel: 'telegram:1', date: '2026-04-19', presetId: 1 },
    period: 'daily',
    generatedAt: 1_700_000_000_000,
    modules: {
      tracking_findings: {
        type: 'tracking_findings',
        items: [],
        hasMore: false,
        hiddenCount: 0,
      },
      captures: { type: 'captures', items: [], hasMore: false, hiddenCount: 0 },
      thoughts: { type: 'thoughts', items: [], hasMore: false, hiddenCount: 0 },
      new_entities: {
        type: 'new_entities',
        items: [],
        hasMore: false,
        hiddenCount: 0,
      },
      stats: { type: 'stats', captures: 0, findings: 0, thoughts: 0, entities: 0 },
    },
    aiSummary: { status: 'complete', text: '' },
    ...overrides,
  };
}

describe('renderDigestMarkdown', () => {
  it('renders slots in the requested order', () => {
    const snapshot = baseSnapshot({
      modules: {
        tracking_findings: {
          type: 'tracking_findings',
          items: [
            {
              id: 1,
              ruleId: 10,
              title: 'Finding A',
              url: 'https://example.com/a',
              createdAt: 1_700_000_000_000,
            },
          ],
          hasMore: false,
          hiddenCount: 0,
        },
        captures: {
          type: 'captures',
          items: [
            {
              id: 2,
              title: 'Capture B',
              url: 'https://example.com/b',
              createdAt: 1_700_000_000_000,
            },
          ],
          hasMore: false,
          hiddenCount: 0,
        },
        thoughts: { type: 'thoughts', items: [], hasMore: false, hiddenCount: 0 },
        new_entities: {
          type: 'new_entities',
          items: [],
          hasMore: false,
          hiddenCount: 0,
        },
        stats: {
          type: 'stats',
          captures: 1,
          findings: 1,
          thoughts: 0,
          entities: 0,
        },
      },
    });

    const md = renderDigestMarkdown(snapshot, {
      slots: ['captures', 'tracking_findings', 'stats'],
      language: 'en',
      skipEmpty: false,
      tz: 'UTC',
    });

    const capturesIdx = md.indexOf('Captures');
    const trackingIdx = md.indexOf('Tracking Findings');
    const statsIdx = md.indexOf('Stats');
    expect(capturesIdx).toBeGreaterThan(-1);
    expect(trackingIdx).toBeGreaterThan(capturesIdx);
    expect(statsIdx).toBeGreaterThan(trackingIdx);
  });

  it('omits empty sections when skipEmpty is true', () => {
    const snapshot = baseSnapshot({
      modules: {
        tracking_findings: {
          type: 'tracking_findings',
          items: [],
          hasMore: false,
          hiddenCount: 0,
        },
        captures: {
          type: 'captures',
          items: [
            {
              id: 1,
              title: 'Only Capture',
              url: 'https://example.com/only',
              createdAt: 1_700_000_000_000,
            },
          ],
          hasMore: false,
          hiddenCount: 0,
        },
        thoughts: { type: 'thoughts', items: [], hasMore: false, hiddenCount: 0 },
        new_entities: {
          type: 'new_entities',
          items: [],
          hasMore: false,
          hiddenCount: 0,
        },
        stats: {
          type: 'stats',
          captures: 1,
          findings: 0,
          thoughts: 0,
          entities: 0,
        },
      },
    });

    const md = renderDigestMarkdown(snapshot, {
      slots: ['captures', 'tracking_findings', 'thoughts'],
      language: 'en',
      skipEmpty: true,
      tz: 'UTC',
    });

    expect(md).toContain('Captures');
    expect(md).toContain('Only Capture');
    expect(md).not.toContain('Tracking Findings');
    expect(md).not.toContain('Thoughts');
  });

  it('keeps empty sections with a placeholder when skipEmpty is false', () => {
    const snapshot = baseSnapshot();

    const md = renderDigestMarkdown(snapshot, {
      slots: ['thoughts'],
      language: 'en',
      skipEmpty: false,
      tz: 'UTC',
    });

    expect(md).toContain('Thoughts');
    // Should include an empty-state marker (dash or "no entries") rather than nothing.
    expect(md.toLowerCase()).toMatch(/no entries|—|-/);
  });

  it('renders a hasMore footer when module truncates', () => {
    const snapshot = baseSnapshot({
      modules: {
        tracking_findings: {
          type: 'tracking_findings',
          items: [],
          hasMore: false,
          hiddenCount: 0,
        },
        captures: { type: 'captures', items: [], hasMore: false, hiddenCount: 0 },
        thoughts: {
          type: 'thoughts',
          items: [{ id: 1, text: 'First', createdAt: 1_700_000_000_000 }],
          hasMore: true,
          hiddenCount: 7,
        },
        new_entities: {
          type: 'new_entities',
          items: [],
          hasMore: false,
          hiddenCount: 0,
        },
        stats: {
          type: 'stats',
          captures: 0,
          findings: 0,
          thoughts: 8,
          entities: 0,
        },
      },
    });

    const md = renderDigestMarkdown(snapshot, {
      slots: ['thoughts'],
      language: 'en',
      skipEmpty: false,
      tz: 'UTC',
    });

    expect(md).toContain('First');
    expect(md).toContain('7');
    // A footer line hinting that more items exist.
    expect(md.toLowerCase()).toMatch(/more|hidden|\+/);
  });

  it('omits the "rule #X" fragment when ruleId is null (P1-4)', () => {
    const snapshot = baseSnapshot({
      modules: {
        tracking_findings: {
          type: 'tracking_findings',
          items: [
            {
              id: 1,
              ruleId: null,
              title: 'Orphaned finding',
              url: 'https://example.com/o',
              createdAt: 1_700_000_000_000,
            },
          ],
          hasMore: false,
          hiddenCount: 0,
        },
        captures: { type: 'captures', items: [], hasMore: false, hiddenCount: 0 },
        thoughts: { type: 'thoughts', items: [], hasMore: false, hiddenCount: 0 },
        new_entities: { type: 'new_entities', items: [], hasMore: false, hiddenCount: 0 },
        stats: { type: 'stats', captures: 0, findings: 1, thoughts: 0, entities: 0 },
      },
    });
    const md = renderDigestMarkdown(snapshot, {
      slots: ['tracking_findings'],
      language: 'en',
      skipEmpty: true,
      tz: 'UTC',
    });
    expect(md).toContain('Orphaned finding');
    // Must NOT print the magic-zero sentinel the prior `?? 0` coercion
    // produced, and must NOT print a stray "rule #" with no number.
    expect(md).not.toMatch(/rule #0/i);
    expect(md).not.toMatch(/rule #\s/i);
  });

  it('renders a fullEmpty placeholder when every module is empty', () => {
    const snapshot = baseSnapshot();

    const md = renderDigestMarkdown(snapshot, {
      slots: ['tracking_findings', 'captures', 'thoughts', 'new_entities'],
      language: 'en',
      skipEmpty: true,
      tz: 'UTC',
    });

    // With skipEmpty + every module empty, the rendered digest should still
    // produce a human-readable "nothing today" message rather than being blank.
    expect(md.trim().length).toBeGreaterThan(0);
    expect(md.toLowerCase()).toMatch(/nothing|no activity|empty/);
  });
});
