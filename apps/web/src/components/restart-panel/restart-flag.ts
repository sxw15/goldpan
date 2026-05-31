// apps/web/src/components/restart-panel/restart-flag.ts
//
// Shared sessionStorage flag set by `RestartPanel` and read by
// `WizardStateProvider`'s hydrate path. The flag survives the browser reload
// that next dev's HMR triggers when the dev server restarts under us, and
// tells WizardStateProvider that a hydrate failure during this window is
// expected (server is intentionally down) and should not surface the
// "无法加载向导状态" banner — that banner would just confuse the user
// mid-restart.
//
// Key name keeps the legacy `goldpan.onboarding.restarting` value: it is the
// only consumer that reads the flag (settings just sets/clears it the same
// way as onboarding so a mid-restart browser reload behaves identically),
// and renaming the key would orphan flags set by older browser tabs that
// reload after an upgrade.

export const RESTART_FLAG_KEY = 'goldpan.onboarding.restarting';

export function setRestartFlag(): void {
  try {
    sessionStorage.setItem(RESTART_FLAG_KEY, '1');
  } catch {
    // Private browsing / storage quota — degrade gracefully: a post-reload
    // user will land on idle and have to click again, but the page itself
    // remains functional.
  }
}

export function clearRestartFlag(): void {
  try {
    sessionStorage.removeItem(RESTART_FLAG_KEY);
  } catch {
    // Same fallthrough as set — the flag is best-effort.
  }
}

export function readRestartFlag(): boolean {
  try {
    return sessionStorage.getItem(RESTART_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}
