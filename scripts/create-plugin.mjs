#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

// settings-only-noop is documentation-only — not a CLI-creatable plugin type
// (settings-only is a degenerate ToolPlugin without tools; users who want this
// can copy docs/example-plugins/settings-only-noop/ by hand).
const VALID_TYPES = ['collector', 'intent', 'tool-search', 'im', 'llm'];

const TYPE_PREFIXES = ['collector-', 'intent-', 'tool-search-', 'im-', 'llm-', 'web-'];

function die(message) {
  process.stderr.write(`create-plugin: ${message}\n`);
  process.exit(1);
}

const [type, slug] = process.argv.slice(2);
if (!type || !slug) {
  die(`usage: pnpm create-plugin <type> <slug>\nvalid types: ${VALID_TYPES.join(', ')}`);
}
if (!VALID_TYPES.includes(type)) {
  die(`unknown type "${type}". valid: ${VALID_TYPES.join(', ')}`);
}
if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
  die(`slug "${slug}" must match /^[a-z][a-z0-9-]*$/`);
}
if (TYPE_PREFIXES.some((p) => slug.startsWith(p))) {
  die(`slug cannot start with a known type prefix (${TYPE_PREFIXES.join(', ')})`);
}

const repoRoot = process.env.GOLDPAN_REPO_ROOT ?? path.resolve(import.meta.dirname, '..');

const templateDir = path.join(repoRoot, 'docs', 'example-plugins', `${type}-noop`);
if (!existsSync(templateDir)) {
  die(`template not found: ${templateDir}\n(checked GOLDPAN_REPO_ROOT=${repoRoot})`);
}

const pluginDirName = `${type}-${slug}`;
const targetDir = path.join(repoRoot, 'plugins', pluginDirName);
if (existsSync(targetDir)) {
  die(`target "${targetDir}" already exists; choose another slug`);
}
// docs/example-plugins/* is also in pnpm-workspace.yaml, so a slug that
// produces the same dir name there would create two workspace packages with
// identical names (`pnpm install` errors with duplicate package name).
const exampleCollisionDir = path.join(repoRoot, 'docs', 'example-plugins', pluginDirName);
if (existsSync(exampleCollisionDir)) {
  die(
    `slug "${slug}" collides with example plugin at "${exampleCollisionDir}" — ` +
      `would produce duplicate workspace package name "@goldpan/plugin-${pluginDirName}". ` +
      `choose another slug.`,
  );
}

const packageName = `@goldpan/plugin-${pluginDirName}`;

const SKIP_DIRS = new Set(['node_modules', 'dist']);

function isTextFile(file) {
  return [
    '.json',
    '.ts',
    '.tsx',
    '.md',
    '.mjs',
    '.js',
    '.yaml',
    '.yml',
    '.css',
    '.html',
    '.toml',
  ].some((ext) => file.endsWith(ext));
}

function copyRecursive(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const dstPath = path.join(dst, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      copyRecursive(srcPath, dstPath);
    } else if (isTextFile(srcPath)) {
      // `__SLUG__` and `__PACKAGE_NAME__` are placeholders ONLY in README.md text.
      // The two `${type}-noop` substitutions rewrite identifiers tied to the plugin
      // name (package name + pluginId). Bare `noop` (e.g. `searchEngine: 'noop'`,
      // `'noop://'`) is intentionally preserved — it's example runtime data the
      // user replaces when implementing real logic.
      const content = readFileSync(srcPath, 'utf8')
        .replaceAll('__SLUG__', slug)
        .replaceAll('__PACKAGE_NAME__', packageName)
        .replaceAll(`@goldpan/plugin-${type}-noop`, packageName)
        .replaceAll(`${type}-noop`, pluginDirName);
      writeFileSync(dstPath, content);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

copyRecursive(templateDir, targetDir);

process.stdout.write(`\nGenerated ${targetDir}\n\n`);
process.stdout.write(`Next steps:\n`);
process.stdout.write(`  1. cd monorepo && pnpm install\n`);
process.stdout.write(`  2. Edit ${path.relative(repoRoot, targetDir)}/src/index.ts\n`);
process.stdout.write(`  3. pnpm -r build\n`);
process.stdout.write(`  4. pnpm dev (then open http://localhost:3000/settings)\n\n`);
process.stdout.write(`Authoring guide: .agent/plugin-authoring-guide.md\n`);
