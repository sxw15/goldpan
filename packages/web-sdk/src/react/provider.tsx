// packages/web-sdk/src/react/provider.tsx
import { createContext, type ReactNode, useContext } from 'react';
import type { GoldpanClient } from '../client';

const GoldpanContext = createContext<GoldpanClient | null>(null);

export interface GoldpanProviderProps {
  client: GoldpanClient;
  children: ReactNode;
}

export function GoldpanProvider({ client, children }: GoldpanProviderProps) {
  return <GoldpanContext.Provider value={client}>{children}</GoldpanContext.Provider>;
}

export function useGoldpanClient(): GoldpanClient {
  const client = useContext(GoldpanContext);
  if (!client) {
    throw new Error('useGoldpanClient must be used within a GoldpanProvider');
  }
  return client;
}
