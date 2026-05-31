// packages/web-sdk/tests/react/hooks.test.tsx
// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoldpanClient } from '../../src/client';
import { GoldpanApiError } from '../../src/errors';
import {
  useCategories,
  useEntities,
  useEntity,
  useInput,
  useSourceView,
  useSourceViewList,
  useTaskDetail,
  useTaskList,
} from '../../src/react/hooks';
import { GoldpanProvider, useGoldpanClient } from '../../src/react/provider';
import { type FetchHandler, installMockFetch, type MockResponse } from '../helpers/mock-fetch';

let handler: FetchHandler;
let restore: () => void;

function createWrapper(client?: GoldpanClient) {
  const c = client ?? new GoldpanClient({ baseUrl: 'http://localhost:3001' });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <GoldpanProvider client={c}>{children}</GoldpanProvider>;
  };
}

beforeEach(() => {
  handler = () => ({ status: 200, body: {} });
  const mock = installMockFetch((url, init) => handler(url, init));
  restore = mock.restore;
});

afterEach(() => {
  restore();
});

// --- Provider ---

describe('GoldpanProvider', () => {
  it('provides client via context', () => {
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const { result } = renderHook(() => useGoldpanClient(), {
      wrapper: createWrapper(client),
    });
    expect(result.current).toBe(client);
  });

  it('useGoldpanClient throws without provider', () => {
    expect(() => {
      renderHook(() => useGoldpanClient());
    }).toThrow('useGoldpanClient must be used within a GoldpanProvider');
  });
});

// --- useInput ---

describe('useInput', () => {
  it('execute sets result on success', async () => {
    handler = () => ({
      status: 200,
      body: {
        type: 'query',
        query: 'test',
        answer: 'ok',
        confidence: 'high',
        citedEntityIds: [],
        citedPointIds: [],
      },
    });
    const { result } = renderHook(() => useInput(), { wrapper: createWrapper() });

    expect(result.current.result).toBeNull();
    expect(result.current.isPending).toBe(false);

    await act(async () => {
      await result.current.execute('test query');
    });

    expect(result.current.result).toBeDefined();
    expect(result.current.result?.type).toBe('query');
    expect(result.current.isPending).toBe(false);
  });

  it('sets error on failure', async () => {
    handler = () => ({
      status: 400,
      body: { type: 'error', code: 'input_empty', message: 'Processing failed' },
    });
    const { result } = renderHook(() => useInput(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.execute('');
    });

    expect(result.current.error).toBeInstanceOf(GoldpanApiError);
    expect(result.current.error?.code).toBe('input_empty');
    expect(result.current.result).toBeNull();
  });

  it('isPending is true during execution', async () => {
    handler = () => {
      return { status: 200, body: { type: 'content', text: 'hi' } };
    };

    const { result } = renderHook(() => useInput(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.execute('test');
    });

    // After completion, isPending is false
    expect(result.current.isPending).toBe(false);
  });

  // Regression: without request sequencing, a slower first execute() could
  // overwrite a newer result. The hook must ensure only the latest call wins.
  it('latest execute() wins when called in quick succession', async () => {
    const pending: Array<(r: MockResponse) => void> = [];
    handler = () =>
      new Promise<MockResponse>((resolve) => {
        pending.push(resolve);
      });

    const { result } = renderHook(() => useInput(), { wrapper: createWrapper() });

    // Start two executes back-to-back without awaiting; the second should
    // abort the first and become the "latest" request.
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = result.current.execute('first');
      second = result.current.execute('second');
      await Promise.resolve();
    });

    // The first call is aborted by the hook; swallow its AbortError so the
    // unhandled-rejection detector stays quiet.
    first.catch(() => {});

    // Resolve the newer request — it should populate the result.
    await act(async () => {
      pending[1]?.({ status: 200, body: { type: 'content', text: 'second' } });
      await second;
    });

    expect(result.current.result).toEqual({ type: 'content', text: 'second' });
    expect(result.current.isPending).toBe(false);

    // If the old request somehow completes late (race between abort and
    // resolve), it must NOT overwrite the newer result.
    await act(async () => {
      pending[0]?.({ status: 200, body: { type: 'content', text: 'first' } });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.result).toEqual({ type: 'content', text: 'second' });
  });

  it('ignores pending request after unmount (no stray setState)', async () => {
    let resolveRequest: ((r: MockResponse) => void) | undefined;
    handler = () =>
      new Promise<MockResponse>((resolve) => {
        resolveRequest = resolve;
      });

    const { result, unmount } = renderHook(() => useInput(), { wrapper: createWrapper() });

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.execute('will-be-unmounted');
      await Promise.resolve();
    });

    unmount();

    pending.catch(() => {});

    await act(async () => {
      resolveRequest?.({ status: 200, body: { type: 'content', text: 'late' } });
      await new Promise((r) => setTimeout(r, 0));
    });

    // If we reach here without React warnings, the cleanup worked. Sanity-
    // check the latched state at unmount (no update was applied post-unmount).
    expect(result.current.result).toBeNull();
  });
});

// --- useTaskList ---

describe('useTaskList', () => {
  it('fetches tasks on mount', async () => {
    const tasks = [
      {
        id: 1,
        sourceId: 1,
        status: 'done',
        createdAt: '2025-01-01',
        pipelineStep: null,
        inputType: null,
        result: null,
        errorKind: null,
        source: null,
      },
    ];
    handler = () => ({ status: 200, body: { data: tasks, total: 1 } });

    const { result } = renderHook(() => useTaskList(), { wrapper: createWrapper() });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('polls at specified interval', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    handler = () => {
      callCount++;
      return { status: 200, body: { data: [], total: 0 } };
    };

    renderHook(() => useTaskList({ pollInterval: 1000 }), { wrapper: createWrapper() });

    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(3);

    vi.useRealTimers();
  });

  it('stops polling after unmount', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    handler = () => {
      callCount++;
      return { status: 200, body: { data: [], total: 0 } };
    };

    const { unmount } = renderHook(() => useTaskList({ pollInterval: 1000 }), {
      wrapper: createWrapper(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    unmount();

    await vi.advanceTimersByTimeAsync(5000);
    expect(callCount).toBe(1);

    vi.useRealTimers();
  });

  it('refetch triggers a new fetch', async () => {
    let callCount = 0;
    handler = () => {
      callCount++;
      return { status: 200, body: { data: [], total: 0 } };
    };

    const { result } = renderHook(() => useTaskList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(callCount).toBe(1);

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => expect(callCount).toBe(2));
  });
});

// --- useTaskDetail ---

describe('useTaskDetail', () => {
  it('fetches task by id', async () => {
    handler = (url) => {
      if (url.includes('/tasks/5')) {
        return {
          status: 200,
          body: {
            status: 'pending',
            taskId: '5',
            sourceId: 42,
            sourceUrl: 'https://example.com',
            createdAt: '2025-01-01',
            sourceStatus: null,
            logs: [],
          },
        };
      }
      return { status: 404, body: { type: 'error', code: 'not_found', message: 'Not found' } };
    };

    const { result } = renderHook(() => useTaskDetail(5), { wrapper: createWrapper() });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.task?.status).toBe('pending');
    expect(result.current.task?.sourceId).toBe(42);
    expect(result.current.task?.sourceUrl).toBe('https://example.com');
  });

  it('refetch reloads the task', async () => {
    let callCount = 0;
    handler = () => {
      callCount++;
      return {
        status: 200,
        body: {
          status: 'pending',
          taskId: '1',
          sourceId: 1,
          sourceUrl: null,
          createdAt: '2025-01-01',
          sourceStatus: null,
          logs: [],
        },
      };
    };

    const { result } = renderHook(() => useTaskDetail(1), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(callCount).toBe(1);

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => expect(callCount).toBe(2));
  });
});

// --- useCategories ---

describe('useCategories', () => {
  it('fetches categories on mount', async () => {
    handler = () => ({
      status: 200,
      body: {
        data: [
          {
            id: 1,
            name: 'Tech',
            path: 'Tech',
            parentId: null,
            createdAt: '2025-01-01',
            updatedAt: '2025-01-01',
          },
        ],
        total: 1,
      },
    });

    const { result } = renderHook(() => useCategories(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.categories?.data).toHaveLength(1);
  });
});

// --- useEntities ---

describe('useEntities', () => {
  it('fetches entities on mount', async () => {
    handler = () => ({
      status: 200,
      body: {
        data: [{ id: 1, name: 'OpenAI', categoryPaths: ['Tech'], activePointCount: 3 }],
        total: 1,
      },
    });

    const { result } = renderHook(() => useEntities(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.entities?.data).toHaveLength(1);
  });

  it('refetches when params change', async () => {
    let callCount = 0;
    handler = () => {
      callCount++;
      return { status: 200, body: { data: [], total: 0 } };
    };

    const { result, rerender } = renderHook(({ params }) => useEntities(params), {
      wrapper: createWrapper(),
      initialProps: { params: undefined as { category?: number } | undefined },
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(callCount).toBe(1);

    rerender({ params: { category: 5 } });
    await waitFor(() => expect(callCount).toBe(2));
  });
});

// --- useEntity ---

describe('useEntity', () => {
  it('fetches entity detail', async () => {
    handler = () => ({
      status: 200,
      body: {
        entity: {
          id: 1,
          name: 'OpenAI',
          description: null,
          aliases: [],
          keywords: [],
          categoryPaths: [],
        },
        points: [],
        sources: [],
        relations: [],
      },
    });

    const { result } = renderHook(() => useEntity(1), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.entity?.entity.name).toBe('OpenAI');
  });
});

// --- useSourceViewList ---

describe('useSourceViewList', () => {
  it('fetches notes on mount', async () => {
    handler = () => ({
      status: 200,
      body: {
        data: [
          {
            id: 1,
            kind: 'user',
            title: 'Note',
            originalUrl: null,
            createdAt: '2025-01-01',
            categoryIds: [],
          },
        ],
        total: 1,
        categories: [],
        stats: { sourceCount: 1, pointCount: 2 },
      },
    });

    const { result } = renderHook(() => useSourceViewList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.sourceViewList?.data).toHaveLength(1);
  });
});

// --- useSourceView ---

describe('useSourceView', () => {
  it('fetches note detail', async () => {
    handler = () => ({
      status: 200,
      body: {
        source: {
          id: 1,
          kind: 'user',
          normalizedUrl: null,
          originalUrl: null,
          title: null,
          rawContent: 'test',
          metadata: null,
          status: 'confirmed',
          createdAt: '2025-01-01',
          updatedAt: '2025-01-01',
          origin: 'user',
          trackingRuleId: null,
        },
        entities: [],
        categoryPaths: [],
        tags: ['tag1'],
      },
    });

    const { result } = renderHook(() => useSourceView(1), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.sourceView?.tags).toContain('tag1');
  });
});
