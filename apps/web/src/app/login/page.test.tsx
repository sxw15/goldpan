import { afterEach, describe, expect, test, vi } from 'vitest';

// Mocks must be declared before importing the RSC page module. The page
// invokes Next's server-only `cookies()` + `redirect()` + `getTranslations()`
// plus the SDK probe; we substitute each so the async component can run in
// jsdom without a real Next request context.
//
// Two SDK factories are mocked separately (rather than sharing one
// getStatus) so individual tests can spy on which client path the page
// chose: token absent → createPublicClient; token present →
// createTokenValidationClient. Sharing would lose that signal.
const mockPublicGetStatus = vi.fn();
const mockTokenGetStatus = vi.fn();
const mockCreatePublicClient = vi.fn(() => ({ getStatus: mockPublicGetStatus }));
const mockCreateTokenValidationClient = vi.fn((_token: string) => ({
  getStatus: mockTokenGetStatus,
}));
const mockRedirect = vi.fn((path: string) => {
  // Mirror Next's behaviour: `redirect()` throws a sentinel so callers
  // don't fall through to subsequent render code.
  throw new Error(`NEXT_REDIRECT:${path}`);
});

// Configurable cookie value — tests mutate `mockSessionToken` before
// invoking LoginPage() to exercise either the public or token-validation
// branch.
let mockSessionToken: string | undefined;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'goldpan_session' && mockSessionToken !== undefined
        ? { value: mockSessionToken }
        : undefined,
  }),
}));

vi.mock('next/navigation', () => ({
  redirect: (path: string) => mockRedirect(path),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

vi.mock('@/lib/api', () => ({
  createPublicClient: () => mockCreatePublicClient(),
  createTokenValidationClient: (token: string) => mockCreateTokenValidationClient(token),
}));

vi.mock('@/lib/auth-edge', () => ({
  SESSION_COOKIE: 'goldpan_session',
}));

vi.mock('./login-form', () => ({
  LoginForm: () => null,
}));

import LoginPage from './page';

afterEach(() => {
  mockSessionToken = undefined;
  mockPublicGetStatus.mockReset();
  mockTokenGetStatus.mockReset();
  mockCreatePublicClient.mockClear();
  mockCreateTokenValidationClient.mockClear();
  mockRedirect.mockClear();
});

describe('LoginPage probe fallback (Important.6)', () => {
  test('renders form when probe throws (server-down / DNS fail) — does NOT redirect', async () => {
    // Critical regression: history shows users hitting an infinite
    // `/` ↔ `/login` loop when the page falls back to the stale env
    // snapshot. Defaults must be `authRequired=true, authenticated=false`
    // so neither redirect branch fires and the form renders.
    mockPublicGetStatus.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await LoginPage();
      expect(mockRedirect).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[login] /auth/status probe failed'),
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('redirects when probe reports authRequired=false', async () => {
    mockPublicGetStatus.mockResolvedValueOnce({ authRequired: false, authenticated: false });
    await expect(LoginPage()).rejects.toThrow('NEXT_REDIRECT:/');
    expect(mockRedirect).toHaveBeenCalledWith('/');
  });

  test('redirects when probe reports authenticated=true', async () => {
    mockPublicGetStatus.mockResolvedValueOnce({ authRequired: true, authenticated: true });
    await expect(LoginPage()).rejects.toThrow('NEXT_REDIRECT:/');
    expect(mockRedirect).toHaveBeenCalledWith('/');
  });
});

describe('LoginPage token-validation branch (Important.6 — P2.1 follow-up)', () => {
  // Without explicit coverage here, mutations that delete the
  // `token ? ... : ...` branch (e.g. unconditionally using createPublicClient)
  // would not be detected — yet the token-validation path is exactly the
  // historical bug surface (stale token cookie causing /↔/login loop).

  test('cookie token routes probe through createTokenValidationClient(token)', async () => {
    mockSessionToken = 'stale-token-abc';
    mockTokenGetStatus.mockResolvedValueOnce({ authRequired: true, authenticated: false });
    await LoginPage();
    expect(mockCreateTokenValidationClient).toHaveBeenCalledWith('stale-token-abc');
    // Public client must NOT be used when a token is present.
    expect(mockCreatePublicClient).not.toHaveBeenCalled();
    // authenticated=false → no redirect, form renders.
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  test('token probe failure still defaults to form (regression: stale token must not infinite-loop)', async () => {
    mockSessionToken = 'stale-token-abc';
    mockTokenGetStatus.mockRejectedValueOnce(new Error('401'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await LoginPage();
      expect(mockCreateTokenValidationClient).toHaveBeenCalledWith('stale-token-abc');
      expect(mockRedirect).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[login] /auth/status probe failed'),
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('valid token + authenticated=true → redirect to /', async () => {
    mockSessionToken = 'valid-token';
    mockTokenGetStatus.mockResolvedValueOnce({ authRequired: true, authenticated: true });
    await expect(LoginPage()).rejects.toThrow('NEXT_REDIRECT:/');
    expect(mockCreateTokenValidationClient).toHaveBeenCalledWith('valid-token');
    expect(mockRedirect).toHaveBeenCalledWith('/');
  });

  test('token + authRequired=false → redirect to / (auth was disabled after token issued)', async () => {
    // Regression path: the user kept their browser open after a self-host
    // operator turned `GOLDPAN_AUTH_PASSWORD` off (or cleared it via /reset).
    // The stale `goldpan_session` cookie still routes through the
    // token-validation client, but the server now reports `authRequired:
    // false`. We must redirect to `/` instead of rendering the form — the
    // OR-short-circuit `!authRequired || authenticated` in page.tsx is what
    // guarantees this; a mutation that flipped it to AND would silently
    // strand the user on /login with no working credentials.
    mockSessionToken = 'stale-token-after-disable';
    mockTokenGetStatus.mockResolvedValueOnce({ authRequired: false, authenticated: false });
    await expect(LoginPage()).rejects.toThrow('NEXT_REDIRECT:/');
    expect(mockCreateTokenValidationClient).toHaveBeenCalledWith('stale-token-after-disable');
    expect(mockRedirect).toHaveBeenCalledWith('/');
  });
});
