import { describe, expect, test } from 'vitest';
import { PIPELINE_ERROR_KINDS as CORE_KINDS } from '../../core/src/errors.ts';
import { TASK_ERROR_KINDS as SDK_KINDS } from '../src/types.js';

// Guards the web's error-kind localization against silent divergence from core.
// web-sdk re-declares the list (self-contained-types rule) instead of importing
// core; this test is the only thing keeping the two honest. Adding a kind to
// core `PIPELINE_ERROR_KINDS` without mirroring it here turns "user sees a
// generic '处理失败' forever" into a red CI. Mirrors managed-env-keys-sync.test.ts.
describe('TASK_ERROR_KINDS web-sdk ↔ core parity', () => {
  test('arrays are identical and in the same order', () => {
    expect([...SDK_KINDS]).toEqual([...CORE_KINDS]);
  });

  test("includes the 'unknown' fallback kind", () => {
    // localizeErrorKind() collapses unrecognized kinds to 'unknown'; if that key
    // ever leaves the list the fallback would resolve to a non-existent message.
    expect(SDK_KINDS).toContain('unknown');
  });
});
