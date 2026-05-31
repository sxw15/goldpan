import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { InspectorPayload } from './payloads/types';
import { useInspectorStack } from './use-inspector-stack';

const E1: InspectorPayload = { kind: 'entity', id: 1 };
const E2: InspectorPayload = { kind: 'entity', id: 2 };
const E3: InspectorPayload = { kind: 'entity', id: 3 };

describe('useInspectorStack', () => {
  it('returns null current + null previous for initial=null', () => {
    const { result } = renderHook(() => useInspectorStack(null));
    expect(result.current.current).toBeNull();
    expect(result.current.previous).toBeNull();
  });

  it('initializes current from initial payload, previous null', () => {
    const { result } = renderHook(() => useInspectorStack(E1));
    expect(result.current.current).toEqual({ payload: E1 });
    expect(result.current.previous).toBeNull();
  });

  it('push snapshots current to previous and replaces current', () => {
    const { result } = renderHook(() => useInspectorStack(E1));
    act(() => {
      result.current.push(E2);
    });
    expect(result.current.current?.payload).toEqual(E2);
    expect(result.current.previous?.payload).toEqual(E1);
  });

  it('pop restores previous to current and clears previous', () => {
    const { result } = renderHook(() => useInspectorStack(E1));
    act(() => {
      result.current.push(E2);
    });
    act(() => {
      result.current.pop();
    });
    expect(result.current.current?.payload).toEqual(E1);
    expect(result.current.previous).toBeNull();
  });

  it('third push drops original previous (depth=1 fixed)', () => {
    const { result } = renderHook(() => useInspectorStack(E1));
    act(() => {
      result.current.push(E2);
    });
    act(() => {
      result.current.push(E3);
    });
    // current=E3, previous=E2 (E1 dropped)
    expect(result.current.current?.payload).toEqual(E3);
    expect(result.current.previous?.payload).toEqual(E2);
  });

  it('setCurrentTitle writes title only to current entry', () => {
    const { result } = renderHook(() => useInspectorStack(E1));
    act(() => {
      result.current.setCurrentTitle('Entity 1');
    });
    expect(result.current.current?.title).toBe('Entity 1');
    act(() => {
      result.current.push(E2);
    });
    // After push: previous carries E1 + its title, current has no title yet
    expect(result.current.previous?.title).toBe('Entity 1');
    expect(result.current.current?.title).toBeUndefined();
  });

  it('resets stack when initial payload changes', () => {
    const { result, rerender } = renderHook(
      ({ p }: { p: InspectorPayload | null }) => useInspectorStack(p),
      {
        initialProps: { p: E1 },
      },
    );
    act(() => {
      result.current.push(E2);
    });
    expect(result.current.previous?.payload).toEqual(E1);
    rerender({ p: E3 });
    expect(result.current.current?.payload).toEqual(E3);
    expect(result.current.previous).toBeNull();
  });
});
