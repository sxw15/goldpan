import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = path.join(import.meta.dirname, 'create-plugin.mjs');
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function run(args, { cwd, env } = {}) {
  return execFileSync('node', [SCRIPT, ...args], {
    cwd: cwd ?? REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('create-plugin CLI', () => {
  it('rejects unknown type', () => {
    assert.throws(() => run(['banana', 'myslug']), /unknown type/i);
  });

  it('rejects slug starting with a known type prefix', () => {
    assert.throws(
      () => run(['tool-search', 'collector-foo']),
      /slug cannot start with a known type prefix/i,
    );
  });

  it('generates a plugin directory under plugins/', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'create-plugin-'));
    const fakeRepo = path.join(tmp, 'monorepo');
    const realExamples = path.join(REPO_ROOT, 'docs', 'example-plugins');
    execFileSync('mkdir', ['-p', path.join(fakeRepo, 'plugins'), path.join(fakeRepo, 'docs')]);
    execFileSync('cp', ['-R', realExamples, path.join(fakeRepo, 'docs', 'example-plugins')]);
    try {
      run(['collector', 'myfetcher'], { env: { GOLDPAN_REPO_ROOT: fakeRepo } });
      const targetDir = path.join(fakeRepo, 'plugins', 'collector-myfetcher');
      assert.ok(existsSync(targetDir), 'target directory should exist');
      const pkg = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf8'));
      assert.equal(pkg.name, '@goldpan/plugin-collector-myfetcher');
      const readme = readFileSync(path.join(targetDir, 'README.md'), 'utf8');
      assert.ok(!readme.includes('__SLUG__'), 'README should have substituted __SLUG__');
      assert.ok(
        !readme.includes('__PACKAGE_NAME__'),
        'README should have substituted __PACKAGE_NAME__',
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses slugs that collide with example-plugins workspace entries', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'create-plugin-'));
    const fakeRepo = path.join(tmp, 'monorepo');
    const realExamples = path.join(REPO_ROOT, 'docs', 'example-plugins');
    execFileSync('mkdir', ['-p', path.join(fakeRepo, 'plugins'), path.join(fakeRepo, 'docs')]);
    execFileSync('cp', ['-R', realExamples, path.join(fakeRepo, 'docs', 'example-plugins')]);
    try {
      // `noop` collides because docs/example-plugins/collector-noop already
      // declares `@goldpan/plugin-collector-noop`; pnpm install would error
      // with a duplicate workspace package name. Same for the other 5 example
      // types (intent-noop / tool-search-noop / im-noop / llm-noop / settings-only-noop).
      assert.throws(
        () => run(['collector', 'noop'], { env: { GOLDPAN_REPO_ROOT: fakeRepo } }),
        /collides with example plugin/i,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite existing plugin directory', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'create-plugin-'));
    const fakeRepo = path.join(tmp, 'monorepo');
    const realExamples = path.join(REPO_ROOT, 'docs', 'example-plugins');
    execFileSync('mkdir', [
      '-p',
      path.join(fakeRepo, 'plugins', 'collector-exists'),
      path.join(fakeRepo, 'docs'),
    ]);
    execFileSync('cp', ['-R', realExamples, path.join(fakeRepo, 'docs', 'example-plugins')]);
    try {
      assert.throws(
        () => run(['collector', 'exists'], { env: { GOLDPAN_REPO_ROOT: fakeRepo } }),
        /already exists/i,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
