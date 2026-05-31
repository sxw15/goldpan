#!/usr/bin/env node
/**
 * Audit: list files where the same module string appears more than once
 * after `from` (covers `import ... from` and `export ... from`).
 * Run from monorepo root: `node scripts/find-duplicate-imports.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.name === 'node_modules' || ent.name === '.next' || ent.name === 'dist') continue;
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name) && !ent.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const fromRe = /\bfrom\s+['"]([^'"]+)['"]/g;
const files = walk(root);
const report = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const counts = new Map();
  let m = fromRe.exec(src);
  while (m !== null) {
    const spec = m[1];
    counts.set(spec, (counts.get(spec) || 0) + 1);
    m = fromRe.exec(src);
  }
  for (const [spec, n] of counts) {
    if (n > 1) report.push({ file: path.relative(root, file), spec, n });
  }
}

report.sort((a, b) => a.file.localeCompare(b.file) || a.spec.localeCompare(b.spec));
for (const r of report) {
  console.log(`${r.n}x ${r.spec}`);
  console.log(`   ${r.file}`);
}
console.log(
  report.length === 0
    ? 'OK — no duplicate `from` specifiers per file.'
    : `\n${report.length} duplicate module specifiers (merge or accept intentionally).`,
);
