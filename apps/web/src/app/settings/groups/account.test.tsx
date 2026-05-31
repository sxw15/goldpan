import type { CommitEnvResult, EnvKeyState } from '@goldpan/web-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import type { GroupProps } from '../settings-shell';
import { GroupAccount } from './account';

// Trim messages — only what account.tsx + descendants actually read.
// If the test throws "MISSING_MESSAGE", add the missing key here.
const messages = {
  settings: {
    a11y: {
      password_placeholder: 'Enter password',
      modal_close: 'Close dialog',
    },
    actions: {
      reset: 'Reset',
      reset_in_progress: 'Resetting...',
      reset_hint: 'Reset to default',
      reset_failed_inline: 'Reset failed — override still active',
    },
    account: {
      crumb: 'Account',
      heading: 'Account & Security',
      desc: 'Login password and SSRF settings',
      card_login: 'Login',
      field_password_label: 'Login Password',
      field_password_hint: 'Restart required after save',
      fill_button: 'Fill',
      refill_button: 'Change',
      cancel_button: 'Cancel',
      save_button: 'Save',
      saving_button: 'Saving…',
      password_show_aria: 'Show password',
      password_hide_aria: 'Hide password',
      password_too_short: 'At least 8 characters',
      password_mismatch: 'Passwords do not match',
      password_confirm_label: 'Confirm Password',
      password_configured: '[Set]',
      value_unconfigured: '[Not set]',
      card_ssrf_heading: 'Outbound URL Safety',
      card_ssrf_sub: 'Validate before fetch',
      field_ssrf_label: 'SSRF Validation',
      field_ssrf_hint: 'Restart required after save',
      ssrf_on_label: 'Enabled',
      ssrf_off_label: 'Disabled',
      ssrf_on_info_heading: 'SSRF on',
      ssrf_on_info_body: 'Private network blocked',
      ssrf_on_info_why: 'Why?',
      ssrf_on_info_why_body: 'Prevents SSRF',
      ssrf_off_warn_heading: 'SSRF off',
      ssrf_off_warn_body: 'Public deployment risk',
      reset_modal_heading: 'Reset login password?',
      reset_modal_body_clear: 'Resetting clears the current password.',
      reset_modal_body_restart: 'Confirming will restart the server.',
      reset_modal_body_security_warn: 'Anyone can reach this instance after restart.',
      reset_modal_confirm_button: 'Reset and restart',
      reset_modal_cancel_button: 'Cancel',
      reset_modal_close_button: 'Close',
      reset_modal_resetting_button: 'Resetting…',
      reset_modal_restarting_button: 'Restarting…',
      reset_modal_status_resetting: 'Clearing the password…',
      reset_modal_status_restarting: 'Password cleared. Restarting…',
      reset_error_network: 'Network error.',
      reset_error_unknown: 'Reset failed.',
      reset_error_with_detail: 'Reset failed: {message}',
      restart_error_timeout: 'Server did not return within 30s.',
      restart_error_unknown: 'Restart failed.',
      restart_error_with_detail: 'Restart failed: {message}',
    },
    field_status: {
      saving: 'Saving',
      saved: 'Saved',
      pending_restart: 'Saved · restart',
      pending_restart_shadowed: 'Saved · restart · .env diverged',
      error: 'Save failed: {message}',
      saving_aria: 'Saving {field}',
      saved_aria: 'Saved {field}',
      pending_restart_aria: 'Saved {field}',
      error_aria: '{field}: {message}',
    },
    shell: {
      readonly_badge: 'read-only',
    },
  },
};

function makeEnv(items: Partial<EnvKeyState>[]): ReadonlyMap<string, EnvKeyState> {
  const m = new Map<string, EnvKeyState>();
  for (const item of items) {
    m.set(
      item.key as string,
      {
        key: item.key as string,
        mask: item.mask ?? '',
        source: item.source ?? 'default',
        configured: item.configured ?? false,
        baselineDiffers: item.baselineDiffers ?? false,
      } as EnvKeyState,
    );
  }
  return m;
}

// Default helper return — `{ kind: 'success' }` means the helper would have
// reloaded the page in real code. Tests that care about post-call UI assert
// on the modal closing transition; tests that only care about the call
// itself don't need to mock anything specific.
type ResetAndRestartResult = Awaited<ReturnType<GroupProps['resetEnvKeyAndRestart']>>;

function renderAccount(
  overrides: {
    env?: ReadonlyMap<string, EnvKeyState>;
    commit?: (p: Record<string, string | null>) => Promise<CommitEnvResult>;
    resetEnvKey?: (k: string) => Promise<boolean>;
    resetEnvKeyAndRestart?: GroupProps['resetEnvKeyAndRestart'];
  } = {},
) {
  const env =
    overrides.env ??
    makeEnv([
      { key: 'GOLDPAN_SSRF_VALIDATION_ENABLED', mask: 'false', source: 'default' },
      { key: 'GOLDPAN_AUTH_PASSWORD', mask: '', source: 'default', configured: false },
    ]);
  const commit =
    overrides.commit ??
    vi.fn().mockResolvedValue({
      kind: 'ok' as const,
      updatedItems: [],
      pendingRestartKeys: [],
    });
  // Default mock returns `true` (reset persisted) so callers that test
  // success-path side-effects don't have to override; failure-path tests
  // pass `vi.fn(async () => false)` explicitly. Still wired in for the SSRF
  // row, which keeps using the simple `resetEnvKey` path.
  const resetEnvKey = overrides.resetEnvKey ?? vi.fn(async () => true);
  // Password reset goes through the bundled reset+restart helper. Default
  // mock returns success (the real helper would window.location.reload here).
  // Tests that exercise reset/restart failure branches pass their own mock.
  const resetEnvKeyAndRestart =
    overrides.resetEnvKeyAndRestart ??
    (vi.fn(
      async () => ({ kind: 'success' }) as ResetAndRestartResult,
    ) as GroupProps['resetEnvKeyAndRestart']);

  // Build a minimal GroupProps. Some fields are unused by account but
  // required by the union type.
  const props = {
    env,
    dirty: {},
    patch: vi.fn(),
    applyEnvItems: vi.fn(),
    reset: vi.fn(),
    resetEnvKey,
    resetEnvKeyAndRestart,
    save: vi.fn(),
    commit,
    mock: {} as never,
    updateMock: vi.fn(),
    toast: vi.fn(),
    navigateToGroup: vi.fn(),
    setFieldEditing: vi.fn(),
  };

  // `mock` (SettingsMockSlice) is unused by account.tsx, so elide it via an
  // `unknown`-bounce cast to GroupProps rather than build a full SettingsMockSlice.
  const utils = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <GroupAccount {...(props as unknown as GroupProps)} />
    </NextIntlClientProvider>,
  );
  return { ...utils, commit, resetEnvKey, resetEnvKeyAndRestart };
}

// Toggle is rendered with ariaLabel={t('field_ssrf_label')} → DOM gets
// aria-label="SSRF Validation". Query by accessible name (not class) so
// the test doesn't break if .gp-toggle is renamed or a second toggle is
// added later.
function getToggle(): HTMLElement {
  return screen.getByRole('button', { name: 'SSRF Validation' });
}

describe('GroupAccount — SSRF toggle (instant commit)', () => {
  it('toggle change fires commit with normalized value', async () => {
    const { commit } = renderAccount();
    fireEvent.click(getToggle());
    await waitFor(() => {
      expect(commit).toHaveBeenCalledWith({ GOLDPAN_SSRF_VALIDATION_ENABLED: 'true' });
    });
  });

  it('shows pending-restart status after commit with restart key', async () => {
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok' as const,
      updatedItems: [],
      pendingRestartKeys: ['GOLDPAN_SSRF_VALIDATION_ENABLED'],
    });
    renderAccount({ commit });
    fireEvent.click(getToggle());
    await waitFor(() => {
      expect(screen.getByText(/Saved · restart/i)).toBeInTheDocument();
    });
  });

  it('shows error status on commit failure', async () => {
    const commit = vi.fn().mockResolvedValue({
      kind: 'errors' as const,
      errors: [{ path: 'GOLDPAN_SSRF_VALIDATION_ENABLED', message: 'forbidden in cloud' }],
    });
    renderAccount({ commit });
    fireEvent.click(getToggle());
    await waitFor(() => {
      expect(screen.getByText(/forbidden in cloud/i)).toBeInTheDocument();
    });
  });
});

describe('GroupAccount — password (explicit save)', () => {
  it('entering password + confirm + save fires commit', async () => {
    const { commit } = renderAccount();
    fireEvent.click(screen.getByText('Fill'));
    const inputs = screen.getAllByPlaceholderText('Enter password');
    fireEvent.change(inputs[0], { target: { value: 'verysecret' } });
    // Confirm uses a label
    const confirmInput = screen.getByLabelText('Confirm Password');
    fireEvent.change(confirmInput, { target: { value: 'verysecret' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(commit).toHaveBeenCalledWith({ GOLDPAN_AUTH_PASSWORD: 'verysecret' });
    });
  });

  it('save button disabled when passwords too short', () => {
    renderAccount();
    fireEvent.click(screen.getByText('Fill'));
    const inputs = screen.getAllByPlaceholderText('Enter password');
    fireEvent.change(inputs[0], { target: { value: 'short' } });
    const confirmInput = screen.getByLabelText('Confirm Password');
    fireEvent.change(confirmInput, { target: { value: 'short' } });
    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('save button disabled when passwords mismatch', () => {
    renderAccount();
    fireEvent.click(screen.getByText('Fill'));
    const inputs = screen.getAllByPlaceholderText('Enter password');
    fireEvent.change(inputs[0], { target: { value: 'verysecret' } });
    const confirmInput = screen.getByLabelText('Confirm Password');
    fireEvent.change(confirmInput, { target: { value: 'different8' } });
    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('retry success after failed save does NOT wipe pending-restart status (#3315029117)', async () => {
    // Regression for the captured-closure bug: when the first save fails,
    // pwdCommit.state becomes 'error' and the next render of the Save
    // button's onClick handler captures a `pwdCommit.cancel` closure with
    // state='error'. When the user retries and the second save succeeds
    // (-> 'saved' / 'pending-restart'), exitEdit() used to call
    // pwdCommit.cancel(), and the captured closure ran the
    // `if (state === 'error') setState('pristine')` branch — erasing the
    // success indicator the hook had just set. The fix is exitEdit(true)
    // on save-success: skip cancel(), only clear the local form inputs.
    const commit = vi
      .fn()
      // 1st attempt: server rejects → state='error'.
      .mockResolvedValueOnce({
        kind: 'errors' as const,
        errors: [{ path: 'GOLDPAN_AUTH_PASSWORD', message: 'too weak' }],
      })
      // 2nd attempt: server accepts with a pending-restart key → state
      // should be 'pending-restart' after the retry.
      .mockResolvedValueOnce({
        kind: 'ok' as const,
        updatedItems: [],
        pendingRestartKeys: ['GOLDPAN_AUTH_PASSWORD'],
      });
    renderAccount({ commit });
    fireEvent.click(screen.getByText('Fill'));
    const inputs = screen.getAllByPlaceholderText('Enter password');
    fireEvent.change(inputs[0], { target: { value: 'verysecret' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'verysecret' },
    });
    fireEvent.click(screen.getByText('Save'));
    // First attempt: error visible inline.
    await waitFor(() => expect(screen.getByText(/too weak/i)).toBeInTheDocument());
    // Retry: change password to satisfy server, click Save again.
    const refreshedInputs = screen.getAllByPlaceholderText('Enter password');
    fireEvent.change(refreshedInputs[0], { target: { value: 'differentlonger' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'differentlonger' },
    });
    fireEvent.click(screen.getByText('Save'));
    // After retry success: edit form closed, "Saved · restart" indicator
    // must remain — without the fix, cancel() would have flipped state
    // back to 'pristine' and the indicator would be gone.
    await waitFor(() => {
      expect(screen.getByText(/Saved · restart/i)).toBeInTheDocument();
      // Edit form is closed — Save button gone, Fill / Change visible.
      expect(screen.queryByText('Save')).toBeNull();
    });
  });

  it('error state keeps edit form open', async () => {
    const commit = vi.fn().mockResolvedValue({
      kind: 'errors' as const,
      errors: [{ path: 'GOLDPAN_AUTH_PASSWORD', message: 'too weak' }],
    });
    renderAccount({ commit });
    fireEvent.click(screen.getByText('Fill'));
    const inputs = screen.getAllByPlaceholderText('Enter password');
    fireEvent.change(inputs[0], { target: { value: 'verysecret' } });
    const confirmInput = screen.getByLabelText('Confirm Password');
    fireEvent.change(confirmInput, { target: { value: 'verysecret' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      // Error visible
      expect(screen.getByText(/too weak/i)).toBeInTheDocument();
      // Form still open (confirm input still present)
      expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();
    });
  });
});

describe('GroupAccount — Reset button (resetEnvKey outcome branches)', () => {
  // Regression for the P2.4 + MED.7 contract: account.tsx must only call
  // `pwdCommit.clear()` / `ssrfCommit.clear()` when `resetEnvKey` returns
  // true. Without this guard, a server-rejected reset would still clear
  // the hook's state and leave the UI looking fresh while the override
  // actually stayed on disk.

  it('SSRF Reset success (true) → hook state clears (no FieldStatus row)', async () => {
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok' as const,
      updatedItems: [],
      // Push SSRF into the visible pending-restart state first so we can
      // tell whether clear() ran.
      pendingRestartKeys: ['GOLDPAN_SSRF_VALIDATION_ENABLED'],
    });
    const resetEnvKey = vi.fn(async () => true);
    renderAccount({
      env: makeEnv([
        // source='override' is required for the Reset button to render.
        {
          key: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
          mask: 'true',
          source: 'override',
          configured: true,
        },
        { key: 'GOLDPAN_AUTH_PASSWORD', mask: '', source: 'default', configured: false },
      ]),
      commit,
      resetEnvKey,
    });
    // Toggle to bring the hook into pending-restart (so FieldStatus renders).
    fireEvent.click(getToggle());
    await waitFor(() => {
      expect(screen.getByText(/Saved · restart/i)).toBeInTheDocument();
    });
    // Now click Reset.
    fireEvent.click(screen.getByText('Reset'));
    await waitFor(() => {
      expect(resetEnvKey).toHaveBeenCalledWith('GOLDPAN_SSRF_VALIDATION_ENABLED');
      // clear() should have run → state back to pristine → FieldStatus gone.
      expect(screen.queryByText(/Saved · restart/i)).toBeNull();
    });
  });

  it('SSRF Reset failure (false) → markError swaps FieldStatus to reset-failed indicator', async () => {
    // Mirror of the success test, but resetEnvKey returns false so
    // account.tsx must call ssrfCommit.markError(...) to flip FieldStatus
    // from the stale "Saved · restart" indicator into an error row. The
    // shell-level toast (mocked away here) is the transient failure
    // signal; FieldStatus has to carry the durable state so the user
    // doesn't read the row as "Reset succeeded" once the toast fades.
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok' as const,
      updatedItems: [],
      pendingRestartKeys: ['GOLDPAN_SSRF_VALIDATION_ENABLED'],
    });
    const resetEnvKey = vi.fn(async () => false);
    renderAccount({
      env: makeEnv([
        {
          key: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
          mask: 'true',
          source: 'override',
          configured: true,
        },
        { key: 'GOLDPAN_AUTH_PASSWORD', mask: '', source: 'default', configured: false },
      ]),
      commit,
      resetEnvKey,
    });
    fireEvent.click(getToggle());
    await waitFor(() => {
      expect(screen.getByText(/Saved · restart/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Reset'));
    await waitFor(() => {
      expect(resetEnvKey).toHaveBeenCalledWith('GOLDPAN_SSRF_VALIDATION_ENABLED');
      // markError flipped FieldStatus into 'error' state and rendered the
      // inline reset-failed message. The "Saved · restart" indicator must
      // be gone so the row no longer claims a successful state.
      expect(screen.getByText(/Reset failed — override still active/i)).toBeInTheDocument();
      expect(screen.queryByText(/Saved · restart/i)).toBeNull();
    });
  });

  // Password Reset goes through a confirm + restart modal instead of an
  // immediate resetEnvKey call. The flow:
  //   1. Click Reset → modal opens with security warning, no server call
  //   2. Click "Reset and restart" → resetEnvKeyAndRestart fires
  //   3. Helper result drives modal close (success → reload) or error
  //      modal (reset-failed / restart-failed)
  // These tests cover the gate (#1+2), the helper invocation contract, and
  // the two failure branches that diverge in how they treat pwdCommit
  // (markError vs clear) — the live code's only meaningful split.

  it('password Reset click opens confirm modal WITHOUT firing the helper', async () => {
    const { resetEnvKeyAndRestart } = renderAccount({
      env: makeEnv([
        { key: 'GOLDPAN_SSRF_VALIDATION_ENABLED', mask: 'false', source: 'default' },
        {
          key: 'GOLDPAN_AUTH_PASSWORD',
          mask: '',
          source: 'override',
          configured: true,
        },
      ]),
    });
    fireEvent.click(screen.getByText('Reset'));
    // Modal copy is visible — the dialog is the user's chance to back out
    // before the destructive action runs.
    expect(screen.getByText('Reset login password?')).toBeInTheDocument();
    expect(screen.getByText(/Resetting clears the current password/)).toBeInTheDocument();
    expect(screen.getByText(/Anyone can reach this instance after restart/)).toBeInTheDocument();
    // Helper has NOT been called yet — clicking Reset alone must not commit.
    expect(resetEnvKeyAndRestart).not.toHaveBeenCalled();
  });

  it('password Reset modal Cancel closes without calling the helper', async () => {
    const { resetEnvKeyAndRestart } = renderAccount({
      env: makeEnv([
        { key: 'GOLDPAN_SSRF_VALIDATION_ENABLED', mask: 'false', source: 'default' },
        {
          key: 'GOLDPAN_AUTH_PASSWORD',
          mask: '',
          source: 'override',
          configured: true,
        },
      ]),
    });
    fireEvent.click(screen.getByText('Reset'));
    expect(screen.getByText('Reset login password?')).toBeInTheDocument();
    // Modal Cancel button — Modal renders "Cancel" via cancelLabel.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByText('Reset login password?')).toBeNull();
    });
    expect(resetEnvKeyAndRestart).not.toHaveBeenCalled();
  });

  it('password Reset confirm fires resetEnvKeyAndRestart with the key', async () => {
    const { resetEnvKeyAndRestart } = renderAccount({
      env: makeEnv([
        { key: 'GOLDPAN_SSRF_VALIDATION_ENABLED', mask: 'false', source: 'default' },
        {
          key: 'GOLDPAN_AUTH_PASSWORD',
          mask: '',
          source: 'override',
          configured: true,
        },
      ]),
    });
    fireEvent.click(screen.getByText('Reset'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset and restart' }));
    await waitFor(() => {
      expect(resetEnvKeyAndRestart).toHaveBeenCalledWith(
        'GOLDPAN_AUTH_PASSWORD',
        expect.any(Function),
      );
    });
  });

  it('reset-failed → markError surfaces the reset-failed indicator + shows error modal', async () => {
    // Push pwdCommit into pending-restart first so the inline indicator
    // has something to lie about — markError must flip it to the
    // reset-failed message, mirroring the legacy behavior preserved for
    // the same regression class.
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok' as const,
      updatedItems: [],
      pendingRestartKeys: ['GOLDPAN_AUTH_PASSWORD'],
    });
    const resetEnvKeyAndRestart = vi.fn(
      async () =>
        ({
          kind: 'reset-failed',
          reason: 'errors',
          message: 'rejected by policy',
        }) as ResetAndRestartResult,
    ) as GroupProps['resetEnvKeyAndRestart'];
    renderAccount({
      env: makeEnv([
        { key: 'GOLDPAN_SSRF_VALIDATION_ENABLED', mask: 'false', source: 'default' },
        {
          key: 'GOLDPAN_AUTH_PASSWORD',
          mask: '',
          source: 'override',
          configured: true,
        },
      ]),
      commit,
      resetEnvKeyAndRestart,
    });
    // Drive pwdCommit into pending-restart so we can later assert that
    // the markError swapped the indicator (visible "Saved · restart"
    // disappears, "Reset failed — override still active" appears).
    fireEvent.click(screen.getByText('Change'));
    const inputs = screen.getAllByPlaceholderText('Enter password');
    fireEvent.change(inputs[0], { target: { value: 'verysecret' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'verysecret' },
    });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(screen.getByText(/Saved · restart/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Reset'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset and restart' }));
    await waitFor(() => {
      // Reset-failed error rendered inside the dialog body (helper passes
      // back the detail; modal interpolates via reset_error_with_detail).
      expect(screen.getByText(/Reset failed: rejected by policy/)).toBeInTheDocument();
      // markError flipped FieldStatus into 'error' → the "Saved · restart"
      // indicator is gone, the reset-failed message takes its place.
      expect(screen.getByText(/Reset failed — override still active/)).toBeInTheDocument();
      expect(screen.queryByText(/Saved · restart/)).toBeNull();
    });
  });

  it('restart-failed → pwdCommit.clear runs (password actually gone) + error modal shows', async () => {
    // Restart-failed is structurally different from reset-failed: the
    // commit DID land (override deleted) but the server didn't come
    // back. account.tsx must call pwdCommit.clear() — leaving the
    // "Saved · restart" indicator would mislead the user about the
    // current password state. The dialog still shows the restart
    // failure detail so the user can manually recover.
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok' as const,
      updatedItems: [],
      pendingRestartKeys: ['GOLDPAN_AUTH_PASSWORD'],
    });
    const resetEnvKeyAndRestart = vi.fn(
      async () =>
        ({
          kind: 'restart-failed',
          reason: 'timeout',
        }) as ResetAndRestartResult,
    ) as GroupProps['resetEnvKeyAndRestart'];
    renderAccount({
      env: makeEnv([
        { key: 'GOLDPAN_SSRF_VALIDATION_ENABLED', mask: 'false', source: 'default' },
        {
          key: 'GOLDPAN_AUTH_PASSWORD',
          mask: '',
          source: 'override',
          configured: true,
        },
      ]),
      commit,
      resetEnvKeyAndRestart,
    });
    fireEvent.click(screen.getByText('Change'));
    const inputs = screen.getAllByPlaceholderText('Enter password');
    fireEvent.change(inputs[0], { target: { value: 'verysecret' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'verysecret' },
    });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(screen.getByText(/Saved · restart/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Reset'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset and restart' }));
    await waitFor(() => {
      // Timeout copy from reset_modal: "Server did not return within 30s."
      expect(screen.getByText(/Server did not return within 30s/)).toBeInTheDocument();
      // pwdCommit.clear() ran → no stale "Saved · restart" remains.
      expect(screen.queryByText(/Saved · restart/)).toBeNull();
    });
  });
});
