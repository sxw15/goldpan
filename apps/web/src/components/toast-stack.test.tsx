import { act, render, renderHook, screen } from '@testing-library/react';
import { StrictMode, startTransition, useActionState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ToastStack, useToastStack } from './toast-stack';

describe('useToastStack auto-dismiss', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('dismisses after default 3500ms', () => {
    const { result } = renderHook(() => useToastStack());
    act(() => {
      result.current.api.push({ msg: 'hi' });
    });
    expect(result.current.toasts.length).toBe(1);
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.toasts.length).toBe(0);
  });

  test('multiple pushes each dismiss on their own timer', () => {
    const { result } = renderHook(() => useToastStack());
    act(() => {
      result.current.api.push({ msg: 'a' });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
      result.current.api.push({ msg: 'b' });
    });
    expect(result.current.toasts.length).toBe(2);
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(result.current.toasts.map((t) => t.msg)).toEqual(['b']);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.toasts.length).toBe(0);
  });

  test('toast pushed inside useActionState async reducer dismisses after ttl', async () => {
    function Harness() {
      const { toasts, api } = useToastStack();
      const [, action] = useActionState<{ ok?: boolean }, FormData>(async () => {
        api.push({ msg: 'from-action', kind: 'success' });
        return { ok: true };
      }, {});
      return (
        <>
          <button
            type="button"
            data-testid="trigger"
            onClick={() => {
              startTransition(() => action(new FormData()));
            }}
          >
            go
          </button>
          <ToastStack toasts={toasts} dismiss={api.dismiss} closeLabel="x" />
        </>
      );
    }
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    await act(async () => {
      screen.getByTestId('trigger').click();
    });
    expect(screen.queryAllByText('from-action').length).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(screen.queryByText('from-action')).toBeNull();
  });
});
