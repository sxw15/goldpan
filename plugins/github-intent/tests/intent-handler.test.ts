import { initI18n, resetI18n } from '@goldpan/core/i18n';
import type { ServiceCallLlmFn } from '@goldpan/core/plugins';
import type { GithubService, RefreshResult } from '@goldpan/plugin-github-collector';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../src/i18n/loader.js';
import { handleRefreshGithub } from '../src/intent-handler.js';

// The handler only ever reads the resolved object from callLlm; cast the mock to
// the generic ServiceCallLlmFn so per-test return shapes don't fight the generic.
const asLlm = (fn: (...args: never[]) => unknown): ServiceCallLlmFn => fn as ServiceCallLlmFn;

// loadPluginPrompt (LLM-fallback path) reads core getLanguage(); init it.
beforeEach(() => {
  resetI18n();
  initI18n('en');
});

const t = createTranslator('en');

function mockService(result: RefreshResult): GithubService {
  return {
    refreshRepo: vi.fn(async () => result),
    refreshRepoByNormalizedUrl: vi.fn(async () => result),
    getRepoState: vi.fn(() => null),
  } as unknown as GithubService;
}

describe('handleRefreshGithub — regex path', () => {
  it("parses '刷新 facebook/react' and dispatches to service.refreshRepo", async () => {
    const svc = mockService({ status: 'started', sourceId: 1, taskId: 2 });
    const result = await handleRefreshGithub('刷新 facebook/react', svc, vi.fn(), t, undefined);
    expect(svc.refreshRepo).toHaveBeenCalledWith({ owner: 'facebook', repo: 'react' });
    expect(result.type).toBe('action');
  });

  it('parses vercel/next.js (dot in repo name)', async () => {
    const svc = mockService({ status: 'started', sourceId: 1, taskId: 2 });
    await handleRefreshGithub('refresh vercel/next.js', svc, vi.fn(), t, undefined);
    expect(svc.refreshRepo).toHaveBeenCalledWith({ owner: 'vercel', repo: 'next.js' });
  });

  it('preserves user-provided casing in display message', async () => {
    const svc = mockService({ status: 'started', sourceId: 1, taskId: 2 });
    const result = await handleRefreshGithub('refresh Facebook/React', svc, vi.fn(), t, undefined);
    expect(svc.refreshRepo).toHaveBeenCalledWith({ owner: 'Facebook', repo: 'React' });
    if (result.type === 'action') expect(result.message).toContain('Facebook/React');
  });
});

describe('handleRefreshGithub — LLM fallback', () => {
  it('calls LLM when regex misses and dispatches to service', async () => {
    const svc = mockService({
      status: 'in_progress',
      sourceId: 1,
      taskId: 2,
      startedAt: Date.now(),
    });
    const callLlm = vi.fn((_opts: { step: string; promptHash: string }) =>
      Promise.resolve({ owner: 'facebook', repo: 'react' }),
    );
    const result = await handleRefreshGithub(
      '看看 React 最近怎么样',
      svc,
      asLlm(callLlm),
      t,
      undefined,
    );
    expect(callLlm).toHaveBeenCalled();
    const opts = callLlm.mock.calls[0]?.[0];
    expect(opts?.step).toBe('github_action_parser');
    expect(typeof opts?.promptHash).toBe('string');
    expect(result.type).toBe('action');
  });

  it('returns clarify when LLM returns {error}', async () => {
    const svc = mockService({ status: 'not_found' });
    const callLlm = vi.fn(async () => ({ error: 'no repo mentioned' }));
    const result = await handleRefreshGithub('随便聊聊', svc, asLlm(callLlm), t, undefined);
    expect(result.type).toBe('clarify');
  });
});

describe('handleRefreshGithub — result mapping', () => {
  const cases: Array<[RefreshResult, 'action' | 'clarify']> = [
    [{ status: 'started', sourceId: 1, taskId: 2 }, 'action'],
    [{ status: 'in_progress', sourceId: 1, taskId: 2, startedAt: Date.now() }, 'action'],
    [{ status: 'too_recent', retryAfterSeconds: 30, lastRefreshedAt: Date.now() }, 'action'],
    [{ status: 'rate_limited', resetsAt: Date.now() }, 'action'],
    [{ status: 'not_found' }, 'action'],
    [{ status: 'archived', archivedAt: Date.now() }, 'action'],
  ];
  for (const [r, expected] of cases) {
    it(`maps ${r.status} to ${expected}`, async () => {
      const svc = mockService(r);
      const out = await handleRefreshGithub('刷新 o/r', svc, vi.fn(), t, undefined);
      expect(out.type).toBe(expected);
    });
  }
});

describe('handleRefreshGithub — localization', () => {
  it('renders the zh started message via the translator', async () => {
    const zh = createTranslator('zh');
    const svc = mockService({ status: 'started', sourceId: 1, taskId: 2 });
    const result = await handleRefreshGithub('刷新 facebook/react', svc, vi.fn(), zh, undefined);
    expect(result.type).toBe('action');
    if (result.type === 'action') {
      expect(result.message).toContain('已开始重新分析');
      expect(result.message).toContain('facebook/react');
    }
  });

  it('interpolates owner/repo into the en started message', async () => {
    const svc = mockService({ status: 'started', sourceId: 1, taskId: 2 });
    const result = await handleRefreshGithub('refresh facebook/react', svc, vi.fn(), t, undefined);
    if (result.type === 'action') {
      expect(result.message).toContain('Refreshing facebook/react');
      // no leftover ${} placeholders
      expect(result.message).not.toContain('${');
    }
  });

  it('localizes the clarify question (zh)', async () => {
    const zh = createTranslator('zh');
    const svc = mockService({ status: 'not_found' });
    const callLlm = vi.fn(async () => ({ error: 'no repo' }));
    const result = await handleRefreshGithub('随便聊聊', svc, asLlm(callLlm), zh, undefined);
    expect(result.type).toBe('clarify');
    if (result.type === 'clarify') expect(result.question).toContain('GitHub 仓库');
  });

  it('renders rate_limited resetsAt deterministically (ISO-8601 UTC, not server locale)', async () => {
    const RESETS_AT = 1_780_000_000_000;
    const svc = mockService({ status: 'rate_limited', resetsAt: RESETS_AT });
    const result = await handleRefreshGithub('刷新 facebook/react', svc, vi.fn(), t, undefined);
    expect(result.type).toBe('action');
    if (result.type === 'action') {
      // Exact ISO string proves the output is locale/timezone-independent —
      // a bare toLocaleString() would vary with the server's environment.
      expect(result.message).toContain(new Date(RESETS_AT).toISOString());
      expect(result.message).not.toContain('${');
    }
  });
});
