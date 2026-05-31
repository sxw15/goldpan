'use client';

import { Children, type ReactNode } from 'react';

export function SettingsCard({
  heading,
  sub,
  right,
  children,
  padded,
}: {
  heading?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  padded?: boolean;
}) {
  const showBody =
    Boolean(padded) || (children != null && children !== false && Children.count(children) > 0);

  return (
    <div className="gp-scard">
      {(heading || right) && (
        <div className={`gp-scard__head${showBody ? '' : ' gp-scard__head--solo'}`}>
          <div>
            {heading ? <h3 className="gp-scard__title">{heading}</h3> : null}
            {sub ? <p className="gp-scard__sub">{sub}</p> : null}
          </div>
          {right}
        </div>
      )}
      {showBody ? (
        <div className={`gp-scard__body${padded ? ' gp-scard__body--padded' : ''}`}>{children}</div>
      ) : null}
    </div>
  );
}
