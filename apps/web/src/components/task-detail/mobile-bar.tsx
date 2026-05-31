'use client';

import type { ReactNode } from 'react';

interface MobileBarProps {
  children: ReactNode;
}

export function MobileBar({ children }: MobileBarProps) {
  return <div className="gp-td-mobile-bar">{children}</div>;
}
