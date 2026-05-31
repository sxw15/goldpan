// SettingsField requires env / restart / readonly tag scaffolding the wizard
// has no use for; this primitive drops that and keeps just label + control + hint.
'use client';

import type { ReactNode } from 'react';

export function WizardField({
  label,
  hint,
  control,
  inline,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  control: ReactNode;
  /** Label sits to the left, control is right-aligned. Use for toggle / segmented fields. */
  inline?: boolean;
}) {
  const className = `gp-wfield${inline ? ' gp-wfield--inline' : ''}`;
  return (
    <div className={className}>
      {label ? <div className="gp-wfield__label">{label}</div> : null}
      {hint ? <p className="gp-wfield__hint">{hint}</p> : null}
      <div className="gp-wfield__control">{control}</div>
    </div>
  );
}
