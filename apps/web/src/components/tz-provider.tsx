'use client';

import { createContext, type ReactNode, useContext } from 'react';

const TzContext = createContext<string>('UTC');

export function TzProvider({ tz, children }: { tz: string; children: ReactNode }) {
  return <TzContext.Provider value={tz}>{children}</TzContext.Provider>;
}

/**
 * Hook to read the effective timezone. Defaults to 'UTC' if used outside a
 * TzProvider — should only happen in tests or error pages where the Context
 * tree didn't mount.
 */
export function useTz(): string {
  return useContext(TzContext);
}
