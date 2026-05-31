'use client';

import type { ReactNode } from 'react';

export type BtnKind = 'primary' | 'secondary' | 'danger' | 'ghost' | undefined;

export function Btn({
  kind,
  sm,
  children,
  onClick,
  onMouseDown,
  disabled,
  type,
  className,
  title,
  'aria-describedby': ariaDescribedBy,
}: {
  kind?: BtnKind;
  sm?: boolean;
  children: ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /**
   * Forwarded to the underlying <button>. The main use is `e.preventDefault()`
   * to stop the button from stealing focus on mousedown — see Modal's footer,
   * where letting the press blur a focused field would mis-order the field's
   * blur-commit against the button's click.
   */
  onMouseDown?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
  title?: string;
  'aria-describedby'?: string;
}) {
  const cn = ['gp-btn', className ?? ''].filter(Boolean).join(' ');
  return (
    <button
      type={type ?? 'button'}
      className={cn}
      data-variant={kind ?? 'secondary'}
      data-size={sm ? 'sm' : 'md'}
      disabled={disabled}
      title={title}
      aria-describedby={ariaDescribedBy}
      onClick={onClick}
      onMouseDown={onMouseDown}
    >
      {children}
    </button>
  );
}
