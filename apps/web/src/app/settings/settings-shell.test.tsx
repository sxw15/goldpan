import type { CommitEnvResult, EnvKeyState } from '@goldpan/web-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ThemeProvider } from '@/components/theme-provider';
import zh from '../../../messages/zh.json';

// `useSearchParams()` returns null when the component is rendered outside an
// `<AppRouterContext>` boundary — vitest's jsdom env has no Next.js router, so
// `settings-shell.tsx`'s `searchParams.get('group')` crashes on first render.
// Stub the hook with an empty `URLSearchParams` instance so `syncFromUrl`
// reads a valid object; `useRouter` is mocked alongside so future tests that
// add navigation assertions don't need to re-stub.
// `useSearchParams` is backed by a mutable hoisted ref so individual tests
// can drive the `?group=` query deep-link path (the production restart-tag
// entry point: /settings?group=about), not just the `#hash` path. Defaults
// to empty; afterEach resets it so the many tests that never touch the query
// string keep seeing a blank one.
const { searchParamsRef } = vi.hoisted(() => ({
  searchParamsRef: { current: new URLSearchParams() },
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsRef.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/settings',
  // rethrowNextErrors → unstable_rethrow. In tests it's a no-op (no Next
  // framework error path to honour); only real catches propagate redirects.
  unstable_rethrow: (_err: unknown) => undefined,
}));

const mockCommitEnv = vi.fn<(p: Record<string, string | null>) => Promise<CommitEnvResult>>();
vi.mock('./actions', async () => {
  const actual = await vi.importActual<typeof import('./actions')>('./actions');
  return { ...actual, commitEnv: (p: Record<string, string | null>) => mockCommitEnv(p) };
});

// Controllable performRestart so a test can hold the restart phase open and
// inspect the leave-guard while resetEnvKeyAndRestart is mid-restart. Default
// (ref null) falls through to the real helper, so tests that don't opt in are
// unaffected. afterEach resets it.
const { performRestartRef } = vi.hoisted(() => ({
  performRestartRef: {
    current: null as null | (() => Promise<{ ok: boolean; reason?: 'post_failed' | 'timeout' }>),
  },
}));
vi.mock('@/components/restart-panel/perform-restart', async () => {
  const actual = await vi.importActual<typeof import('@/components/restart-panel/perform-restart')>(
    '@/components/restart-panel/perform-restart',
  );
  return {
    ...actual,
    performRestart: (opts: { onPolling?: () => void; redirectTo?: string }) =>
      performRestartRef.current ? performRestartRef.current() : actual.performRestart(opts),
  };
});

import { SettingsShell } from './settings-shell';

const ENV_INITIAL: EnvKeyState[] = [
  { key: 'GOLDPAN_LANGUAGE', configured: true, source: 'env', mask: 'zh' },
  { key: 'OPENAI_API_KEY', configured: false, source: 'default', mask: '' },
  { key: 'TAVILY_API_KEY', configured: true, source: 'env', mask: '••••XXXX' },
];

function renderShell() {
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <ThemeProvider>
        <SettingsShell
          initialDigestEnabled={false}
          initialPresets={[]}
          initialEnvItems={ENV_INITIAL}
          envStateError={null}
          manifests={[]}
          contributions={[]}
          language="zh"
          initialPluginsSnapshot={{ plugins: [], registryInstallSupported: false }}
          pluginsError={null}
        />
      </ThemeProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  mockCommitEnv.mockReset();
});

afterEach(() => {
  // Clear per-tab firstSave flag so tests that depend on initial state
  // (modal triggers vs suppressed) don't cross-contaminate when vitest
  // runs files in a non-default order (e.g. `--shuffle` / `--isolate=false`).
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  searchParamsRef.current = new URLSearchParams();
  performRestartRef.current = null;
});

describe('SettingsShell · auto-commit flow', () => {
  // The legacy "click [保存] in SaveBar" tests were removed once every group
  // migrated to per-field auto-commit (toggles/selects fire commitEnv on
  // change; text inputs flush on blur via useEditableCommit). SaveBar is
  // still rendered behind `hasGroupDirty` but no live group writes to the
  // dirty store anymore, so it's effectively dead UI. The first-save and
  // pending-restart paths below still exercise the shell's commit pipeline
  // end-to-end via the auto-commit hooks.

  test('appearance language select auto-commits without a SaveBar click', async () => {
    mockCommitEnv.mockResolvedValueOnce({
      kind: 'ok',
      updatedItems: [{ key: 'GOLDPAN_LANGUAGE', configured: true, source: 'override', mask: 'en' }],
      pendingRestartKeys: [],
    });
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /外观与语言/ }));
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'en' } });
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalledWith({ GOLDPAN_LANGUAGE: 'en' }));
    // No SaveBar/保存 button appears — auto-commit landed the change directly.
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  test('auto-commit errors path surfaces a danger toast', async () => {
    // Replaces the legacy "errors shows toast and preserves dirty" SaveBar
    // test. Under auto-commit the toast is now the primary failure surface
    // for cross-field validation messages (FieldStatus carries the
    // own-key inline message, but a path-less error has no row to land in).
    mockCommitEnv.mockResolvedValueOnce({
      kind: 'errors',
      errors: [{ path: '', message: 'GOLDPAN_LANGUAGE: invalid value' }],
    });
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /外观与语言/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'en' } });
    await screen.findByText(/保存失败：GOLDPAN_LANGUAGE/);
  });

  test('auto-commit thrown error surfaces err.message in danger toast', async () => {
    // Replaces the legacy "thrown error shows danger toast with err.message"
    // SaveBar test. A network blip / 5xx during commit must not silently
    // strand the user — shell catches and toasts.
    mockCommitEnv.mockRejectedValueOnce(new Error('boom'));
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /外观与语言/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'en' } });
    // The per-field commit path uses the shorter `save_failed_toast`
    // ("保存失败") rather than save_errors_toast with detail — the per-field
    // FieldStatus already renders the detail inline via the hook, so
    // duplicating it in the toast adds noise.
    await screen.findByText('保存失败');
  });

  test('renders pending restart banner from initial health keys after reload', () => {
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <ThemeProvider>
          <SettingsShell
            initialDigestEnabled={false}
            initialPresets={[]}
            initialEnvItems={ENV_INITIAL}
            envStateError={null}
            manifests={[]}
            contributions={[]}
            language="zh"
            initialPluginsSnapshot={{ plugins: [], registryInstallSupported: false }}
            pluginsError={null}
            initialPendingRestartKeys={['GOLDPAN_LANGUAGE']}
          />
        </ThemeProvider>
      </NextIntlClientProvider>,
    );

    expect(screen.getByText(/还有 1 项配置需要 server 重启/)).toBeInTheDocument();
  });
});

describe('SettingsShell · restart-aware leave guard', () => {
  test('reset+restart releases the in-flight key before performRestart, so the restart reload is not leave-guarded', async () => {
    // resetEnvKeyAndRestart commits {AUTH_PASSWORD: null} then calls
    // performRestart, which ends in window.location.reload(). If the key stayed
    // `in-flight` across performRestart, `hasInFlight` would keep the unsaved-
    // edit beforeunload guard armed and that reload would trip it — a spurious
    // "Leave site?" prompt on an action the user explicitly initiated (and a
    // "Stay" click would strand them on a stale page pointing at an already-
    // restarted server). The fix releases in-flight right after the commit,
    // BEFORE performRestart, so the guard stands down for the restart reload.
    //
    // We assert the transition: armed DURING the commit (in-flight), disarmed
    // DURING the restart (in-flight released). Old code that held in-flight
    // across performRestart would keep the guard armed in phase 2.
    let resolveCommit!: (v: CommitEnvResult) => void;
    mockCommitEnv.mockImplementationOnce(
      () =>
        new Promise<CommitEnvResult>((r) => {
          resolveCommit = r;
        }),
    );
    // Hold the restart phase open so we can probe the guard while it's running.
    performRestartRef.current = () => new Promise(() => {});
    sessionStorage.setItem('goldpan_first_save_seen', '1');
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <ThemeProvider>
          <SettingsShell
            initialDigestEnabled={false}
            initialPresets={[]}
            initialEnvItems={[
              ...ENV_INITIAL,
              {
                key: 'GOLDPAN_AUTH_PASSWORD',
                configured: true,
                source: 'override',
                mask: '••••3456',
              },
            ]}
            envStateError={null}
            manifests={[]}
            contributions={[]}
            language="zh"
            initialPluginsSnapshot={{ plugins: [], registryInstallSupported: false }}
            pluginsError={null}
          />
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /账户与安全/ }));
    // Open the destructive reset confirm dialog, then confirm → reset+restart.
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    fireEvent.click(await screen.findByRole('button', { name: '重置并重启' }));

    // Phase 1 — the reset commit is in-flight: the guard is armed.
    await waitFor(() =>
      expect(mockCommitEnv).toHaveBeenCalledWith({ GOLDPAN_AUTH_PASSWORD: null }),
    );
    await waitFor(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
    });

    // Resolve the commit → the flow releases in-flight, then enters
    // performRestart (held pending above).
    resolveCommit({
      kind: 'ok',
      updatedItems: [
        { key: 'GOLDPAN_AUTH_PASSWORD', configured: false, source: 'default', mask: '' },
      ],
      pendingRestartKeys: ['GOLDPAN_AUTH_PASSWORD'],
    });

    // Phase 2 — performRestart is in-flight but the key is no longer in-flight:
    // the guard stands down, so its reload won't pop a spurious prompt.
    await waitFor(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    });
  });
});

describe('SettingsShell · cross-group dirty', () => {
  test('leave modal triggers when SSRF auto-commit is in-flight (#3311402947)', async () => {
    // Per-field auto-commit pilot bypasses `store.dirty`, so without the
    // in-flight tracker the user could switch groups while commit() is
    // mid-flight and silently abandon the request. Hold the promise open
    // → click another group → expect leave modal.
    let resolve!: (v: CommitEnvResult) => void;
    mockCommitEnv.mockImplementationOnce(
      () =>
        new Promise<CommitEnvResult>((r) => {
          resolve = r;
        }),
    );
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <ThemeProvider>
          <SettingsShell
            initialDigestEnabled={false}
            initialPresets={[]}
            initialEnvItems={[
              ...ENV_INITIAL,
              {
                key: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
                configured: true,
                source: 'env',
                mask: 'false',
              },
              { key: 'GOLDPAN_AUTH_PASSWORD', configured: false, source: 'default', mask: '' },
            ]}
            envStateError={null}
            manifests={[]}
            contributions={[]}
            language="zh"
            initialPluginsSnapshot={{ plugins: [], registryInstallSupported: false }}
            pluginsError={null}
          />
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /账户与安全/ }));
    // Toggle SSRF — commit fires but never resolves while in-flight.
    fireEvent.click(screen.getByRole('button', { name: 'SSRF 校验' }));
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalledOnce());
    // Now try to switch groups mid-flight; leave modal should appear.
    fireEvent.click(screen.getByRole('button', { name: /外观与语言/ }));
    await screen.findByText(/丢弃当前分组的未保存修改？/);
    // Cleanup — resolve the pending commit so React doesn't warn about
    // unmounted state updates after the test exits.
    resolve({ kind: 'ok', updatedItems: [], pendingRestartKeys: [] });
  });

  test('leave modal triggers when password edit form has typed draft (#3311245199)', async () => {
    // account.tsx's password edit form doesn't `patch()` into store.dirty —
    // it holds pwd / pwd2 locally and only calls pwdCommit.save(pwd) on
    // submit. Without the editing-fields tracker, a failed save (or even
    // an in-progress edit) leaves the form open but unprotected — switching
    // groups silently drops the draft. The shell now treats any field
    // calling setFieldEditing(_, true) as a nav-blocker.
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <ThemeProvider>
          <SettingsShell
            initialDigestEnabled={false}
            initialPresets={[]}
            initialEnvItems={[
              ...ENV_INITIAL,
              { key: 'GOLDPAN_AUTH_PASSWORD', configured: false, source: 'default', mask: '' },
              {
                key: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
                configured: true,
                source: 'env',
                mask: 'false',
              },
            ]}
            envStateError={null}
            manifests={[]}
            contributions={[]}
            language="zh"
            initialPluginsSnapshot={{ plugins: [], registryInstallSupported: false }}
            pluginsError={null}
          />
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /账户与安全/ }));
    // Open the password edit form (Fill button for unconfigured password —
    // zh label is "填写"; account is rendered under settings.account so
    // `getByRole('button', { name: '填写' })` finds the right button).
    fireEvent.click(screen.getByRole('button', { name: '填写' }));
    // Type something — setFieldEditing(KEY, true) runs via useEffect.
    const inputs = screen.getAllByPlaceholderText(/新密码/);
    fireEvent.change(inputs[0], { target: { value: 'verysecret' } });
    // Now try to switch groups — leave modal should appear because the
    // password draft is unsaved.
    fireEvent.click(screen.getByRole('button', { name: /外观与语言/ }));
    await screen.findByText(/丢弃当前分组的未保存修改？/);
  });

  test('leave modal triggers when leaving dirty group; confirm clears ONLY that group', async () => {
    renderShell();
    // Edit appearance (GOLDPAN_LANGUAGE → 'en')
    fireEvent.click(screen.getByRole('button', { name: /外观与语言/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'en' } });
    // Attempt to switch to search group → leave modal appears
    fireEvent.click(screen.getByRole('button', { name: /搜索工具/ }));
    await screen.findByText(/丢弃当前分组的未保存修改？/);
    fireEvent.click(screen.getByRole('button', { name: '丢弃并继续' }));
    // Now in search group, appearance dirty is cleared. Switch back → saveBar hidden.
    fireEvent.click(screen.getByRole('button', { name: /外观与语言/ }));
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  test('per-field commit triggers firstSave modal on first commit', async () => {
    sessionStorage.removeItem('goldpan_first_save_seen');
    mockCommitEnv.mockResolvedValueOnce({
      kind: 'ok',
      updatedItems: [
        {
          key: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
          configured: true,
          source: 'override',
          mask: 'true',
        },
      ],
      pendingRestartKeys: [],
    });
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <ThemeProvider>
          <SettingsShell
            initialDigestEnabled={false}
            initialPresets={[]}
            initialEnvItems={[
              ...ENV_INITIAL,
              {
                key: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
                configured: true,
                source: 'env',
                mask: 'false',
              },
            ]}
            envStateError={null}
            manifests={[]}
            contributions={[]}
            language="zh"
            initialPluginsSnapshot={{ plugins: [], registryInstallSupported: false }}
            pluginsError={null}
          />
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /账户与安全/ }));
    fireEvent.click(screen.getByRole('button', { name: 'SSRF 校验' }));
    await waitFor(() =>
      expect(mockCommitEnv).toHaveBeenCalledWith({ GOLDPAN_SSRF_VALIDATION_ENABLED: 'true' }),
    );
    // firstSave modal body identifies "配置改写至数据库" — text from
    // settings.first_save.title in zh.json.
    await screen.findByText(/配置改写至数据库/);
  });

  test('per-field commits accumulate pendingRestartKeys across attempts', async () => {
    sessionStorage.setItem('goldpan_first_save_seen', '1'); // suppress modal
    mockCommitEnv
      .mockResolvedValueOnce({
        kind: 'ok',
        updatedItems: [
          {
            key: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
            configured: true,
            source: 'override',
            mask: 'true',
          },
        ],
        pendingRestartKeys: ['GOLDPAN_SSRF_VALIDATION_ENABLED'],
      })
      .mockResolvedValueOnce({
        kind: 'ok',
        updatedItems: [
          {
            key: 'GOLDPAN_AUTH_PASSWORD',
            configured: true,
            source: 'override',
            mask: '••••••••',
          },
        ],
        pendingRestartKeys: ['GOLDPAN_AUTH_PASSWORD'],
      });
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <ThemeProvider>
          <SettingsShell
            initialDigestEnabled={false}
            initialPresets={[]}
            initialEnvItems={[
              ...ENV_INITIAL,
              {
                key: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
                configured: true,
                source: 'env',
                mask: 'false',
              },
              {
                key: 'GOLDPAN_AUTH_PASSWORD',
                configured: false,
                source: 'default',
                mask: '',
              },
            ]}
            envStateError={null}
            manifests={[]}
            contributions={[]}
            language="zh"
            initialPluginsSnapshot={{ plugins: [], registryInstallSupported: false }}
            pluginsError={null}
          />
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /账户与安全/ }));
    // 1) Toggle SSRF → first restart key
    fireEvent.click(screen.getByRole('button', { name: 'SSRF 校验' }));
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalledTimes(1));
    // 2) Enter password + save → second restart key
    fireEvent.click(screen.getByText('填写'));
    const pwdInput = screen.getByPlaceholderText(/新密码/);
    fireEvent.change(pwdInput, { target: { value: 'verysecret' } });
    const confirmInput = screen.getByLabelText('确认密码');
    fireEvent.change(confirmInput, { target: { value: 'verysecret' } });
    // The Save inside the password edit form (not the SaveBar — which is
    // not visible for per-field commits).
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalledTimes(2));
    // RestartPrompt modal lists BOTH restart keys via key_labels lookup —
    // "登录密码" for GOLDPAN_AUTH_PASSWORD, "SSRF 校验" for the toggle key.
    // The modal renders all accumulated keys (proves mergeRestartKeys path).
    await waitFor(() => {
      expect(
        screen.getAllByText('登录密码').length + screen.getAllByText('SSRF 校验').length,
      ).toBeGreaterThanOrEqual(2);
    });
  });

  test('per-field commit does not create a phantom dirty entry that lingers SaveBar', async () => {
    // Auto-commit migration leaves no live group writing to store.dirty,
    // so this regression now reduces to "after a single SSRF toggle commit,
    // navigating back to appearance must not show SaveBar". Before the
    // shell's per-field commit branch existed it was possible for commit
    // to merge the committed key into dirty mid-flight; now `commit()`
    // omitKeys(scopedKeys) explicitly clears it.
    sessionStorage.setItem('goldpan_first_save_seen', '1');
    mockCommitEnv.mockResolvedValueOnce({
      kind: 'ok',
      updatedItems: [
        {
          key: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
          configured: true,
          source: 'override',
          mask: 'true',
        },
      ],
      pendingRestartKeys: [],
    });
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <ThemeProvider>
          <SettingsShell
            initialDigestEnabled={false}
            initialPresets={[]}
            initialEnvItems={[
              ...ENV_INITIAL,
              {
                key: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
                configured: true,
                source: 'env',
                mask: 'false',
              },
            ]}
            envStateError={null}
            manifests={[]}
            contributions={[]}
            language="zh"
            initialPluginsSnapshot={{ plugins: [], registryInstallSupported: false }}
            pluginsError={null}
          />
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /账户与安全/ }));
    fireEvent.click(screen.getByRole('button', { name: 'SSRF 校验' }));
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /外观与语言/ }));
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  test('per-field commit subtracts resolved keys from pending-restart accumulator', async () => {
    // Regression: reconcileRestartKeys must merge AND subtract. The user
    // toggles SSRF on → server queues restart for SSRF → banner appears.
    // Then user toggles SSRF off (back to baseline) → server returns
    // pendingRestartKeys=[] → banner should disappear because the key is
    // no longer pending. Without subtract, the banner stays stuck.
    sessionStorage.setItem('goldpan_first_save_seen', '1');
    mockCommitEnv.mockResolvedValueOnce({
      kind: 'ok',
      updatedItems: [
        {
          key: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
          configured: true,
          source: 'env',
          mask: 'true',
        },
      ],
      pendingRestartKeys: [],
    });
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <ThemeProvider>
          <SettingsShell
            initialDigestEnabled={false}
            initialPresets={[]}
            initialEnvItems={[
              ...ENV_INITIAL,
              {
                key: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
                configured: true,
                source: 'override',
                mask: 'false',
              },
            ]}
            envStateError={null}
            manifests={[]}
            contributions={[]}
            language="zh"
            initialPluginsSnapshot={{ plugins: [], registryInstallSupported: false }}
            pluginsError={null}
            // Seed the accumulator with SSRF already pending. After a commit
            // that returns `[]`, the key must be removed and the banner
            // disappear.
            initialPendingRestartKeys={['GOLDPAN_SSRF_VALIDATION_ENABLED']}
          />
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
    // Initial banner is visible (1 pending key).
    expect(screen.getByText(/还有 1 项配置需要 server 重启/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /账户与安全/ }));
    fireEvent.click(screen.getByRole('button', { name: 'SSRF 校验' }));
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalled());
    // Banner gone — accumulator was subtracted.
    await waitFor(() => {
      expect(screen.queryByText(/还有 1 项配置需要 server 重启/)).toBeNull();
    });
  });

  test('auto-commit on language select clears in-flight tracker so subsequent navigation is clean', async () => {
    // Replaces the legacy "cancel-leave preserves dirty; save then cleanly
    // leaves" scenario. Under auto-commit the leave modal only triggers
    // while the commit is *in flight* (inFlightKeys tracker) — once the
    // commit resolves cleanly the user can navigate away without the
    // modal popping up. Hold the commit open, switch groups → leave
    // modal; resolve → switch groups → no modal.
    let resolve!: (v: CommitEnvResult) => void;
    mockCommitEnv.mockImplementationOnce(
      () =>
        new Promise<CommitEnvResult>((r) => {
          resolve = r;
        }),
    );
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <ThemeProvider>
          <SettingsShell
            initialDigestEnabled={false}
            initialPresets={[]}
            initialEnvItems={ENV_INITIAL}
            envStateError={null}
            manifests={[]}
            contributions={[]}
            language="zh"
            initialPluginsSnapshot={{ plugins: [], registryInstallSupported: false }}
            pluginsError={null}
          />
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /外观与语言/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'en' } });
    // Mid-flight: navigation triggers leave modal.
    fireEvent.click(screen.getByRole('button', { name: /^通知/ }));
    await screen.findByText(/丢弃当前分组的未保存修改？/);
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    // Resolve the commit; in-flight tracker drains.
    resolve({
      kind: 'ok',
      updatedItems: [{ key: 'GOLDPAN_LANGUAGE', configured: true, source: 'override', mask: 'en' }],
      pendingRestartKeys: [],
    });
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalled());
    // Now the modal should not trigger again because the in-flight set is empty.
    fireEvent.click(screen.getByRole('button', { name: /^通知/ }));
    await waitFor(() => {
      expect(screen.queryByText(/丢弃当前分组的未保存修改？/)).toBeNull();
    });
  });

  test('canceling a blocked URL deep-link restores the visible group in the URL', async () => {
    mockCommitEnv.mockImplementationOnce(
      () =>
        new Promise<CommitEnvResult>(() => {
          /* keep the leave blocker active */
        }),
    );
    window.history.replaceState(null, '', '/settings');
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <ThemeProvider>
          <SettingsShell
            initialDigestEnabled={false}
            initialPresets={[]}
            initialEnvItems={ENV_INITIAL}
            envStateError={null}
            manifests={[]}
            contributions={[]}
            language="zh"
            initialPluginsSnapshot={{ plugins: [], registryInstallSupported: false }}
            pluginsError={null}
          />
        </ThemeProvider>
      </NextIntlClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /外观与语言/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'en' } });
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalledTimes(1));

    window.location.hash = '#about';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await screen.findByText(/丢弃当前分组的未保存修改？/);
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));

    await waitFor(() => {
      expect(screen.queryByText(/丢弃当前分组的未保存修改？/)).toBeNull();
    });
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      '/settings?group=appearance',
    );
  });

  test('canceling a blocked ?group= query deep-link restores the visible group in the URL', async () => {
    // Mirror of the #hash test above, but exercising the query-param branch of
    // syncFromUrl (queryGroup = searchParams.get('group')) — the restart-tag
    // entry point uses /settings?group=about. Drive it by mutating the hoisted
    // useSearchParams ref + window.location, then re-rendering with a fresh
    // element so the [searchParams] effect re-runs syncFromUrl.
    mockCommitEnv.mockImplementationOnce(
      () =>
        new Promise<CommitEnvResult>(() => {
          /* keep the leave blocker active */
        }),
    );
    window.history.replaceState(null, '', '/settings');
    const makeUi = () => (
      <NextIntlClientProvider locale="zh" messages={zh}>
        <ThemeProvider>
          <SettingsShell
            initialDigestEnabled={false}
            initialPresets={[]}
            initialEnvItems={ENV_INITIAL}
            envStateError={null}
            manifests={[]}
            contributions={[]}
            language="zh"
            initialPluginsSnapshot={{ plugins: [], registryInstallSupported: false }}
            pluginsError={null}
          />
        </ThemeProvider>
      </NextIntlClientProvider>
    );
    const view = render(makeUi());

    fireEvent.click(screen.getByRole('button', { name: /外观与语言/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'en' } });
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalledTimes(1));

    // Point both the mocked useSearchParams (read by syncFromUrl) and
    // window.location (read by currentLocationGroup for the rollback url) at
    // ?group=about, then re-render to fire the effect.
    searchParamsRef.current = new URLSearchParams('group=about');
    window.history.replaceState(null, '', '/settings?group=about');
    view.rerender(makeUi());
    await screen.findByText(/丢弃当前分组的未保存修改？/);
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));

    await waitFor(() => {
      expect(screen.queryByText(/丢弃当前分组的未保存修改？/)).toBeNull();
    });
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      '/settings?group=appearance',
    );
  });
});
