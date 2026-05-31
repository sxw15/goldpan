import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  BUILTIN_PACKAGE_NAME,
  discoverWebPackages,
  findPackage,
  formatList,
  loadDotenv,
  preCheck,
} from './web-plugins.mjs';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'web-plugins-test-'));
  mkdirSync(join(root, 'apps/web'), { recursive: true });
  writeFileSync(
    join(root, 'apps/web/package.json'),
    JSON.stringify({
      name: '@goldpan/web',
      scripts: { dev: 'next dev', start: 'next start' },
    }),
  );
  return root;
}

function addPluginsFixture(root) {
  mkdirSync(join(root, 'plugins/web-foo'), { recursive: true });
  writeFileSync(
    join(root, 'plugins/web-foo/package.json'),
    JSON.stringify({
      name: '@goldpan/plugin-web-foo',
      scripts: { dev: 'node server.js', start: 'node server.js' },
      goldpan: {
        web: {
          displayName: 'Foo Theme',
          description: 'A retro UI for Goldpan',
          homepage: 'https://github.com/foo/goldpan-web-foo',
        },
      },
    }),
  );
  mkdirSync(join(root, 'plugins/web-incomplete'), { recursive: true });
  writeFileSync(
    join(root, 'plugins/web-incomplete/package.json'),
    JSON.stringify({
      name: '@goldpan/plugin-web-incomplete',
      scripts: { dev: '...' },
      goldpan: { web: { displayName: 'Incomplete' } },
    }),
  );
  mkdirSync(join(root, 'plugins/collector-x'), { recursive: true });
  writeFileSync(
    join(root, 'plugins/collector-x/package.json'),
    JSON.stringify({ name: '@goldpan/plugin-collector-x' }),
  );
}

describe('web-plugins exports', () => {
  it('exports BUILTIN_PACKAGE_NAME', () => {
    assert.equal(BUILTIN_PACKAGE_NAME, '@goldpan/web');
  });

  it('discoverWebPackages finds built-in', () => {
    const root = makeFixture();
    const pkgs = discoverWebPackages(root);
    assert.equal(pkgs.length, 1);
    assert.equal(pkgs[0].name, '@goldpan/web');
    assert.equal(pkgs[0].builtin, true);
    rmSync(root, { recursive: true, force: true });
  });

  it('findPackage resolves built-in by name', () => {
    const root = makeFixture();
    const found = findPackage('@goldpan/web', root);
    assert.ok(found);
    assert.equal(found.pkg.name, '@goldpan/web');
    rmSync(root, { recursive: true, force: true });
  });

  it('preCheck returns ok when env unset (built-in default)', () => {
    const root = makeFixture();
    const result = preCheck('dev', {}, root);
    assert.equal(result.ok, true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('discoverWebPackages with plugins/web-*', () => {
  it('lists built-in then valid web-* plugins, skipping incomplete dirs and non-web prefixes', () => {
    const root = makeFixture();
    addPluginsFixture(root);
    const pkgs = discoverWebPackages(root);
    const names = pkgs.map((p) => p.name);
    assert.deepEqual(names, ['@goldpan/web', '@goldpan/plugin-web-foo']);
    const foo = pkgs[1];
    assert.equal(foo.displayName, 'Foo Theme');
    assert.equal(foo.description, 'A retro UI for Goldpan');
    assert.equal(foo.homepage, 'https://github.com/foo/goldpan-web-foo');
    assert.equal(foo.relativePath, 'plugins/web-foo');
    rmSync(root, { recursive: true, force: true });
  });

  it('skips plugin whose displayName is not a string (would crash formatList.padEnd)', () => {
    const root = makeFixture();
    mkdirSync(join(root, 'plugins/web-bad'), { recursive: true });
    writeFileSync(
      join(root, 'plugins/web-bad/package.json'),
      JSON.stringify({
        name: '@goldpan/plugin-web-bad',
        scripts: { dev: 'x', start: 'x' },
        goldpan: { web: { displayName: 123 } },
      }),
    );
    const pkgs = discoverWebPackages(root);
    assert.deepEqual(
      pkgs.map((p) => p.name),
      ['@goldpan/web'],
    );
    rmSync(root, { recursive: true, force: true });
  });
});

describe('loadDotenv', () => {
  it('returns empty object when .env is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'web-plugins-test-'));
    assert.deepEqual(loadDotenv(root), {});
    rmSync(root, { recursive: true, force: true });
  });

  it('parses GOLDPAN_WEB_PACKAGE / PORT, ignoring comments + blank lines + quotes', () => {
    const root = mkdtempSync(join(tmpdir(), 'web-plugins-test-'));
    writeFileSync(
      join(root, '.env'),
      [
        '# leading comment',
        '',
        'GOLDPAN_WEB_PACKAGE=@goldpan/plugin-web-foo',
        'GOLDPAN_WEB_PORT="3001"',
        "QUOTED='quoted-value'",
        'WITH_INLINE=value # inline comment',
        'export EXPORTED_KEY=exported-value',
      ].join('\n'),
    );
    const env = loadDotenv(root);
    assert.equal(env.GOLDPAN_WEB_PACKAGE, '@goldpan/plugin-web-foo');
    assert.equal(env.GOLDPAN_WEB_PORT, '3001');
    assert.equal(env.QUOTED, 'quoted-value');
    assert.equal(env.WITH_INLINE, 'value');
    assert.equal(env.EXPORTED_KEY, 'exported-value');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('formatList', () => {
  it('marks active built-in with ✓ and appends "built-in default" tag', () => {
    const root = makeFixture();
    addPluginsFixture(root);
    const pkgs = discoverWebPackages(root);
    const out = formatList(pkgs, BUILTIN_PACKAGE_NAME);
    assert.match(out, /current: @goldpan\/web — built-in default/);
    assert.match(out, /✓ @goldpan\/web/);
    assert.match(out, /@goldpan\/plugin-web-foo/);
    assert.match(out, /Foo Theme/);
    assert.match(out, /A retro UI for Goldpan/);
    rmSync(root, { recursive: true, force: true });
  });

  it('marks active plugin with ✓ when GOLDPAN_WEB_PACKAGE points to it', () => {
    const root = makeFixture();
    addPluginsFixture(root);
    const pkgs = discoverWebPackages(root);
    const out = formatList(pkgs, '@goldpan/plugin-web-foo');
    assert.match(out, /✓ @goldpan\/plugin-web-foo/);
    assert.doesNotMatch(out, /✓ @goldpan\/web\s/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('preCheck branches', () => {
  it('returns ok with no warning for valid plugin web package', () => {
    const root = makeFixture();
    addPluginsFixture(root);
    const result = preCheck('dev', { GOLDPAN_WEB_PACKAGE: '@goldpan/plugin-web-foo' }, root);
    assert.equal(result.ok, true);
    assert.equal(result.warning, undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports missing package with helpful message', () => {
    const root = makeFixture();
    addPluginsFixture(root);
    const result = preCheck('dev', { GOLDPAN_WEB_PACKAGE: '@goldpan/plugin-web-nope' }, root);
    assert.equal(result.ok, false);
    assert.match(result.message, /not found in workspace/);
    assert.match(result.message, /pnpm web:list/);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports missing script with package path', () => {
    const root = makeFixture();
    addPluginsFixture(root);
    const result = preCheck(
      'start',
      { GOLDPAN_WEB_PACKAGE: '@goldpan/plugin-web-incomplete' },
      root,
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /has no 'start' script/);
    assert.match(result.message, /plugins\/web-incomplete\/package\.json/);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects plugins/web-* package that lacks goldpan.web.displayName', () => {
    const root = makeFixture();
    mkdirSync(join(root, 'plugins/web-bare'), { recursive: true });
    writeFileSync(
      join(root, 'plugins/web-bare/package.json'),
      JSON.stringify({
        name: '@goldpan/plugin-web-bare',
        scripts: { dev: 'x', start: 'x' },
      }),
    );
    const result = preCheck('dev', { GOLDPAN_WEB_PACKAGE: '@goldpan/plugin-web-bare' }, root);
    assert.equal(result.ok, false);
    assert.match(result.message, /not registered as a web app/);
    assert.match(result.message, /goldpan\.web\.displayName/);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects non-web app even when it has dev/start scripts (e.g. @goldpan/server)', () => {
    // Without this guard, `GOLDPAN_WEB_PACKAGE=@goldpan/server pnpm dev` would
    // launch server twice (concurrently boots it once, web:start filters it as
    // the web child) and clobber the port.
    const root = makeFixture();
    mkdirSync(join(root, 'apps/server'), { recursive: true });
    writeFileSync(
      join(root, 'apps/server/package.json'),
      JSON.stringify({
        name: '@goldpan/server',
        scripts: { dev: 'tsx watch src/main.ts', start: 'node dist/main.js' },
      }),
    );
    const result = preCheck('dev', { GOLDPAN_WEB_PACKAGE: '@goldpan/server' }, root);
    assert.equal(result.ok, false);
    assert.match(result.message, /not registered as a web app/);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects package whose displayName is not a string', () => {
    const root = makeFixture();
    mkdirSync(join(root, 'plugins/web-typo'), { recursive: true });
    writeFileSync(
      join(root, 'plugins/web-typo/package.json'),
      JSON.stringify({
        name: '@goldpan/plugin-web-typo',
        scripts: { dev: 'x', start: 'x' },
        goldpan: { web: { displayName: 123 } },
      }),
    );
    const result = preCheck('dev', { GOLDPAN_WEB_PACKAGE: '@goldpan/plugin-web-typo' }, root);
    assert.equal(result.ok, false);
    assert.match(result.message, /not registered as a web app/);
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts package outside plugins/web-* when it declares goldpan.web.displayName', () => {
    // Spec lets users place a web app anywhere in apps/* or plugins/* as long
    // as it explicitly declares itself with goldpan.web.displayName.
    const root = makeFixture();
    mkdirSync(join(root, 'apps/web-elsewhere'), { recursive: true });
    writeFileSync(
      join(root, 'apps/web-elsewhere/package.json'),
      JSON.stringify({
        name: '@me/elsewhere',
        scripts: { dev: 'x', start: 'x' },
        goldpan: { web: { displayName: 'Elsewhere UI' } },
      }),
    );
    const result = preCheck('dev', { GOLDPAN_WEB_PACKAGE: '@me/elsewhere' }, root);
    assert.equal(result.ok, true);
    rmSync(root, { recursive: true, force: true });
  });

  it('returns "not found" when package name does not match any workspace member', () => {
    const root = makeFixture();
    addPluginsFixture(root);
    const result = preCheck('dev', { GOLDPAN_WEB_PACKAGE: '@really/missing' }, root);
    assert.equal(result.ok, false);
    assert.match(result.message, /not found in workspace/);
    rmSync(root, { recursive: true, force: true });
  });
});
