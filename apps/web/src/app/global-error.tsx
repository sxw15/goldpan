'use client';

import { useEffect } from 'react';

// Global error boundary for root layout failures.
// Uses hardcoded bilingual strings (same rationale as error.tsx):
// i18n providers may be unavailable when this renders.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error:', error);
  }, [error]);

  return (
    <html lang={process.env.GOLDPAN_LANGUAGE ?? 'en'}>
      <body>
        <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
          <h2>Something went wrong / 出现错误</h2>
          <p style={{ color: '#666', marginTop: '0.5rem' }}>
            An unexpected error occurred. Please try again.
            <br />
            发生了意外错误，请重试。
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1rem',
              cursor: 'pointer',
              borderRadius: '4px',
              border: '1px solid #ccc',
              background: '#f5f5f5',
            }}
          >
            Try again / 重试
          </button>
        </div>
      </body>
    </html>
  );
}
