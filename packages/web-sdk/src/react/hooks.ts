// packages/web-sdk/src/react/hooks.ts
import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react';
import { GoldpanApiError } from '../errors';
import type {
  CategoryTree,
  Entity,
  EntityDetail,
  EntityListParams,
  InputResult,
  PaginatedList,
  SourceViewDetail,
  SourceViewListParams,
  SourceViewListResult,
  Task,
  TaskDetail,
  TaskListResponse,
} from '../types';
import { useGoldpanClient } from './provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toGoldpanApiError(error: unknown): GoldpanApiError {
  if (error instanceof GoldpanApiError) return error;
  return new GoldpanApiError(
    error instanceof Error ? error.message : 'Unknown error',
    'network_error',
    0,
  );
}

interface FetchState<T> {
  data: T | null;
  isLoading: boolean;
  error: GoldpanApiError | null;
  refetch: () => void;
}

/** Generic data-fetch hook. `deps` drive when the effect re-runs; the
 * fetcher closure is captured at effect-run-time. When `pollInterval` is
 * set, subsequent poll results are deduplicated by JSON-equality so
 * unchanged payloads do not trigger downstream re-renders — relies on the
 * server preserving JSON key order across calls (true for our routes). */
function useFetch<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
  options?: { pollInterval?: number },
): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<GoldpanApiError | null>(null);
  const [fetchKey, setFetchKey] = useState(0);
  const refetch = useCallback(() => setFetchKey((k) => k + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps + fetchKey + pollInterval drive the effect; fetcher closure is intentionally captured at effect-run-time.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    let lastSerialized: string | undefined;

    const run = () => {
      fetcher()
        .then((result) => {
          if (cancelled) return;
          const serialized = JSON.stringify(result);
          if (serialized !== lastSerialized) {
            lastSerialized = serialized;
            setData(result);
          }
          setIsLoading(false);
          setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(toGoldpanApiError(e));
          setIsLoading(false);
        });
    };

    run();

    let intervalId: ReturnType<typeof setInterval> | undefined;
    if (options?.pollInterval && options.pollInterval > 0) {
      intervalId = setInterval(run, options.pollInterval);
    }

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [...deps, fetchKey, options?.pollInterval]);

  return { data, isLoading, error, refetch };
}

// Stable fallback so consumers see the same `tasks` reference between mount
// and first successful fetch.
const NO_TASKS: Task[] = [];

// ---------------------------------------------------------------------------
// useInput — action hook (execute on demand)
// ---------------------------------------------------------------------------

export function useInput(): {
  execute: (text: string) => Promise<void>;
  result: InputResult | null;
  isPending: boolean;
  error: GoldpanApiError | null;
} {
  const client = useGoldpanClient();
  const [result, setResult] = useState<InputResult | null>(null);
  const [error, setError] = useState<GoldpanApiError | null>(null);
  const [isPending, setIsPending] = useState(false);

  // Sequence guards: a request-id counter ensures only the most-recent
  // execute() wins when calls overlap, an AbortController cancels an
  // in-flight previous call, and `mountedRef` keeps the `finally` block from
  // setState-ing on an unmounted component (the abort suppresses the try/
  // catch paths but `finally` still runs).
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const execute = useCallback(
    async (text: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const myId = ++requestIdRef.current;
      setIsPending(true);
      setError(null);
      try {
        const res = await client.input({ input: text }, controller.signal);
        if (!mountedRef.current || myId !== requestIdRef.current) return;
        setResult(res);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (!mountedRef.current || myId !== requestIdRef.current) return;
        setError(toGoldpanApiError(e));
        setResult(null);
      } finally {
        if (mountedRef.current && myId === requestIdRef.current) {
          setIsPending(false);
        }
      }
    },
    [client],
  );

  return { execute, result, isPending, error };
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

export function useTaskList(options?: { pollInterval?: number }): {
  tasks: Task[];
  isLoading: boolean;
  error: GoldpanApiError | null;
  refetch: () => void;
} {
  const client = useGoldpanClient();
  const { data, isLoading, error, refetch } = useFetch<TaskListResponse>(
    () => client.getTasks(),
    [client],
    options,
  );
  return { tasks: data?.data ?? NO_TASKS, isLoading, error, refetch };
}

export function useTaskDetail(
  taskId: number,
  options?: { pollInterval?: number },
): {
  task: TaskDetail | null;
  isLoading: boolean;
  error: GoldpanApiError | null;
  refetch: () => void;
} {
  const client = useGoldpanClient();
  const { data, isLoading, error, refetch } = useFetch<TaskDetail>(
    () => client.getTask(taskId),
    [client, taskId],
    options,
  );
  return { task: data, isLoading, error, refetch };
}

export function useCategories(): {
  categories: CategoryTree | null;
  isLoading: boolean;
  error: GoldpanApiError | null;
  refetch: () => void;
} {
  const client = useGoldpanClient();
  const { data, isLoading, error, refetch } = useFetch<CategoryTree>(
    () => client.getCategories(),
    [client],
  );
  return { categories: data, isLoading, error, refetch };
}

export function useEntities(params?: EntityListParams): {
  entities: PaginatedList<Entity> | null;
  isLoading: boolean;
  error: GoldpanApiError | null;
  refetch: () => void;
} {
  const client = useGoldpanClient();
  const { data, isLoading, error, refetch } = useFetch<PaginatedList<Entity>>(
    () => client.getEntities(params),
    [client, params?.category],
  );
  return { entities: data, isLoading, error, refetch };
}

export function useEntity(entityId: number): {
  entity: EntityDetail | null;
  isLoading: boolean;
  error: GoldpanApiError | null;
  refetch: () => void;
} {
  const client = useGoldpanClient();
  const { data, isLoading, error, refetch } = useFetch<EntityDetail>(
    () => client.getEntity(entityId),
    [client, entityId],
  );
  return { entity: data, isLoading, error, refetch };
}

export function useSourceViewList(params?: SourceViewListParams): {
  sourceViewList: SourceViewListResult | null;
  isLoading: boolean;
  error: GoldpanApiError | null;
  refetch: () => void;
} {
  const client = useGoldpanClient();
  const { data, isLoading, error, refetch } = useFetch<SourceViewListResult>(
    () => client.listSourceView(params),
    [client, params?.category],
  );
  return { sourceViewList: data, isLoading, error, refetch };
}

export function useSourceView(sourceId: number): {
  sourceView: SourceViewDetail | null;
  isLoading: boolean;
  error: GoldpanApiError | null;
  refetch: () => void;
} {
  const client = useGoldpanClient();
  const { data, isLoading, error, refetch } = useFetch<SourceViewDetail>(
    () => client.getSourceView(sourceId),
    [client, sourceId],
  );
  return { sourceView: data, isLoading, error, refetch };
}
