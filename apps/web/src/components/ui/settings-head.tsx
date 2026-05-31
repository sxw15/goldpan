'use client';

import type { ReactNode } from 'react';

export function SettingsHead({
  crumb,
  heading,
  desc,
  right,
}: {
  crumb: string;
  heading: string;
  desc?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="gp-shead">
      <div className="gp-shead__main">
        <p className="gp-shead__crumb">{crumb}</p>
        <h1 className="gp-shead__title">{heading}</h1>
        {desc ? <p className="gp-shead__desc">{desc}</p> : null}
      </div>
      {right ? <div className="gp-shead__right">{right}</div> : null}
    </div>
  );
}
