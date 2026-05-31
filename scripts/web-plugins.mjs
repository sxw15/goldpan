#!/usr/bin/env node
/**
 * Web plugin protocol helper. Subcommands:
 *
 *   list           — print available web packages (built-in apps/web + plugins/web-*).
 *   run start|dev  — load .env, validate GOLDPAN_WEB_PACKAGE, then spawn the
 *                    underlying `pnpm --filter <pkg> <script>` with PORT injected.
 *                    Also forwards SIGINT / SIGTERM so concurrently can shut us down.
 *
 * Pure functions (loadDotenv, discoverWebPackages, findPackage, preCheck,
 * formatList) are exported so node:test can drive them with fixture directories.
 *
 * Spec: docs/superpowers/specs/2026-05-03-web-plugin-protocol-design.md
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

export const BUILTIN_PACKAGE_NAME = '@goldpan/web';
export const BUILTIN_DISPLAY_NAME = 'Built-in default';
export const BUILTIN_RELATIVE_PATH = 'apps/web';

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// pnpm does not auto-source .env, so shell-expanded ${GOLDPAN_WEB_PACKAGE:-...}
// would silently fall back to the builtin even when .env names a plugin. We
// parse .env ourselves and merge it into env (existing process.env wins, matching
// "shell export overrides .env" precedence used elsewhere in the project).
export function loadDotenv(rootDir = repoRoot) {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const inlineComment = value.match(/^([^#'"]*?)\s+#.*$/);
    if (inlineComment) value = inlineComment[1];
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

export function discoverWebPackages(rootDir = repoRoot) {
  const results = [];

  const builtinPkg = readJsonSafe(path.join(rootDir, 'apps/web/package.json'));
  if (builtinPkg?.name) {
    results.push({
      name: builtinPkg.name,
      displayName: BUILTIN_DISPLAY_NAME,
      description: undefined,
      homepage: undefined,
      relativePath: BUILTIN_RELATIVE_PATH,
      scripts: {
        dev: builtinPkg.scripts?.dev,
        start: builtinPkg.scripts?.start,
      },
      builtin: true,
    });
  }

  const pluginsDir = path.join(rootDir, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    const entries = fs
      .readdirSync(pluginsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('web-'))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const folder = path.join(pluginsDir, entry.name);
      const pkg = readJsonSafe(path.join(folder, 'package.json'));
      if (!isNonEmptyString(pkg?.name)) continue;
      const meta = pkg.goldpan?.web;
      if (!isNonEmptyString(meta?.displayName)) continue;
      if (!isNonEmptyString(pkg.scripts?.dev) || !isNonEmptyString(pkg.scripts?.start)) continue;
      results.push({
        name: pkg.name,
        displayName: meta.displayName,
        description: isNonEmptyString(meta.description) ? meta.description : undefined,
        homepage: isNonEmptyString(meta.homepage) ? meta.homepage : undefined,
        minServerApiVersion: isNonEmptyString(meta.minServerApiVersion)
          ? meta.minServerApiVersion
          : undefined,
        relativePath: `plugins/${entry.name}`,
        scripts: { dev: pkg.scripts.dev, start: pkg.scripts.start },
        builtin: false,
      });
    }
  }

  return results;
}

// Workspace scope for web-package resolution: apps/* and plugins/* directories.
// Mirrors pnpm-workspace.yaml minus packages/* (library packages, not runnable apps).
const WORKSPACE_SUBDIRS = ['apps', 'plugins'];

export function findPackage(packageName, rootDir = repoRoot) {
  for (const subdir of WORKSPACE_SUBDIRS) {
    const dir = path.join(rootDir, subdir);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = path.join(dir, entry.name, 'package.json');
      const pkg = readJsonSafe(pkgPath);
      if (pkg?.name === packageName) {
        return {
          pkg,
          relativePath: path.relative(rootDir, path.dirname(pkgPath)),
        };
      }
    }
  }
  return null;
}

export function preCheck(scriptName, env, rootDir = repoRoot) {
  const requested = env.GOLDPAN_WEB_PACKAGE;
  if (!requested || requested === BUILTIN_PACKAGE_NAME) {
    return { ok: true };
  }
  const found = findPackage(requested, rootDir);
  if (!found) {
    return {
      ok: false,
      message:
        `✗ GOLDPAN_WEB_PACKAGE='${requested}' not found in workspace.\n` +
        `  Run 'pnpm web:list' to see available web packages.`,
    };
  }
  const { pkg, relativePath } = found;
  const meta = pkg.goldpan?.web;

  // Without a string displayName the package has not opted in as a web app.
  // Required so non-web packages (e.g. @goldpan/server, which has dev/start
  // scripts of its own) get rejected loudly instead of being launched as the
  // web child by `pnpm web:start`.
  if (!isNonEmptyString(meta?.displayName)) {
    return {
      ok: false,
      message:
        `✗ Package '${requested}' is not registered as a web app.\n` +
        `  Add 'goldpan.web.displayName' (string) to ${relativePath}/package.json, ` +
        `or set GOLDPAN_WEB_PACKAGE to a package that declares it.`,
    };
  }

  if (!isNonEmptyString(pkg.scripts?.[scriptName])) {
    return {
      ok: false,
      message:
        `✗ Package '${requested}' has no '${scriptName}' script.\n` +
        `  Add it to ${relativePath}/package.json or set GOLDPAN_WEB_PACKAGE ` +
        `to a package that has one.`,
    };
  }
  return { ok: true };
}

export function formatList(packages, currentPackage) {
  const lines = [];
  const current = currentPackage || BUILTIN_PACKAGE_NAME;
  const headerSuffix = current === BUILTIN_PACKAGE_NAME ? ' — built-in default' : '';
  lines.push(`Available web packages (current: ${current}${headerSuffix})`);
  lines.push('');
  for (const pkg of packages) {
    const isActive = pkg.name === current;
    const marker = isActive ? '✓' : ' ';
    lines.push(
      `  ${marker} ${pkg.name.padEnd(34)}${pkg.displayName.padEnd(22)}(${pkg.relativePath})`,
    );
    if (pkg.description) lines.push(`    ${' '.repeat(34)}${pkg.description}`);
    if (pkg.homepage) lines.push(`    ${' '.repeat(34)}${pkg.homepage}`);
  }
  lines.push('');
  lines.push('To switch: set GOLDPAN_WEB_PACKAGE=<name> in .env');
  return lines.join('\n');
}

// process.env wins over .env so a one-off shell override (`GOLDPAN_WEB_PACKAGE=...
// pnpm web:start`) keeps working.
function mergedEnv(rootDir = repoRoot) {
  return { ...loadDotenv(rootDir), ...process.env };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const subcommand = process.argv[2];
  const args = process.argv.slice(3);
  const env = mergedEnv();
  if (subcommand === 'list') {
    const packages = discoverWebPackages();
    console.log(formatList(packages, env.GOLDPAN_WEB_PACKAGE));
    process.exit(0);
  } else if (subcommand === 'run') {
    const scriptName = args[0];
    if (scriptName !== 'start' && scriptName !== 'dev') {
      console.error(`web-plugins.mjs run: expected 'start' or 'dev', got '${scriptName}'`);
      process.exit(1);
    }
    const result = preCheck(scriptName, env);
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
    const targetPackage = env.GOLDPAN_WEB_PACKAGE || BUILTIN_PACKAGE_NAME;
    const port = env.GOLDPAN_WEB_PORT || '3000';
    const child = spawn('pnpm', ['--filter', targetPackage, scriptName], {
      stdio: 'inherit',
      env: { ...process.env, ...env, PORT: port },
    });
    const forward = (signal) => () => {
      if (!child.killed) child.kill(signal);
    };
    process.on('SIGINT', forward('SIGINT'));
    process.on('SIGTERM', forward('SIGTERM'));
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 1);
    });
  } else {
    console.error(`web-plugins.mjs: unknown subcommand '${subcommand}' (expected: list | run)`);
    process.exit(1);
  }
}
