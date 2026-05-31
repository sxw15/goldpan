#!/usr/bin/env node
/**
 * Strict three-way consistency check between:
 *   1. LLM_STEPS in apps/web/src/app/settings/llm-steps.ts
 *   2. GOLDPAN_LLM_<STEP> zod defaults in packages/core/src/config/index.ts
 *   3. MANAGED_ENV_KEYS in packages/core/src/onboarding/env-file.ts
 *
 * Invariants:
 *   - Every LLM_STEPS[i].envKey is in MANAGED_ENV_KEYS
 *   - Every LLM_STEPS[i].defaultProviderModel matches the zod default
 *   - Every GOLDPAN_LLM_<STEP> in MANAGED_ENV_KEYS (excluding *_ENABLED /
 *     *_OPTIONS / *_TIMEOUT / *_LOG_PAYLOADS / *_PROVIDER_*) appears in LLM_STEPS
 *
 * Hard-fails on drift (exit 1) so root `pnpm lint` keeps the contract honest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const llmStepsPath = path.join(repoRoot, 'apps/web/src/app/settings/llm-steps.ts');
const coreConfigPath = path.join(repoRoot, 'packages/core/src/config/index.ts');
const onboardingPath = path.join(repoRoot, 'packages/core/src/onboarding/env-file.ts');

function fail(msg) {
  console.error(`[sync-llm-steps] ${msg}`);
  process.exit(1);
}

/**
 * Extract `MANAGED_ENV_KEYS` literal members. Same approach as
 * sync-managed-env-keys.mjs — relies on the array being a string-literal
 * `as const` block that doesn't import or interpolate.
 */
function parseManagedKeys(text) {
  const start = text.indexOf('MANAGED_ENV_KEYS = [');
  if (start < 0) fail('MANAGED_ENV_KEYS declaration not found in env-file.ts');
  const end = text.indexOf('] as const', start);
  if (end < 0) fail('MANAGED_ENV_KEYS terminator `] as const` not found');
  return new Set([...text.slice(start, end).matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]));
}

/**
 * Extract `GOLDPAN_LLM_<X>: ...default('<provider:model>')` pairs from core
 * config zod schema. Two flavours coexist:
 *   modelIdSchema.default('openai:gpt-4o-mini')
 *   z.string().default('openai:gpt-4o-mini')   // verifier
 * We accept both because both produce a string default.
 */
function parseZodDefaults(text) {
  const out = new Map();
  const RE =
    /(GOLDPAN_LLM_[A-Z_]+):\s*(?:modelIdSchema|z\.string\(\))\s*\.default\(\s*'([^']+)',?\s*\)/g;
  for (const m of text.matchAll(RE)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/**
 * Extract LLM_STEPS entries. Two-stage parse: first carve out the array
 * body between `LLM_STEPS = [` ... `];`, then find each top-level `{ ... }`
 * block (depth-tracked so nested `{ conditional: {...} }` doesn't split a
 * step in two), then pull `id` / `envKey` / `defaultProviderModel` fields
 * with field-order-agnostic regex. This way Biome / engineer reordering the
 * field declarations doesn't silently break the lint guard.
 */
function parseLlmSteps(text) {
  const arrStart = text.indexOf('LLM_STEPS');
  if (arrStart < 0) fail('LLM_STEPS declaration not found');
  const open = text.indexOf('[', arrStart);
  if (open < 0) fail('LLM_STEPS opening `[` not found');
  // Walk depth from `[` to find the matching `]`, ignoring brackets/braces
  // that appear inside string literals. Crude but adequate for our literal
  // data shape (no template literals, no comments inside string values).
  let depth = 0;
  let close = -1;
  let inStr = null; // null | "'" | '"'
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = ch;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) fail('LLM_STEPS terminator `]` not found');
  const body = text.slice(open + 1, close);

  // Carve top-level `{ ... }` blocks.
  const blocks = [];
  let braceDepth = 0;
  let blockStart = -1;
  inStr = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = ch;
      continue;
    }
    if (ch === '{') {
      if (braceDepth === 0) blockStart = i;
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      if (braceDepth === 0 && blockStart >= 0) {
        blocks.push(body.slice(blockStart, i + 1));
        blockStart = -1;
      }
    }
  }

  const out = [];
  for (const blk of blocks) {
    const idM = blk.match(/\bid:\s*'([^']+)'/);
    const envM = blk.match(/\benvKey:\s*'([^']+)'/);
    const defM = blk.match(/\bdefaultProviderModel:\s*'([^']+)'/);
    if (!idM || !envM || !defM) {
      fail(`LLM_STEPS block missing required fields: ${blk.slice(0, 60)}…`);
    }
    out.push({ id: idM[1], envKey: envM[1], defaultProviderModel: defM[1] });
  }
  if (out.length === 0) fail('LLM_STEPS body parsed but contained no entries');
  return out;
}

const managedKeys = parseManagedKeys(fs.readFileSync(onboardingPath, 'utf8'));
const zodDefaults = parseZodDefaults(fs.readFileSync(coreConfigPath, 'utf8'));
const steps = parseLlmSteps(fs.readFileSync(llmStepsPath, 'utf8'));

const errors = [];

for (const s of steps) {
  if (!managedKeys.has(s.envKey)) {
    errors.push(`LLM_STEPS[${s.id}].envKey '${s.envKey}' is not in MANAGED_ENV_KEYS`);
  }
  const expected = zodDefaults.get(s.envKey);
  if (expected === undefined) {
    errors.push(`No zod default found in core/config for ${s.envKey}`);
  } else if (expected !== s.defaultProviderModel) {
    errors.push(
      `LLM_STEPS[${s.id}].defaultProviderModel='${s.defaultProviderModel}' ` +
        `but zod default is '${expected}'`,
    );
  }
}

const stepEnvKeys = new Set(steps.map((s) => s.envKey));
// Editable LLM step env keys: GOLDPAN_LLM_<X> excluding flags/options/internal
// settings — the matrix only edits the model id, not these meta keys.
const SKIP_SUFFIXES = ['_ENABLED', '_OPTIONS', '_TIMEOUT', '_LOG_PAYLOADS'];
const SKIP_PREFIXES = ['GOLDPAN_LLM_PROVIDER_'];
for (const k of managedKeys) {
  if (!k.startsWith('GOLDPAN_LLM_')) continue;
  if (SKIP_SUFFIXES.some((s) => k.endsWith(s))) continue;
  if (SKIP_PREFIXES.some((p) => k.startsWith(p))) continue;
  if (!stepEnvKeys.has(k)) {
    errors.push(`MANAGED_ENV_KEYS contains '${k}' but LLM_STEPS does not list it`);
  }
}

if (errors.length === 0) process.exit(0);

console.error('[sync-llm-steps] LLM_STEPS / core config / MANAGED_ENV_KEYS drift:');
for (const e of errors) console.error(`  - ${e}`);
console.error('');
console.error('Resolution:');
console.error(
  '  - If you changed a zod default, mirror it in apps/web/src/app/settings/llm-steps.ts',
);
console.error('  - If you added a new LLM step env, add it to all three files');
process.exit(1);
