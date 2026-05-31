import { describe, expect, it } from 'vitest';
import {
  emitCollectDiagnostic,
  runWithCollectDiagnostics,
} from '../../src/plugins/collect-diagnostics.js';

describe('collect-diagnostics', () => {
  it('buffers lines only inside runWithCollectDiagnostics', async () => {
    const lines: string[] = [];
    emitCollectDiagnostic('orphan');
    expect(lines).toEqual([]);

    await runWithCollectDiagnostics(
      (line) => lines.push(line),
      async () => {
        emitCollectDiagnostic('a');
        emitCollectDiagnostic('b');
        return 1;
      },
    );

    expect(lines).toEqual(['a', 'b']);
    emitCollectDiagnostic('after');
    expect(lines).toEqual(['a', 'b']);
  });

  it('isolates concurrent async contexts', async () => {
    const a: string[] = [];
    const b: string[] = [];

    const p1 = runWithCollectDiagnostics(
      (line) => a.push(line),
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        emitCollectDiagnostic('1');
        return 'p1';
      },
    );
    const p2 = runWithCollectDiagnostics(
      (line) => b.push(line),
      async () => {
        emitCollectDiagnostic('2');
        return 'p2';
      },
    );

    await Promise.all([p1, p2]);
    expect(a).toEqual(['1']);
    expect(b).toEqual(['2']);
  });
});
