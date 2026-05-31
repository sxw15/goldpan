'use client';

import { Eye, EyeOff } from 'lucide-react';

interface PasswordInputProps {
  value: string;
  onChange: (v: string) => void;
  visible: boolean;
  onToggleVisible: () => void;
  invalid?: boolean;
  showAriaLabel: string;
  hideAriaLabel: string;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  id?: string;
  /** Disable the input AND visibility toggle. Wire this to a parent's
   * "saving in flight" state so the user can't keep typing while the
   * commit is being applied — without this, the click handler captures
   * the password at save-time, but a slow-returning server lets the
   * user type a NEW value that's silently discarded when exitEdit
   * clears the form on success. */
  disabled?: boolean;
}

export function PasswordInput({
  value,
  onChange,
  visible,
  onToggleVisible,
  invalid,
  showAriaLabel,
  hideAriaLabel,
  placeholder,
  autoFocus,
  className,
  id,
  disabled,
}: PasswordInputProps) {
  return (
    <div className="gp-pw-wrap">
      <input
        id={id}
        // biome-ignore lint/a11y/noAutofocus: caller opts in only when input is rendered on edit entry
        autoFocus={autoFocus}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
        aria-invalid={invalid || undefined}
        disabled={disabled}
        className={className}
      />
      <button
        type="button"
        className="gp-pw-toggle"
        onClick={onToggleVisible}
        disabled={disabled}
        aria-label={visible ? hideAriaLabel : showAriaLabel}
        aria-pressed={visible}
      >
        {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </button>
    </div>
  );
}
