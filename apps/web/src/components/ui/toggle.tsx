'use client';

export function Toggle({
  on,
  onChange,
  disabled,
  ariaLabel,
}: {
  on: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  /** Optional accessible name. Required for icon-only toggles so screen
   * readers (and tests) can identify what the toggle controls. */
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className="gp-toggle"
      data-on={on ? '1' : '0'}
      disabled={disabled}
      aria-pressed={on}
      aria-label={ariaLabel}
      onClick={() => {
        if (!disabled) onChange?.(!on);
      }}
    >
      <i />
    </button>
  );
}
