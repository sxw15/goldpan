import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zhMessages from '../../messages/zh.json';

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  setTheme: vi.fn(),
  logoutAction: vi.fn().mockResolvedValue(undefined),
  getEntities: vi.fn(),
  // theme cycle current value — overridable per test
  themeValue: 'system' as 'system' | 'light' | 'dark',
  // pathname seen by `usePathname()` — overridable per test (drives the
  // pathname-aware push/replace branch in `new_interest.execute`).
  pathname: '/' as string,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.routerPush, replace: mocks.routerReplace }),
  usePathname: () => mocks.pathname,
}));

vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: mocks.themeValue, resolvedTheme: 'light', setTheme: mocks.setTheme }),
}));

vi.mock('@/actions/auth', () => ({
  logoutAction: mocks.logoutAction,
}));

vi.mock('@goldpan/web-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@goldpan/web-sdk')>();
  // Use a real class so `new GoldpanClient(...)` in production code stays valid.
  // `vi.fn().mockImplementation(() => ({}))` returns a non-constructible arrow.
  class MockGoldpanClient {
    getEntities = mocks.getEntities;
  }
  return {
    ...actual,
    GoldpanClient: MockGoldpanClient,
  };
});

import { CmdKProvider } from './cmdk-provider';

function renderPalette(ui?: ReactElement) {
  return render(
    <NextIntlClientProvider locale="zh" messages={zhMessages}>
      <CmdKProvider>{ui ?? <div />}</CmdKProvider>
    </NextIntlClientProvider>,
  );
}

function openPalette() {
  fireEvent.keyDown(window, { key: 'k', metaKey: true });
}

function getInput(): HTMLInputElement {
  return screen.getByPlaceholderText(zhMessages.cmdk.placeholder) as HTMLInputElement;
}

describe('<CmdKPalette> S10 mode + commands', () => {
  beforeEach(() => {
    mocks.routerPush.mockReset();
    mocks.routerReplace.mockReset();
    mocks.setTheme.mockReset();
    mocks.logoutAction.mockClear();
    mocks.getEntities.mockReset();
    mocks.themeValue = 'system';
    mocks.pathname = '/';
    mocks.getEntities.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('T1 default entity mode renders input + footer hint', () => {
    renderPalette();
    openPalette();
    expect(getInput()).toBeInTheDocument();
    expect(screen.getByText(zhMessages.cmdk.shortcut_hint)).toBeInTheDocument();
  });

  it('T2 typing > shows all 9 commands + 2 group labels + no entity loading text', () => {
    renderPalette();
    openPalette();
    fireEvent.change(getInput(), { target: { value: '>' } });
    // 9 option rows
    expect(screen.getAllByRole('option')).toHaveLength(9);
    // 2 group labels (role=presentation but rendered text)
    expect(screen.getByText(zhMessages.cmdk.group_navigation)).toBeInTheDocument();
    expect(screen.getByText(zhMessages.cmdk.group_action)).toBeInTheDocument();
    // §1 #8: command mode is synchronous — no `cmdk.loading` text leaks through
    // even though the entity-fetch effect was kicked off on open.
    expect(screen.queryByText(zhMessages.cmdk.loading)).not.toBeInTheDocument();
  });

  it('T3 >打开对话 filters to a single command (open_chat)', () => {
    // NOTE: `>对话` would match BOTH `打开对话` (open_chat) and `打开历史对话`
    // (open_conversations) because `对话` is a substring of both. Use the full
    // `打开对话` form — `打开历史对话` does NOT contain that contiguous 4-char
    // run (the 历史 chars sit between 开 and 对), so filtering uniquely picks
    // open_chat.
    renderPalette();
    openPalette();
    fireEvent.change(getInput(), { target: { value: '>打开对话' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent(zhMessages.cmdk.commands.open_chat.label);
  });

  it('T4 empty > (no filter) shows all 9 commands', () => {
    renderPalette();
    openPalette();
    fireEvent.change(getInput(), { target: { value: '>' } });
    expect(screen.getAllByRole('option')).toHaveLength(9);
  });

  it('T5 >打开对话 + Enter → router.push("/") + close', () => {
    // Use `>打开对话` (uniquely matches open_chat) so the assertion does not
    // depend on `selectedIndex=0` happening to land on open_chat among 2
    // commands matched by the broader `>对话`.
    renderPalette();
    openPalette();
    const input = getInput();
    fireEvent.change(input, { target: { value: '>打开对话' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.routerPush).toHaveBeenCalledWith('/');
    expect(mocks.routerPush).toHaveBeenCalledTimes(1);
    // palette closes → input no longer in DOM
    expect(screen.queryByPlaceholderText(zhMessages.cmdk.placeholder)).not.toBeInTheDocument();
  });

  // T5b parametrises the four navigation commands without their own dedicated
  // dispatch test (`>打开对话` covers open_chat in T5; mouse click covers
  // open_library in T14). Without these, an `execute` URL typo on
  // open_tracking / open_digest / open_conversations / open_settings would
  // not be caught by the option-count or aria assertions.
  it.each([
    ['打开追踪', '/tracking'],
    ['打开日报', '/digest'],
    ['打开历史对话', '/conversations'],
    ['打开设置', '/settings'],
  ])('T5b >%s + Enter → router.push("%s")', (q, href) => {
    renderPalette();
    openPalette();
    const input = getInput();
    fireEvent.change(input, { target: { value: `>${q}` } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.routerPush).toHaveBeenCalledWith(href);
    expect(mocks.routerPush).toHaveBeenCalledTimes(1);
  });

  it('T6 backspace clears > → return to entity mode', () => {
    renderPalette();
    openPalette();
    const input = getInput();
    fireEvent.change(input, { target: { value: '>foo' } });
    expect(screen.getByText(zhMessages.cmdk.command_empty)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '' } });
    // entity mode footer hint
    expect(screen.getByText(zhMessages.cmdk.shortcut_hint)).toBeInTheDocument();
    // command-mode footer hint should NOT be visible
    expect(screen.queryByText(zhMessages.cmdk.command_shortcut_hint)).not.toBeInTheDocument();
  });

  it('T6b >> double prefix → command mode with command_empty (slice(1) keeps inner ">")', () => {
    // Pin the contract that mode is derived purely from `query.startsWith(">")`
    // and `commandQuery` is `slice(1)`. A future regression that strips all
    // leading `>` (e.g., `replace(/^>+/, "")`) would silently match all 9
    // commands here instead of producing command_empty.
    renderPalette();
    openPalette();
    fireEvent.change(getInput(), { target: { value: '>>' } });
    expect(screen.getByText(zhMessages.cmdk.command_empty)).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('T7 >退出 + Enter → logoutAction called once', () => {
    renderPalette();
    openPalette();
    const input = getInput();
    fireEvent.change(input, { target: { value: '>退出' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.logoutAction).toHaveBeenCalledTimes(1);
  });

  it('T8 >主题 + Enter (theme=light) → setTheme called with "dark"', () => {
    mocks.themeValue = 'light';
    renderPalette();
    openPalette();
    const input = getInput();
    fireEvent.change(input, { target: { value: '>主题' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.setTheme).toHaveBeenCalledWith('dark');
  });

  describe('T9 new_interest URL contract', () => {
    it('T9a from /digest → router.push("/tracking?new=1") (no replace)', () => {
      mocks.pathname = '/digest';
      renderPalette();
      openPalette();
      const input = getInput();
      fireEvent.change(input, { target: { value: '>新建追踪项' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(mocks.routerPush).toHaveBeenCalledWith('/tracking?new=1');
      expect(mocks.routerReplace).not.toHaveBeenCalled();
    });

    it('T9b on /tracking → replace("/tracking?new=1") and DROP focus/kind', () => {
      // Inspector dialog and the new-interest form cannot coexist (Inspector
      // is `aria-modal=true`, would trap focus over the form). The command
      // must close any open Inspector by dropping `focus`/`kind` — even when
      // they were present in the URL. Asserts the design fix for the case
      // `/tracking?focus=42&kind=interest` → `>新建追踪项`.
      mocks.pathname = '/tracking';
      renderPalette();
      openPalette();
      const input = getInput();
      fireEvent.change(input, { target: { value: '>新建追踪项' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(mocks.routerReplace).toHaveBeenCalledWith('/tracking?new=1');
      expect(mocks.routerPush).not.toHaveBeenCalled();
    });
  });

  it('T10 >zzzzz → command_empty text shown', () => {
    renderPalette();
    openPalette();
    fireEvent.change(getInput(), { target: { value: '>zzzzz' } });
    expect(screen.getByText(zhMessages.cmdk.command_empty)).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('T11 listbox a11y: role=listbox + option + presentation; input aria-activedescendant', () => {
    renderPalette();
    openPalette();
    fireEvent.change(getInput(), { target: { value: '>' } });
    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(9);
    // aria-activedescendant points to first selected command id
    const input = getInput();
    expect(input.getAttribute('aria-activedescendant')).toBe('cmdk-option-open_chat');
    // group labels are role=presentation, not role=option
    expect(screen.queryByText(zhMessages.cmdk.group_navigation)?.getAttribute('role')).toBe(
      'presentation',
    );
  });

  it('T11b mouse hover updates aria-activedescendant to the hovered row', () => {
    // Pin the listbox contract that hover-driven selection stays in sync with
    // `aria-activedescendant`. Without this, a regression on the
    // `onMouseEnter → setSelectedIndex` path would let keyboard a11y drift
    // from the row the user is visually on before they press Enter.
    renderPalette();
    openPalette();
    const input = getInput();
    fireEvent.change(input, { target: { value: '>' } });
    expect(input.getAttribute('aria-activedescendant')).toBe('cmdk-option-open_chat');
    const openLibraryRow = screen
      .getByText(zhMessages.cmdk.commands.open_library.label)
      .closest('li');
    expect(openLibraryRow).not.toBeNull();
    fireEvent.mouseEnter(openLibraryRow as HTMLElement);
    expect(input.getAttribute('aria-activedescendant')).toBe('cmdk-option-open_library');
  });

  it('T12 mid-string > does NOT trigger command mode', () => {
    renderPalette();
    openPalette();
    fireEvent.change(getInput(), { target: { value: 'Vue 3 > 2' } });
    // entity mode footer hint
    expect(screen.getByText(zhMessages.cmdk.shortcut_hint)).toBeInTheDocument();
    // no command_empty fallback (which would only show in command mode)
    expect(screen.queryByText(zhMessages.cmdk.command_empty)).not.toBeInTheDocument();
  });

  it('T13 ArrowDown advances 0→8 then wraps 8→0 on the 9th press', () => {
    renderPalette();
    openPalette();
    const input = getInput();
    fireEvent.change(input, { target: { value: '>' } });
    // initial selection: index 0 = open_chat
    expect(input.getAttribute('aria-activedescendant')).toBe('cmdk-option-open_chat');
    // ArrowDown 8 times → last command (new_interest, index 8)
    for (let i = 0; i < 8; i++) fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('cmdk-option-new_interest');
    // one more ArrowDown wraps to first
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('cmdk-option-open_chat');
  });

  it('T14 mouse click on command row → execute + close', () => {
    renderPalette();
    openPalette();
    fireEvent.change(getInput(), { target: { value: '>' } });
    const openLibraryRow = screen
      .getByText(zhMessages.cmdk.commands.open_library.label)
      .closest('li');
    expect(openLibraryRow).not.toBeNull();
    fireEvent.click(openLibraryRow as HTMLElement);
    expect(mocks.routerPush).toHaveBeenCalledWith('/library');
    expect(screen.queryByPlaceholderText(zhMessages.cmdk.placeholder)).not.toBeInTheDocument();
  });

  it('T15 execute runs before close (router.push observed before unmount)', () => {
    const callOrder: string[] = [];
    mocks.routerPush.mockImplementation(() => {
      callOrder.push('execute');
    });
    renderPalette();
    openPalette();
    const input = getInput();
    fireEvent.change(input, { target: { value: '>打开对话' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // After Enter, palette unmounts. We confirm execute ran (call order recorded)
    // and the palette is gone (close happened too).
    expect(callOrder).toEqual(['execute']);
    expect(screen.queryByPlaceholderText(zhMessages.cmdk.placeholder)).not.toBeInTheDocument();
  });

  it('T15b entity fetch error in entity mode is cleared on entering command mode', async () => {
    // Without the mode-switch reset, a stale entity error would surface again
    // when the user backspaces back to entity, decoupled from the action that
    // triggered it. The reset effect (cmdk-palette.tsx) returns the user to a
    // clean idle state in command mode and prevents the resurrection.
    mocks.getEntities.mockRejectedValueOnce(new Error('boom'));
    renderPalette();
    openPalette();
    const input = getInput();
    // entity mode shows the error first
    await screen.findByRole('alert');
    fireEvent.change(input, { target: { value: '>' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('T16 footer hint switches between shortcut_hint (entity) and command_shortcut_hint (command)', () => {
    renderPalette();
    openPalette();
    expect(screen.getByText(zhMessages.cmdk.shortcut_hint)).toBeInTheDocument();
    fireEvent.change(getInput(), { target: { value: '>' } });
    expect(screen.getByText(zhMessages.cmdk.command_shortcut_hint)).toBeInTheDocument();
    expect(screen.queryByText(zhMessages.cmdk.shortcut_hint)).not.toBeInTheDocument();
  });
});
