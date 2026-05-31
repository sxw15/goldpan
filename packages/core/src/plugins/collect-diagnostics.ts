import { AsyncLocalStorage } from 'node:async_hooks';

type Store = { append: (line: string) => void };

const storage = new AsyncLocalStorage<Store>();

/**
 * Runs `fn` with a per-async-context diagnostic sink. Used during URL collection
 * so plugins can record notes that end up in the task log output summary.
 */
export function runWithCollectDiagnostics<T>(
  append: (line: string) => void,
  fn: () => Promise<T>,
): Promise<T> {
  // Async callback so Node keeps the store for the full `await fn()` chain (see Node AsyncLocalStorage docs).
  return storage.run({ append }, async () => fn());
}

/** Append one line to the current collection diagnostics buffer (no-op if outside runWithCollectDiagnostics). */
export function emitCollectDiagnostic(line: string): void {
  storage.getStore()?.append(line);
}
