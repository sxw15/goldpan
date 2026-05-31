import { useCallback, useEffect, useState } from 'react';
import type { InspectorPayload } from './payloads/types';

export interface StackEntry {
  payload: InspectorPayload;
  /** Payload 组件 fetch 到 detail 后通过 setCurrentTitle 回填 */
  title?: string;
}

interface StackState {
  current: StackEntry | null;
  previous: StackEntry | null;
}

export function useInspectorStack(initial: InspectorPayload | null) {
  const [stack, setStack] = useState<StackState>(() => ({
    current: initial ? { payload: initial } : null,
    previous: null,
  }));

  // 外部 payload 换了（新一次打开） → reset 整个栈。
  // 故意只依赖 kind + id，避免父组件每次 re-render 传入结构相等但引用不等的对象时无谓重置。
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — structural deps to avoid reference-identity thrashing
  useEffect(() => {
    setStack({
      current: initial ? { payload: initial } : null,
      previous: null,
    });
  }, [initial?.kind, initial?.id]);

  const setCurrentTitle = useCallback((title: string) => {
    setStack((s) => (s.current ? { ...s, current: { ...s.current, title } } : s));
  }, []);

  const push = useCallback((next: InspectorPayload) => {
    setStack((s) => ({ current: { payload: next }, previous: s.current }));
  }, []);

  const pop = useCallback(() => {
    setStack((s) => ({ current: s.previous, previous: null }));
  }, []);

  return {
    current: stack.current,
    previous: stack.previous,
    push,
    pop,
    setCurrentTitle,
  };
}
