'use client';

import type { NoteDetail } from '@goldpan/web-sdk';
import { useCallback } from 'react';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { type FetchState, useFetchOnIdChange } from './use-fetch-on-id-change';

/**
 * P5 Task 9: 拉取与该 entity 关联的 user notes (archived=false)。
 *
 * 与 EntityDetail 走的是独立请求 —— EntityDetail 体量大且字段稳定（fact /
 * opinion / relation），notes 是另一条用户写入回路，强行塞进 EntityDetail
 * 会让 `/entities/:id` 多扛一份分页 / 排序需求。独立 endpoint 命中 user-notes
 * 已有的 listNotes(entityId) 索引，零额外 server 工作。
 */
export function useEntityLinkedNotes(entityId: number): {
  state: FetchState<NoteDetail[]>;
  retry: () => void;
} {
  const fetcher = useCallback(
    (eid: number, signal: AbortSignal) =>
      getBrowserApiClient()
        .listNotes({ entityId: eid, archived: false, limit: 20 }, signal)
        .then((r) => r.data),
    [],
  );
  return useFetchOnIdChange(entityId, fetcher);
}
