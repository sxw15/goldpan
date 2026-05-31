import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock next/navigation before importing hook
const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();
const mockPathname = '/library';

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => mockPathname,
}));

import { useInspectorUrlSync } from './use-inspector-url-sync';

// Module-level readonly constants — spec §5.1 "调用侧纪律":
// allowedKinds must be stable identity across renders, inline literals break memo deps.
const ALLOWED = ['entity'] as const;
const ALLOWED_MULTI = ['entity', 'source'] as const;
const ALLOWED_LIBRARY = ['entity', 'source'] as const;
const ALLOWED_TRACKING = ['interest'] as const;

describe('useInspectorUrlSync', () => {
  beforeEach(() => {
    mockReplace.mockReset();
    mockSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns null payload when ?focus absent', () => {
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED));
    expect(result.current.payload).toBeNull();
  });

  it('returns entity payload when ?focus=42 present', () => {
    mockSearchParams = new URLSearchParams('focus=42');
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED));
    expect(result.current.payload).toEqual({ kind: 'entity', id: 42 });
  });

  it('returns null when ?focus is invalid (non-positive-int)', () => {
    mockSearchParams = new URLSearchParams('focus=abc');
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED));
    expect(result.current.payload).toBeNull();
  });

  it('open({kind:entity,id:7}) calls router.replace with ?focus=<id>', () => {
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED));
    act(() => {
      result.current.open({ kind: 'entity', id: 7 });
    });
    expect(mockReplace).toHaveBeenCalledWith('/library?focus=7');
  });

  it('close() calls router.replace without focus param', () => {
    mockSearchParams = new URLSearchParams('focus=42&other=x');
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED));
    act(() => {
      result.current.close();
    });
    expect(mockReplace).toHaveBeenCalledWith('/library?other=x');
  });

  it('close() with no other params calls router.replace with pathname only', () => {
    mockSearchParams = new URLSearchParams('focus=42');
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED));
    act(() => {
      result.current.close();
    });
    expect(mockReplace).toHaveBeenCalledWith('/library');
  });
});

describe('useInspectorUrlSync multi-kind', () => {
  beforeEach(() => {
    mockReplace.mockReset();
    mockSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('parses ?focus=42 without kind → payload.kind = first allowed kind (entity)', () => {
    mockSearchParams = new URLSearchParams('focus=42');
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED_MULTI));
    expect(result.current.payload).toEqual({ kind: 'entity', id: 42 });
  });

  it('parses ?focus=42&kind=source → payload.kind = source', () => {
    mockSearchParams = new URLSearchParams('focus=42&kind=source');
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED_MULTI));
    expect(result.current.payload).toEqual({ kind: 'source', id: 42 });
  });

  it('falls back to first allowed kind when kind param is not in allowed list', () => {
    mockSearchParams = new URLSearchParams('focus=42&kind=garbage');
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED_MULTI));
    expect(result.current.payload).toEqual({ kind: 'entity', id: 42 });
  });

  it('open({kind:source, id:7}) writes ?focus=7&kind=source', () => {
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED_MULTI));
    act(() => {
      result.current.open({ kind: 'source', id: 7 });
    });
    expect(mockReplace).toHaveBeenCalledWith('/library?focus=7&kind=source');
  });

  it('open({kind:entity, id:7}) writes ?focus=7 (omits kind when first allowed)', () => {
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED_MULTI));
    act(() => {
      result.current.open({ kind: 'entity', id: 7 });
    });
    expect(mockReplace).toHaveBeenCalledWith('/library?focus=7');
  });
});

// --- Spec §5.4: Library 3-kind + Tracking 1-kind coverage (T9) ---

describe('useInspectorUrlSync §5.4 library / tracking kind matrix', () => {
  beforeEach(() => {
    mockReplace.mockReset();
    mockSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('allowed=["entity","source"] + ?focus=42&kind=source → payload.kind="source"', () => {
    mockSearchParams = new URLSearchParams('focus=42&kind=source');
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED_LIBRARY));
    expect(result.current.payload).toEqual({ kind: 'source', id: 42 });
  });

  it('allowed=["entity","source"] + legacy ?kind=note → payload.kind="source"', () => {
    mockSearchParams = new URLSearchParams('focus=42&kind=note');
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED_LIBRARY));
    expect(result.current.payload).toEqual({ kind: 'source', id: 42 });
  });

  it('allowed=["interest"] + ?focus=42 → payload.kind="interest" (sole allowed → default)', () => {
    mockSearchParams = new URLSearchParams('focus=42');
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED_TRACKING));
    expect(result.current.payload).toEqual({ kind: 'interest', id: 42 });
  });

  it('allowed=["interest"] + ?focus=42&kind=entity → fallback to interest (not whitelisted)', () => {
    mockSearchParams = new URLSearchParams('focus=42&kind=entity');
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED_TRACKING));
    expect(result.current.payload).toEqual({ kind: 'interest', id: 42 });
  });

  it('open({kind:"source",id:7}) with allowed=["entity","source"] → URL=?focus=7&kind=source', () => {
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED_LIBRARY));
    act(() => {
      result.current.open({ kind: 'source', id: 7 });
    });
    expect(mockReplace).toHaveBeenCalledWith('/library?focus=7&kind=source');
  });

  it('open({kind:"entity",id:7}) with allowed=["entity","source"] → URL=?focus=7 (first kind omitted)', () => {
    const { result } = renderHook(() => useInspectorUrlSync(ALLOWED_LIBRARY));
    act(() => {
      result.current.open({ kind: 'entity', id: 7 });
    });
    expect(mockReplace).toHaveBeenCalledWith('/library?focus=7');
  });
});
