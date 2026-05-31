import type { ImActionResult, ImSettingsManifest } from '@goldpan/web-sdk';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { FieldTagLabels } from '@/components/ui/settings-field';
import { ImChannelCard } from './index';

const tagLabels: FieldTagLabels = {
  restart: 'restart',
  restartHint: 'restart hint',
  readonly: 'readonly',
  envPrefix: '.env · ',
  todo: 'TODO',
  shadowed: 'shadowed',
};

const manifest: ImSettingsManifest = {
  channelId: 'fakechan',
  branding: { name: { en: 'FakeChan', zh: '假频道' } },
  enable: {
    envKey: 'GOLDPAN_IM_FAKE_ENABLED',
    label: { en: 'Enable FakeChan', zh: '启用假频道' },
    default: true,
  },
  fields: [
    {
      name: 'token',
      kind: 'secret',
      label: { en: 'Token', zh: 'Token' },
      envKey: 'GOLDPAN_IM_FAKE_TOKEN',
      required: true,
      placeholder: { en: 'tok-123', zh: 'tok-123' },
    },
    {
      name: 'chatId',
      kind: 'text',
      label: { en: 'Chat ID', zh: 'Chat ID' },
      envKey: 'GOLDPAN_IM_FAKE_CHAT_ID',
      required: true,
    },
  ],
  actions: [
    {
      id: 'test',
      kind: 'test',
      label: { en: 'Send test', zh: '发送测试' },
      requires: ['token', 'chatId'],
      errorMessages: {
        bad_token: { en: 'Invalid token', zh: 'Token 无效' },
      },
    },
  ],
  setupGuide: {
    allDoneTitle: { en: 'FakeChan setup completed', zh: '已完成假频道接入' },
    steps: [
      {
        id: 'step1',
        title: { en: 'Step 1 title', zh: '第一步' },
        desc: { en: 'Step 1 desc', zh: '第一步说明' },
        images: [],
      },
    ],
  },
};

function baseProps(overrides: Partial<React.ComponentProps<typeof ImChannelCard>> = {}) {
  return {
    manifest,
    mode: 'settings' as const,
    language: 'en' as const,
    values: { __enabled: true, token: 'tok-123', chatId: 'cid-1' },
    onChange: vi.fn(),
    onAction: vi.fn(async (): Promise<ImActionResult> => ({ ok: true })),
    envMeta: vi.fn((_envKey: string) => ({ configured: true, mask: '••••', dirty: false })),
    toast: vi.fn(),
    tagLabels,
    ...overrides,
  };
}

describe('ImChannelCard', () => {
  test('renders branding name + fields + action button', () => {
    render(<ImChannelCard {...baseProps()} />);
    // Branding is rendered as the SettingsCard heading. Both the SetupGuide
    // bar and the SettingsCard heading show the name; assert at least one.
    const matches = screen.getAllByText('FakeChan');
    expect(matches.length).toBeGreaterThan(0);
    expect(screen.getByText('Token')).toBeInTheDocument();
    expect(screen.getByText('Chat ID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send test' })).toBeInTheDocument();
  });

  test('errorMessage tier 1 — manifest.errorMessages[code] used when present', async () => {
    const onAction = vi.fn(
      async (): Promise<ImActionResult> => ({
        ok: false,
        code: 'bad_token',
        message: 'raw server msg should NOT win',
      }),
    );
    const toast = vi.fn();
    render(<ImChannelCard {...baseProps({ onAction, toast })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Send test' }));
    expect(toast).toHaveBeenCalledWith({ kind: 'danger', msg: 'Invalid token' });
  });

  test('errorMessage tier 2 — falls back to res.message when code not in manifest', async () => {
    const onAction = vi.fn(
      async (): Promise<ImActionResult> => ({
        ok: false,
        code: 'unknown_x',
        message: 'larkMsg-style raw server message',
      }),
    );
    const toast = vi.fn();
    render(<ImChannelCard {...baseProps({ onAction, toast })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Send test' }));
    expect(toast).toHaveBeenCalledWith({
      kind: 'danger',
      msg: 'larkMsg-style raw server message',
    });
  });

  test('errorMessage tier 3 — host generic when no code match and no message', async () => {
    const onAction = vi.fn(
      async (): Promise<ImActionResult> => ({
        ok: false,
        code: 'unknown_x',
      }),
    );
    const toast = vi.fn();
    render(<ImChannelCard {...baseProps({ onAction, toast, language: 'zh' })} />);
    await userEvent.click(screen.getByRole('button', { name: '发送测试' }));
    expect(toast).toHaveBeenCalledWith({ kind: 'danger', msg: '操作失败' });
  });

  test('disableActions hides action buttons entirely', () => {
    render(<ImChannelCard {...baseProps({ disableActions: true })} />);
    expect(screen.queryByRole('button', { name: 'Send test' })).toBeNull();
    // Sanity — fields still render
    expect(screen.getByText('Token')).toBeInTheDocument();
  });

  test('collapses fields / setup-guide / actions when channel toggle is OFF', () => {
    // 关闭状态下卡片只剩 header + toggle，不被空表单 / setup guide 干扰。
    // 用户要编辑必须先 toggle 打开 —— 多一步换更干净的列表，在大多数渠道
    // 还没启用的常见场景下值。
    render(<ImChannelCard {...baseProps({ values: { __enabled: false } })} />);
    expect(screen.getByText('FakeChan')).toBeInTheDocument(); // header 仍在
    expect(screen.queryByText('Token')).toBeNull();
    expect(screen.queryByText('Chat ID')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send test' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Expand setup guide/ })).toBeNull();
  });

  test('keeps collapsed setup-guide entry visible after required fields are configured', () => {
    // Regression: an outer `requiredMissing` gate used to unmount the entire
    // SetupGuide once all required fields were filled, hiding the collapsed
    // setup-guide entry that returning users rely on. The SetupGuide owns its
    // own collapsed/open state, so the host must mount it unconditionally and
    // let it choose the right state.
    render(<ImChannelCard {...baseProps()} />);
    expect(screen.getByRole('button', { name: /Expand setup guide/ })).toBeInTheDocument();
  });
});

// Regression coverage for the auto-commit migration. Pre-fix, settings mode
// reused the wizard's `onChange` path: typed chars vanished from the input
// (controlled value locked by host's empty `values[secret]`), every
// keystroke fired a commit (half-typed tokens written to DB), and there
// was no commit batching for text inputs. The fix wires a `onCommit` prop
// and a local-draft state inside FieldRenderer.
describe('ImChannelCard text/secret auto-commit (#1, #5 regression)', () => {
  test('settings mode: typed chars visible in input; onCommit fires once on blur', () => {
    const onCommit = vi.fn();
    render(
      <ImChannelCard
        {...baseProps({
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange: vi.fn(),
          onCommit,
          envMeta: vi.fn(() => ({ configured: true, mask: '••••XXXX', dirty: false })),
        })}
      />,
    );
    const input = screen.getByPlaceholderText('••••XXXX') as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'mytoken' } });
    expect(input.value).toBe('mytoken'); // FIX: previously locked to ''
    expect(onCommit).not.toHaveBeenCalled(); // no per-keystroke flood
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('token', 'mytoken');
  });

  test('Enter key flushes the draft as a commit', () => {
    const onCommit = vi.fn();
    render(
      <ImChannelCard
        {...baseProps({
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange: vi.fn(),
          onCommit,
          envMeta: vi.fn(() => ({ configured: false, mask: '', dirty: false })),
        })}
      />,
    );
    const input = screen
      .getAllByRole('textbox')
      .find(
        (el) => el.getAttribute('type') === 'text' || el.tagName === 'INPUT',
      ) as HTMLInputElement;
    // Specifically grab the password-typed input for the secret 'token' field
    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(tokenInput, { target: { value: 'fresh' } });
    fireEvent.keyDown(tokenInput, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('token', 'fresh');
    expect(input).toBeDefined(); // appease no-unused
  });

  test('Enter then blur dedupes — onCommit fires only once (R7 regression)', () => {
    // Pre-fix: flushDraft (called by both Enter keyDown and blur) didn't
    // clear localDraft (intentional, to preserve display during commit
    // roundtrip — see F10 fix). The downside: a sequence of Enter + blur
    // saw `localDraft !== null` on BOTH calls and fired onCommit twice,
    // resulting in two server writes (and twice-debited in-flight counter).
    // Post-fix uses lastFlushedRef to dedupe identical consecutive flushes.
    const onCommit = vi.fn();
    render(
      <ImChannelCard
        {...baseProps({
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange: vi.fn(),
          onCommit,
          envMeta: vi.fn(() => ({ configured: false, mask: '', dirty: false })),
        })}
      />,
    );
    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(tokenInput, { target: { value: 'fresh-token' } });
    fireEvent.keyDown(tokenInput, { key: 'Enter' });
    fireEvent.blur(tokenInput);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('token', 'fresh-token');
  });

  test('flushDraft skips empty-string commit (would silently delete override)', () => {
    // Pre-fix: flushDraft only guarded `localDraft === null` (no draft).
    // A type-then-backspace-to-empty-then-blur sequence reached
    // onCommit('') → notify.tsx commit({key: ''}) → shell normalizes ''
    // → null (key not in EMPTY_STRING_ALLOWED_PATTERNS) → server deletes
    // the override → channel breaks silently. SecretRow already guards
    // this via `disabled={hook.draft.length === 0}`; the IM text/secret
    // path now mirrors that with an explicit empty-string short-circuit.
    const onCommit = vi.fn();
    const onEditingChange = vi.fn();
    render(
      <ImChannelCard
        {...baseProps({
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange: vi.fn(),
          onCommit,
          onEditingChange,
          envMeta: vi.fn(() => ({ configured: true, mask: '••••OLD', dirty: false })),
        })}
      />,
    );
    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    // Type then erase to empty (simulating a user who clears the field
    // by accident, e.g. mid-paste).
    fireEvent.change(tokenInput, { target: { value: 'a' } });
    expect(onEditingChange).toHaveBeenLastCalledWith('token', true);
    fireEvent.change(tokenInput, { target: { value: '' } });
    fireEvent.blur(tokenInput);
    // The empty draft must NOT have triggered onCommit; the existing
    // override is preserved.
    expect(onCommit).not.toHaveBeenCalled();
    // Q-fix side-effect coverage: empty-string guard also clears the
    // localDraft (→ null) and lastFlushedRef, which propagates through
    // the editing-change useEffect to onEditingChange(false). Without
    // this, the field stays "editing" with an invisible empty draft —
    // shell's leave-guard prompts on tab close with no visible control
    // for the user to dismiss.
    expect(onEditingChange).toHaveBeenLastCalledWith('token', false);
    // Input falls back to the masked-display path: empty value + mask
    // in placeholder. (The host's `values.token` is also empty here,
    // so `inputValue` resolves to '' through the secretMaskedDisplay
    // gate, not through `usingDraft`.)
    expect(tokenInput.value).toBe('');
  });

  test('settings mode: explicit Reset clears an override with an empty commit', async () => {
    const onCommit = vi.fn(async () => true);
    render(
      <ImChannelCard
        {...baseProps({
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange: vi.fn(),
          onCommit,
          envMeta: vi.fn(() => ({
            configured: true,
            mask: '••••OLD',
            dirty: false,
            source: 'override' as const,
          })),
        })}
      />,
    );

    const resetButton = screen.getAllByRole('button', { name: 'Reset' })[0];
    if (!resetButton) throw new Error('reset button not rendered');
    fireEvent.click(resetButton);

    await vi.waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith('token', '');
    });
  });

  test('settings mode: Reset button hidden when source is not an override', () => {
    // canResetOverride gates on meta.source === 'override'. An env-backed or
    // default-backed field has no DB override to remove, so the Reset button
    // must NOT render — otherwise a click would commit '' and either delete a
    // non-existent override or clobber the .env-provided value. Guards the
    // visibility axis that the positive test above leaves uncovered.
    render(
      <ImChannelCard
        {...baseProps({
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange: vi.fn(),
          onCommit: vi.fn(async () => true),
          envMeta: vi.fn(() => ({
            configured: true,
            mask: '••••ENV',
            dirty: false,
            source: 'env' as const,
          })),
        })}
      />,
    );

    expect(screen.queryAllByRole('button', { name: 'Reset' })).toHaveLength(0);
  });

  test('editing after a flush re-arms dedupe for the next Enter (R7)', () => {
    // After flushDraft fires and lastFlushedRef captures the value, the
    // user typing further (or even retyping the same value after an
    // onChange) must reset the dedupe ref — otherwise a retry of the same
    // value would never commit. Mirrors the production retry-after-401 flow.
    const onCommit = vi.fn();
    render(
      <ImChannelCard
        {...baseProps({
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange: vi.fn(),
          onCommit,
          envMeta: vi.fn(() => ({ configured: false, mask: '', dirty: false })),
        })}
      />,
    );
    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(tokenInput, { target: { value: 'retry-me' } });
    fireEvent.keyDown(tokenInput, { key: 'Enter' });
    // Simulate the user editing again (any onChange resets the dedupe ref).
    fireEvent.change(tokenInput, { target: { value: 'retry-me-again' } });
    fireEvent.keyDown(tokenInput, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenNthCalledWith(1, 'token', 'retry-me');
    expect(onCommit).toHaveBeenNthCalledWith(2, 'token', 'retry-me-again');
  });

  test('wizard mode: onChange fires per keystroke (no onCommit indirection)', () => {
    const onChange = vi.fn();
    render(
      <ImChannelCard
        {...baseProps({
          mode: 'wizard',
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange,
          // no onCommit
          envMeta: vi.fn(() => ({ configured: false, mask: '', dirty: false })),
        })}
      />,
    );
    const input = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    // Wizard relies on every keystroke flowing into wizard state.
    expect(onChange).toHaveBeenCalledWith('token', 'a');
    expect(onChange).toHaveBeenCalledWith('token', 'ab');
  });

  test('settings mode: Promise<true> from onCommit clears localDraft (success path)', async () => {
    // Post-review-#2: localDraft is cleared by the Promise<boolean> return
    // of onCommit, NOT by mask change. The mask-change useEffect was
    // removed because it also fired on EXTERNAL env updates (sibling tab,
    // web-sdk refetch) — see the multi-tab regression below. The Promise
    // path stays the sole authoritative "commit landed" signal.
    let resolvePromise: ((v: boolean) => void) | null = null;
    const onCommit = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          resolvePromise = res;
        }),
    );
    const { container } = render(
      <ImChannelCard
        {...baseProps({
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange: vi.fn(),
          onCommit,
          envMeta: vi.fn(() => ({ configured: true, mask: '••••OLD', dirty: false })),
        })}
      />,
    );
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'newtoken' } });
    expect(input.value).toBe('newtoken');
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('token', 'newtoken');
    // Commit still pending — draft remains visible.
    expect(input.value).toBe('newtoken');
    // Resolve commit as success.
    await act(async () => {
      resolvePromise?.(true);
    });
    // Promise<true> → localDraft cleared → masked placeholder takes over.
    expect(input.value).toBe('');
  });

  test('settings mode: external env mask update does NOT clear in-progress draft (#3 regression)', () => {
    // Pre-fix: a maskNow useEffect fired setLocalDraft(null) whenever
    // envMeta.mask shifted. That was meant as belt-and-braces after the
    // Promise<true> path resolved, but it also fired when an UNRELATED
    // event flipped mask (multi-tab edit, sibling commit, web-sdk
    // refetch). Result: user typing 'in-progress' in tab A gets silently
    // erased when tab B finishes a different commit. Post-fix the
    // useEffect is removed; in-progress drafts only clear via Promise<true>.
    const onCommit = vi.fn();
    const { container, rerender } = render(
      <ImChannelCard
        {...baseProps({
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange: vi.fn(),
          onCommit,
          envMeta: vi.fn(() => ({ configured: true, mask: '••••OLD', dirty: false })),
        })}
      />,
    );
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'in-progress' } });
    expect(input.value).toBe('in-progress');
    // External env update — re-render with new mask. The in-progress
    // draft must persist; user never blurred.
    rerender(
      <ImChannelCard
        {...baseProps({
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange: vi.fn(),
          onCommit,
          envMeta: vi.fn(() => ({ configured: true, mask: '••••NEW', dirty: false })),
        })}
      />,
    );
    const inputAfter = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(inputAfter.value).toBe('in-progress');
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('settings mode: commit failure keeps typed chars for retry', () => {
    // Mirror of the success path: when onCommit returns void (sync fire-
    // and-forget) or Promise<false>, localDraft must persist so the user
    // can see what they typed and try again. With maskNow removed,
    // failure naturally leaves the draft alone — no useEffect mutates it.
    const onCommit = vi.fn();
    const { container } = render(
      <ImChannelCard
        {...baseProps({
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange: vi.fn(),
          onCommit,
          envMeta: vi.fn(() => ({ configured: true, mask: '••••OLD', dirty: false })),
        })}
      />,
    );
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'badtoken' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    // No await; void path keeps the draft.
    expect(input.value).toBe('badtoken');
  });

  test('Promise<false> resets dedupe ref so Enter can retry same value (#4 regression)', async () => {
    // Pre-fix: lastFlushedRef captured the value on every flushDraft and
    // was only reset by onChange (typing a different value). On commit
    // failure (transient 502 / validation error), pressing Enter again
    // with the SAME value silently no-op'd. User had to edit-then-restore
    // to retry. Post-fix Promise<false> and Promise rejection also reset
    // lastFlushedRef so re-fire works.
    let resolvePromise: ((v: boolean) => void) | null = null;
    const onCommit = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          resolvePromise = res;
        }),
    );
    const { container } = render(
      <ImChannelCard
        {...baseProps({
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange: vi.fn(),
          onCommit,
          envMeta: vi.fn(() => ({ configured: false, mask: '', dirty: false })),
        })}
      />,
    );
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'retry-this' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    // Resolve commit as failure.
    await act(async () => {
      resolvePromise?.(false);
    });
    // Retry Enter with identical value — must NOT no-op now that the
    // dedupe ref was cleared.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenNthCalledWith(2, 'token', 'retry-this');
  });

  test('Promise<true> snapshot guard: keystrokes after Enter survive commit success (#2 regression)', async () => {
    // Pre-fix: flushDraft's .then((ok) => setLocalDraft(null)) ran
    // unconditionally on success, clobbering any newer keystrokes the
    // user typed between Enter and the resolve. Post-fix snapshots the
    // flushed value and only clears if localDraftRef still matches —
    // i.e. nothing newer is in flight.
    let resolvePromise: ((v: boolean) => void) | null = null;
    const onCommit = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          resolvePromise = res;
        }),
    );
    const { container } = render(
      <ImChannelCard
        {...baseProps({
          values: { __enabled: true, token: '', chatId: 'cid-1' },
          onChange: vi.fn(),
          onCommit,
          envMeta: vi.fn(() => ({ configured: false, mask: '', dirty: false })),
        })}
      />,
    );
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    // User keeps typing while the 'abc' commit is in flight.
    fireEvent.change(input, { target: { value: 'abcd' } });
    expect(input.value).toBe('abcd');
    // Resolve the 'abc' commit as success.
    await act(async () => {
      resolvePromise?.(true);
    });
    // 'abcd' must survive — snapshot guard prevents the success path from
    // clearing a draft that moved on.
    expect(input.value).toBe('abcd');
  });
});
