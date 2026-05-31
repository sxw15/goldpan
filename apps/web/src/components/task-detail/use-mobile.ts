'use client';

import { useEffect, useState } from 'react';

const MOBILE_BREAKPOINT = 720;

/** Detect viewport <= 720px to render mobile-specific layout/behavior. */
export function useMobile(): boolean {
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  return mobile;
}
