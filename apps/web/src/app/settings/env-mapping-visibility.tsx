'use client';

import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

const STORAGE_KEY = 'goldpan_show_env_mapping';

const EnvMappingVisibilityContext = createContext<boolean>(false);

export function EnvMappingVisibilityProvider({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  return (
    <EnvMappingVisibilityContext.Provider value={visible}>
      {children}
    </EnvMappingVisibilityContext.Provider>
  );
}

export function useEnvMappingVisible(): boolean {
  return useContext(EnvMappingVisibilityContext);
}

export function useEnvMappingVisibilityState(): {
  visible: boolean;
  toggle: () => void;
} {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setVisible(window.localStorage.getItem(STORAGE_KEY) === '1');
  }, []);

  const toggle = () => {
    setVisible((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      }
      return next;
    });
  };

  return { visible, toggle };
}
