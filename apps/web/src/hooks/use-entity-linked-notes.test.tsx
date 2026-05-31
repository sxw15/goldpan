import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockList = vi.fn();
vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({ listNotes: mockList }),
}));

import { useEntityLinkedNotes } from './use-entity-linked-notes';

describe('useEntityLinkedNotes', () => {
  beforeEach(() => {
    mockList.mockReset();
  });

  it('lists notes filtered by entityId and resolves to data array', async () => {
    mockList.mockResolvedValue({
      data: [
        {
          id: 1,
          content: 'n1',
          contentTranslated: null,
          language: 'zh',
          subtype: 'memo',
          pinned: false,
          archived: false,
          sourceMessageId: null,
          conversationId: null,
          tags: [],
          linkedEntities: [],
          linkedSources: [],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      nextCursor: null,
    });
    const { result } = renderHook(() => useEntityLinkedNotes(5));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 5, archived: false, limit: 20 }),
      expect.any(AbortSignal),
    );
    if (result.current.state.status !== 'ready') throw new Error('expected ready');
    expect(result.current.state.data).toHaveLength(1);
    expect(result.current.state.data[0].id).toBe(1);
  });

  it('surfaces error state when SDK rejects', async () => {
    mockList.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useEntityLinkedNotes(7));
    await waitFor(() => expect(result.current.state.status).toBe('error'));
    if (result.current.state.status !== 'error') throw new Error('expected error');
    expect(result.current.state.error.message).toBe('boom');
  });

  it('retry triggers a refetch with the same entityId', async () => {
    mockList.mockResolvedValue({ data: [], nextCursor: null });
    const { result } = renderHook(() => useEntityLinkedNotes(9));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(mockList).toHaveBeenCalledTimes(1);
    result.current.retry();
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });
});
