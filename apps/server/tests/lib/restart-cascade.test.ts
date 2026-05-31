// apps/server/tests/lib/restart-cascade.test.ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { unstickTsxWatchParent } from '../../src/lib/restart-cascade.js';

describe('unstickTsxWatchParent', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Mock process.kill at the call site so we observe whether the helper
    // would have signalled the parent — without actually sending a signal
    // up the test runner's process tree.
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  test('sends SIGTERM to ppid when npm_lifecycle_event=dev', () => {
    unstickTsxWatchParent({ npm_lifecycle_event: 'dev' } as NodeJS.ProcessEnv);
    expect(killSpy).toHaveBeenCalledWith(process.ppid, 'SIGTERM');
  });

  test('NOOP when npm_lifecycle_event=start (production, no tsx watch)', () => {
    unstickTsxWatchParent({ npm_lifecycle_event: 'start' } as NodeJS.ProcessEnv);
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('NOOP when npm_lifecycle_event is undefined (bare node, docker entrypoint, etc.)', () => {
    unstickTsxWatchParent({} as NodeJS.ProcessEnv);
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('swallows kill errors (parent gone / no permission) — caller is exiting anyway', () => {
    killSpy.mockImplementation(() => {
      throw new Error('ESRCH: parent process not found');
    });
    expect(() =>
      unstickTsxWatchParent({ npm_lifecycle_event: 'dev' } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
