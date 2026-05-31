// apps/server/tests/routes/onboarding/runtime-info.test.ts
import { describe, expect, test } from 'vitest';
import { detectSupervisor } from '../../../src/routes/onboarding/runtime-info.js';

describe('detectSupervisor', () => {
  test('respects SUPERVISED_BY_DOCKER', () => {
    expect(detectSupervisor({ SUPERVISED_BY_DOCKER: 'true' } as NodeJS.ProcessEnv)).toBe('docker');
  });

  test('respects SUPERVISED_BY_SCRIPT', () => {
    expect(detectSupervisor({ SUPERVISED_BY_SCRIPT: 'true' } as NodeJS.ProcessEnv)).toBe(
      'supervised',
    );
  });

  test('detects concurrently dev mode via npm_lifecycle_event', () => {
    expect(detectSupervisor({ npm_lifecycle_event: 'dev' } as NodeJS.ProcessEnv)).toBe(
      'concurrently',
    );
  });

  test('detects concurrently start mode via npm_lifecycle_event', () => {
    expect(detectSupervisor({ npm_lifecycle_event: 'start' } as NodeJS.ProcessEnv)).toBe(
      'concurrently',
    );
  });

  test('detects concurrently dev:run mode (direct supervisor bypass)', () => {
    expect(detectSupervisor({ npm_lifecycle_event: 'dev:run' } as NodeJS.ProcessEnv)).toBe(
      'concurrently',
    );
  });

  test('SUPERVISED_BY_SCRIPT wins over npm_lifecycle_event=dev (pnpm dev under supervisor)', () => {
    expect(
      detectSupervisor({
        SUPERVISED_BY_SCRIPT: 'true',
        npm_lifecycle_event: 'dev',
      } as NodeJS.ProcessEnv),
    ).toBe('supervised');
  });

  test('falls back to unknown for unrelated lifecycle events', () => {
    expect(detectSupervisor({ npm_lifecycle_event: 'test' } as NodeJS.ProcessEnv)).toBe('unknown');
  });

  test('falls back to unknown', () => {
    expect(detectSupervisor({} as NodeJS.ProcessEnv)).toBe('unknown');
  });
});
