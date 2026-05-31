#!/usr/bin/env node
/**
 * Strict consistency check between `.env.example` (single source of truth for
 * Goldpan's env field schema) and `MANAGED_ENV_KEYS` (the whitelist
 * onboarding wizard / settings UI use when writing back to `.env`).
 *
 * Invariant: every key in `MANAGED_ENV_KEYS` MUST exist in `.env.example`.
 * Otherwise writeEnvFile would persist a field that has no documented
 * counterpart in the canonical template — a drift bug, not a soft warning.
 *
 * Hard-fails on drift (exit 1) so CI / `pnpm lint` keeps the contract honest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const envExamplePath = path.join(repoRoot, '.env.example');
const onboardingPath = path.join(repoRoot, 'packages/core/src/onboarding/env-file.ts');

/**
 * Extract env keys from `.env.example`. Matches both active (`KEY=value`) and
 * commented-out template (`# KEY=value`) lines — both are field declarations.
 * Plain prose mentioning a key without an `=` is ignored.
 */
function parseEnvExampleKeys(text) {
  const keys = new Set();
  const RE = /^\s*#?\s*([A-Z][A-Z0-9_]+)=/;
  for (const line of text.split('\n')) {
    const m = line.match(RE);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * Extract the literal array members of `MANAGED_ENV_KEYS`. We avoid importing
 * the TS module (this script runs at lint time without a build step) and rely
 * on the array being a plain string-literal `as const` block.
 */
function parseManagedKeys(text) {
  const start = text.indexOf('MANAGED_ENV_KEYS = [');
  if (start < 0) {
    console.error('[sync-managed-env-keys] MANAGED_ENV_KEYS declaration not found');
    process.exit(1);
  }
  const end = text.indexOf('] as const', start);
  if (end < 0) {
    console.error('[sync-managed-env-keys] MANAGED_ENV_KEYS terminator `] as const` not found');
    process.exit(1);
  }
  const block = text.slice(start, end);
  return new Set([...block.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]));
}

const envExampleKeys = parseEnvExampleKeys(fs.readFileSync(envExamplePath, 'utf8'));
const managedKeys = parseManagedKeys(fs.readFileSync(onboardingPath, 'utf8'));

const missing = [...managedKeys].filter((k) => !envExampleKeys.has(k)).sort();

if (missing.length === 0) {
  process.exit(0);
}

console.error('[sync-managed-env-keys] MANAGED_ENV_KEYS references keys absent from .env.example:');
for (const k of missing) console.error(`  - ${k}`);
console.error('');
console.error('Resolution: either');
console.error(
  '  (a) add the key to .env.example (preferred — .env.example is the source of truth), OR',
);
console.error(
  '  (b) remove the key from MANAGED_ENV_KEYS in packages/core/src/onboarding/env-file.ts',
);
process.exit(1);
