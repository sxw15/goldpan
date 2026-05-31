import {
  type BootstrapHandle,
  type BootstrapOptions,
  bootstrap,
  type WizardBootstrapHandle,
} from '../../src/bootstrap';

/**
 * Test bootstrap wrapper. Captures process.env at call time as bootEnv.
 * Tests that mutate process.env BEFORE calling bootstrapForTest see those
 * mutations in bootEnv (matching real apps/server/main.ts behavior).
 *
 * Mirrors bootstrap's 3-overload mode-keyed dispatch so callers get the
 * narrow handle type back.
 */
export function bootstrapForTest(
  options: Omit<BootstrapOptions, 'bootEnv'> & { mode: 'wizard' },
): Promise<WizardBootstrapHandle>;
export function bootstrapForTest(
  options: Omit<BootstrapOptions, 'bootEnv'> & { mode: 'normal' },
): Promise<BootstrapHandle>;
export function bootstrapForTest(
  options: Omit<BootstrapOptions, 'bootEnv'> & { mode?: 'auto' },
): Promise<BootstrapHandle | WizardBootstrapHandle>;
export async function bootstrapForTest(
  options: Omit<BootstrapOptions, 'bootEnv'>,
): Promise<BootstrapHandle | WizardBootstrapHandle> {
  // Bypass bootstrap's mode-keyed overloads inside the implementation —
  // the public overloads above already narrow the return type for callers.
  const bootstrapBase = bootstrap as (
    opts: BootstrapOptions,
  ) => Promise<BootstrapHandle | WizardBootstrapHandle>;
  return bootstrapBase({ ...options, bootEnv: { ...process.env } });
}
