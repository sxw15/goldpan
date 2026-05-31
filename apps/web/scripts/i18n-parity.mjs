#!/usr/bin/env node
// Parity check: zh.json ↔ en.json key alignment + InspectorKind ↔ inspector.kind_* alignment.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const msgDir = join(here, '..', 'messages');

const zh = JSON.parse(readFileSync(join(msgDir, 'zh.json'), 'utf8'));
const en = JSON.parse(readFileSync(join(msgDir, 'en.json'), 'utf8'));

/** Collect dot-joined keys from nested objects. */
function collect(obj, prefix = '') {
  const out = new Set();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const inner of collect(v, key)) out.add(inner);
    } else {
      out.add(key);
    }
  }
  return out;
}

const zhKeys = collect(zh);
const enKeys = collect(en);

const missing = [];
for (const k of zhKeys) if (!enKeys.has(k)) missing.push(`en missing: ${k}`);
for (const k of enKeys) if (!zhKeys.has(k)) missing.push(`zh missing: ${k}`);

// InspectorKind ↔ inspector.kind_* alignment (keep in sync with
// apps/web/src/components/inspector/payloads/types.ts `InspectorPayload`
// discriminant union).
const INSPECTOR_KINDS = ['entity', 'source', 'interest', 'task'];
for (const k of INSPECTOR_KINDS) {
  if (!zhKeys.has(`inspector.kind_${k}`)) missing.push(`zh missing: inspector.kind_${k}`);
  if (!enKeys.has(`inspector.kind_${k}`)) missing.push(`en missing: inspector.kind_${k}`);
}

if (missing.length > 0) {
  console.error('[i18n-parity] key mismatches:');
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}

console.log('[i18n-parity] OK');
