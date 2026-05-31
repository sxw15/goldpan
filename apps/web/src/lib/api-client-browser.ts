'use client';

import { GoldpanClient } from '@goldpan/web-sdk';

let cached: GoldpanClient | null = null;

export function getBrowserApiClient(): GoldpanClient {
  if (!cached) {
    cached = new GoldpanClient({
      baseUrl: '/api',
      credentials: 'same-origin',
      onUnauthorized: () => {
        if (typeof window !== 'undefined') window.location.assign('/login');
      },
    });
  }
  return cached;
}
