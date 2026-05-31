import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { FieldStatus, type FieldStatusState } from './field-status';

// Same shape as the production messages — keep aria/body strings distinct
// so we can assert which branch fired.
const messages = {
  settings: {
    field_status: {
      saving: 'Saving',
      saved: 'Saved',
      pending_restart: 'Saved · restart',
      pending_restart_shadowed: 'Saved · restart · baseline diverged',
      error: 'Save failed: {message}',
      saving_aria: 'Saving {field}',
      saved_aria: 'Saved {field}',
      pending_restart_aria: 'Saved {field}, restart server',
      pending_restart_shadowed_aria: 'Saved {field}, baseline diverged',
      error_aria: '{field}: {message}',
    },
  },
};

const wrap = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );

describe('FieldStatus', () => {
  it('returns null for pristine state (no DOM)', () => {
    const { container } = wrap(<FieldStatus state="pristine" />);
    expect(container.firstChild).toBeNull();
  });

  it('saving state renders gp-field__status with aria-label including fieldName', () => {
    const { container } = wrap(<FieldStatus state="saving" fieldName="登录密码" />);
    const span = container.querySelector('[data-state="saving"]');
    expect(span?.getAttribute('aria-label')).toBe('Saving 登录密码');
    expect(span?.textContent).toContain('Saving');
  });

  it('saving aria falls back to plain text when fieldName is absent', () => {
    // Regression: prior versions interpolated `undefined` into the i18n
    // template producing literal "Saving undefined" — fallback now uses
    // the field-agnostic `saving` key.
    const { container } = wrap(<FieldStatus state="saving" />);
    const span = container.querySelector('[data-state="saving"]');
    expect(span?.getAttribute('aria-label')).toBe('Saving');
    expect(span?.getAttribute('aria-label')).not.toContain('undefined');
  });

  it('saved state renders saved aria + role=status', () => {
    const { container } = wrap(<FieldStatus state="saved" fieldName="X" />);
    const span = container.querySelector('[data-state="saved"]');
    expect(span?.getAttribute('role')).toBe('status');
    expect(span?.getAttribute('aria-label')).toBe('Saved X');
  });

  it('pending-restart without baselineDiffers uses generic aria', () => {
    const { container } = wrap(<FieldStatus state="pending-restart" fieldName="登录密码" />);
    const span = container.querySelector('[data-state="pending-restart"]');
    expect(span?.textContent).toContain('Saved · restart');
    expect(span?.getAttribute('aria-label')).toBe('Saved 登录密码, restart server');
  });

  it('pending-restart WITH baselineDiffers uses shadowed aria + body', () => {
    // Both visible text AND aria-label must take the shadowed branch so
    // screen-reader users hear "baseline diverged" not the generic
    // "restart server" copy.
    const { container } = wrap(
      <FieldStatus state="pending-restart" fieldName="登录密码" baselineDiffers />,
    );
    const span = container.querySelector('[data-state="pending-restart"]');
    expect(span?.textContent).toContain('baseline diverged');
    expect(span?.getAttribute('aria-label')).toBe('Saved 登录密码, baseline diverged');
  });

  it('pending-restart aria falls back to body text when fieldName is absent', () => {
    const { container } = wrap(<FieldStatus state="pending-restart" baselineDiffers />);
    const span = container.querySelector('[data-state="pending-restart"]');
    expect(span?.getAttribute('aria-label')).toBe('Saved · restart · baseline diverged');
  });

  it('error state uses role=alert and includes server message in aria', () => {
    const { container } = wrap(
      <FieldStatus state="error" error="DNS resolution failed" fieldName="X" />,
    );
    const span = container.querySelector('[data-state="error"]');
    expect(span?.getAttribute('role')).toBe('alert');
    expect(span?.getAttribute('aria-label')).toBe('X: DNS resolution failed');
    expect(span?.textContent).toContain('DNS resolution failed');
  });

  it('error state without fieldName still includes message in aria', () => {
    const { container } = wrap(<FieldStatus state="error" error="boom" />);
    const span = container.querySelector('[data-state="error"]');
    expect(span?.getAttribute('aria-label')).toBe('Save failed: boom');
  });

  it.each<FieldStatusState>([
    'saving',
    'saved',
    'pending-restart',
    'error',
  ])('%s state never leaks literal "undefined" into aria-label', (state) => {
    const { container } = wrap(<FieldStatus state={state} error={state === 'error' ? '' : null} />);
    const span = container.querySelector('span');
    expect(span?.getAttribute('aria-label')).not.toContain('undefined');
  });
});
