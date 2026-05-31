#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const monorepoRoot = resolve(import.meta.dirname, '..');

const PKG_DIRS = {
  '@goldpan/core': 'packages/core',
  '@goldpan/im-runtime': 'packages/im-runtime',
  '@goldpan/web-sdk': 'packages/web-sdk',
  '@goldpan/plugin-collector-browser': 'plugins/collector-browser',
  '@goldpan/plugin-collector-media': 'plugins/collector-media',
  '@goldpan/plugin-github-collector': 'plugins/github-collector',
  '@goldpan/plugin-github-intent': 'plugins/github-intent',
  '@goldpan/plugin-digest': 'plugins/digest',
  '@goldpan/plugin-im-feishu': 'plugins/im-feishu',
  '@goldpan/plugin-tool-search-brave': 'plugins/tool-search-brave',
  '@goldpan/plugin-tool-search-exa': 'plugins/tool-search-exa',
  '@goldpan/plugin-tool-search-google': 'plugins/tool-search-google',
  '@goldpan/plugin-tool-search-searxng': 'plugins/tool-search-searxng',
  '@goldpan/plugin-tool-search-serper': 'plugins/tool-search-serper',
  '@goldpan/plugin-tool-search-tavily': 'plugins/tool-search-tavily',
  '@goldpan/plugin-tracking': 'plugins/tracking',
};

// Walk a directory subtree and return the latest mtimeMs across all files.
// Returns 0 when the path doesn't exist so callers can treat "missing" as
// "definitely older than anything".
function latestMtime(root) {
  if (!existsSync(root)) return 0;
  let latest = 0;
  const stack = [root];
  while (stack.length > 0) {
    const path = stack.pop();
    const st = statSync(path);
    if (st.isDirectory()) {
      for (const name of readdirSync(path)) stack.push(resolve(path, name));
    } else if (st.mtimeMs > latest) {
      latest = st.mtimeMs;
    }
  }
  return latest;
}

// Prefer exports['.'].import over .default — dual-build packages (e.g. @goldpan/core) point .default at src.
// Loud fallback so a malformed package.json doesn't silently make the wrong file authoritative.
function entryArtefact(pkgRoot) {
  const pkgJsonPath = resolve(pkgRoot, 'package.json');
  const fallback = resolve(pkgRoot, 'dist/index.js');
  if (!existsSync(pkgJsonPath)) {
    console.warn(
      `[ensure-built] package.json not found at ${pkgJsonPath}, falling back to dist/index.js`,
    );
    return fallback;
  }
  let pkgJson;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch (err) {
    console.warn(
      `[ensure-built] package.json malformed at ${pkgJsonPath} (${err.message}), falling back to dist/index.js`,
    );
    return fallback;
  }
  const dotExport = pkgJson?.exports?.['.'];
  if (dotExport && typeof dotExport === 'object') {
    const entry = dotExport.import ?? dotExport.default;
    if (typeof entry === 'string' && entry.startsWith('./dist/')) {
      return resolve(pkgRoot, entry);
    }
    console.warn(
      `[ensure-built] ${pkgRoot}: exports['.'] does not point at ./dist/*, falling back to dist/index.js`,
    );
  }
  return fallback;
}

// Combine src/ subtree with package.json + tsconfig.json so a deps bump or a
// `tsc` config change also triggers a rebuild — both can change the build
// output without touching any .ts file.
function inputsMtime(pkgRoot) {
  const candidates = [
    resolve(pkgRoot, 'src'),
    resolve(pkgRoot, 'package.json'),
    resolve(pkgRoot, 'tsconfig.json'),
  ];
  let latest = 0;
  for (const path of candidates) {
    const m = latestMtime(path);
    if (m > latest) latest = m;
  }
  return latest;
}

const pkgs = process.argv.slice(2);
if (pkgs.length === 0) {
  console.error('Usage: ensure-built.mjs <pkg> [<pkg> ...]');
  process.exit(1);
}

for (const pkg of pkgs) {
  const dir = PKG_DIRS[pkg];
  if (!dir) {
    console.error(`[ensure-built] unknown package: ${pkg}`);
    process.exit(1);
  }
  const pkgRoot = resolve(monorepoRoot, dir);
  const distMtime = latestMtime(resolve(pkgRoot, 'dist'));
  const srcMtime = inputsMtime(pkgRoot);
  // mtime-only check misses partial builds that emit some files but not the entry → consumers silently fail to import.
  const entry = entryArtefact(pkgRoot);
  const entryMissing = !existsSync(entry);
  if (distMtime > 0 && distMtime >= srcMtime && !entryMissing) continue;
  const reason = entryMissing
    ? 'entry artefact missing'
    : distMtime === 0
      ? 'dist missing'
      : 'src newer than dist';
  console.log(`[ensure-built] ${reason}, building ${pkg}`);
  const result = spawnSync('pnpm', ['--filter', pkg, 'build'], {
    cwd: monorepoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
