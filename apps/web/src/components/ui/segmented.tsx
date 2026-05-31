'use client';

import type { ReactNode } from 'react';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="gp-segmented">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="gp-segmented__btn"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
