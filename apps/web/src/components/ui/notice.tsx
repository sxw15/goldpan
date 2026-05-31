'use client';

import type { ReactNode } from 'react';

export function Notice({
  kind = 'info',
  icon,
  heading,
  children,
  trailing,
  className,
}: {
  kind?: 'info' | 'warn' | 'ok';
  icon?: ReactNode;
  heading?: ReactNode;
  children?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`gp-notice gp-notice--${kind}${className ? ` ${className}` : ''}`}>
      {icon ? <span className="gp-notice__icon">{icon}</span> : null}
      <div className="gp-notice__body">
        {heading ? <div className="gp-notice__title">{heading}</div> : null}
        {children}
      </div>
      {trailing ? <div className="gp-notice__trailing">{trailing}</div> : null}
    </div>
  );
}
