import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zh from '../../../../messages/zh.json';
import { TzCard } from './tz-card';
import type { WizardState } from './wizard-state';

// Hoisted holder so each test can swap the wizard ctx the mocked useWizard
// returns + capture patch() calls. vi.mock factory runs before module
// initialization, so we use vi.hoisted for stable refs.
const ctx = vi.hoisted(() => {
  const value: {
    state: WizardState;
    patch: ReturnType<typeof vi.fn>;
  } = {
    state: { providers: {}, steps: {} },
    patch: vi.fn(async () => undefined),
  };
  return value;
});

vi.mock('./wizard-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wizard-state')>();
  return {
    ...actual,
    useWizard: () => ({
      state: ctx.state,
      patch: ctx.patch,
      flush: vi.fn(async () => undefined),
      hydrated: true,
      patchError: null,
      dismissError: vi.fn(),
      availableProviders: [],
    }),
  };
});

/**
 * Mock `Intl.DateTimeFormat` so the no-args probe returns `tz` while
 * argumented calls (formatNowInTz with { timeZone }) fall through to the real
 * implementation — otherwise the displayed time string lies.
 */
function mockIntlProbe(tz: string): () => void {
  const RealDTF = Intl.DateTimeFormat;
  const StubDTF = function StubDTF(
    this: unknown,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    if (locales === undefined && options === undefined) {
      return {
        resolvedOptions: () =>
          ({ timeZone: tz, locale: 'en-US' }) as Intl.ResolvedDateTimeFormatOptions,
        format: (d: Date) => new RealDTF(undefined, { timeZone: tz }).format(d),
        formatToParts: (d: Date) => new RealDTF(undefined, { timeZone: tz }).formatToParts(d),
      } as unknown as Intl.DateTimeFormat;
    }
    return new RealDTF(locales, options);
  } as unknown as typeof Intl.DateTimeFormat;
  // copy statics so `Intl.DateTimeFormat.supportedLocalesOf` etc. keep working.
  StubDTF.supportedLocalesOf = RealDTF.supportedLocalesOf.bind(RealDTF);
  Intl.DateTimeFormat = StubDTF;
  return () => {
    Intl.DateTimeFormat = RealDTF;
  };
}

function renderTz(state: WizardState = { providers: {}, steps: {} }) {
  ctx.state = state;
  ctx.patch.mockClear();
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <TzCard />
    </NextIntlClientProvider>,
  );
}

describe('TzCard', () => {
  let restoreIntl: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-05-14T06:35:23Z → Asia/Shanghai (UTC+8) wall clock 14:35:23.
    vi.setSystemTime(new Date('2026-05-14T06:35:23Z'));
  });

  afterEach(() => {
    restoreIntl?.();
    restoreIntl = null;
    vi.useRealTimers();
  });

  it('renders detected tz + current time on mount', () => {
    restoreIntl = mockIntlProbe('Asia/Shanghai');
    renderTz();

    expect(screen.getByText(/Asia\/Shanghai/)).toBeInTheDocument();
    // Asia/Shanghai (UTC+8) at 06:35:23 UTC = 14:35:23 local.
    expect(screen.getByText(/14:35:23/)).toBeInTheDocument();
  });

  it('patches timezone when "Time looks right" clicked', () => {
    restoreIntl = mockIntlProbe('Asia/Shanghai');
    renderTz();

    fireEvent.click(screen.getByText(/时间正确/));

    expect(ctx.patch).toHaveBeenCalledWith({ timezone: 'Asia/Shanghai' });
  });

  it('shows offset picker when "Time is wrong" clicked', () => {
    restoreIntl = mockIntlProbe('Asia/Shanghai');
    renderTz();

    fireEvent.click(screen.getByText(/时间不对/));

    const select = screen.getByLabelText(/UTC offset/) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain('Etc/GMT');
    expect(values).toContain('Etc/GMT-8'); // UTC+8
    expect(values).toContain('Etc/GMT+12'); // UTC-12
  });

  it('patches Etc/GMT-N when user applies offset', () => {
    restoreIntl = mockIntlProbe('Asia/Shanghai');
    renderTz();

    fireEvent.click(screen.getByText(/时间不对/));
    const select = screen.getByLabelText(/UTC offset/) as HTMLSelectElement;
    // POSIX-reversed: Etc/GMT-8 == UTC+8.
    fireEvent.change(select, { target: { value: 'Etc/GMT-8' } });
    fireEvent.click(screen.getByText(/应用/));

    expect(ctx.patch).toHaveBeenCalledWith({ timezone: 'Etc/GMT-8' });
  });

  it('falls back to offset picker when probe returns empty', () => {
    restoreIntl = mockIntlProbe('');
    renderTz();

    expect(screen.getByText(/无法自动检测时区/)).toBeInTheDocument();
    expect(screen.getByLabelText(/UTC offset/)).toBeInTheDocument();
  });
});
