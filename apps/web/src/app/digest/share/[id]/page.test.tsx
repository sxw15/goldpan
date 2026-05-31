import { GoldpanApiError } from '@goldpan/web-sdk';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import enMessages from '../../../../../messages/en.json';

const mockGetDigestShare = vi.fn();

vi.mock('@/lib/api', () => ({
  // createPublicClient 是 sync 工厂,mock 同步返回 client。
  createPublicClient: vi.fn(() => ({ getDigestShare: mockGetDigestShare })),
  // 测试只关心 share 页业务路径 — 真实 rethrowNextErrors 走 unstable_rethrow，
  // 单元测试无需模拟 Next framework error，no-op 即可。
  rethrowNextErrors: vi.fn(),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) => (key: string) => `${ns}.${key}`),
}));

// ShareBanner is itself an async server component; ReactDOM in jsdom cannot
// render async function components. Stub it so the success-path render only
// has to handle sync client components (DigestSections).
vi.mock('./share-banner', () => ({
  ShareBanner: () => <div className="gp-digest-share__banner">share-banner-stub</div>,
}));

const sampleSnapshot = {
  digestId: { channel: 'web', date: '2026-04-25', presetId: null },
  period: 'daily' as const,
  generatedAt: 0,
  aiSummary: { status: 'complete' as const, text: 'Hello summary text' },
  modules: {
    tracking_findings: {
      type: 'tracking_findings' as const,
      items: [],
      hasMore: false,
      hiddenCount: 0,
    },
    captures: { type: 'captures' as const, items: [], hasMore: false, hiddenCount: 0 },
    thoughts: { type: 'thoughts' as const, items: [], hasMore: false, hiddenCount: 0 },
    new_entities: { type: 'new_entities' as const, items: [], hasMore: false, hiddenCount: 0 },
    stats: { type: 'stats' as const, captures: 0, findings: 0, thoughts: 0, entities: 0 },
  },
};

async function renderPage(params: { id: string }, searchParams: { sig?: string }) {
  const mod = await import('./page');
  const ui = await mod.default({
    params: Promise.resolve(params),
    searchParams: Promise.resolve(searchParams),
  });
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('DigestSharePage (server component smoke)', () => {
  beforeEach(() => {
    mockGetDigestShare.mockReset();
  });

  it('renders StateEmpty when id is non-integer', async () => {
    const { container } = await renderPage({ id: 'abc' }, { sig: 'p.s' });
    expect(container.textContent).toContain('digest.share_expired_title');
    expect(mockGetDigestShare).not.toHaveBeenCalled();
  });

  it('renders StateEmpty when id is non-positive', async () => {
    const { container } = await renderPage({ id: '0' }, { sig: 'p.s' });
    expect(container.textContent).toContain('digest.share_expired_title');
    expect(mockGetDigestShare).not.toHaveBeenCalled();
  });

  it('renders StateEmpty when sig is missing', async () => {
    const { container } = await renderPage({ id: '42' }, {});
    expect(container.textContent).toContain('digest.share_expired_title');
    expect(mockGetDigestShare).not.toHaveBeenCalled();
  });

  it('renders StateEmpty when API throws GoldpanApiError 410', async () => {
    mockGetDigestShare.mockRejectedValueOnce(new GoldpanApiError('expired', 'gone', 410));
    const { container } = await renderPage({ id: '42' }, { sig: 'p.s' });
    expect(container.textContent).toContain('digest.share_expired_title');
    expect(mockGetDigestShare).toHaveBeenCalledWith(42, 'p.s');
  });

  it('renders StateEmpty when API throws GoldpanApiError 400', async () => {
    mockGetDigestShare.mockRejectedValueOnce(new GoldpanApiError('bad', 'malformed', 400));
    const { container } = await renderPage({ id: '42' }, { sig: 'bad' });
    expect(container.textContent).toContain('digest.share_expired_title');
  });

  it('renders StateEmpty when API throws GoldpanApiError 401 (no /login redirect)', async () => {
    mockGetDigestShare.mockRejectedValueOnce(new GoldpanApiError('auth', 'unauthorized', 401));
    const { container } = await renderPage({ id: '42' }, { sig: 'p.s' });
    expect(container.textContent).toContain('digest.share_expired_title');
  });

  it('renders StateEmpty when API throws GoldpanApiError 403 (proxy forbidden)', async () => {
    mockGetDigestShare.mockRejectedValueOnce(new GoldpanApiError('forbidden', 'forbidden', 403));
    const { container } = await renderPage({ id: '42' }, { sig: 'p.s' });
    expect(container.textContent).toContain('digest.share_expired_title');
  });

  it('rethrows non-410/400/401/403 GoldpanApiError so Next.js error boundary catches it', async () => {
    mockGetDigestShare.mockRejectedValueOnce(new GoldpanApiError('boom', 'server_error', 500));
    await expect(renderPage({ id: '42' }, { sig: 'p.s' })).rejects.toThrow('boom');
  });

  it('renders ShareBanner + DigestSections on success (no preset → default render)', async () => {
    // preset:null → DigestSections 走默认 5-slot fallback,这是 channel-level
    // (presetId IS NULL) 的 snapshot 走的路径。
    mockGetDigestShare.mockResolvedValueOnce({ snapshot: sampleSnapshot, preset: null });
    const { container } = await renderPage({ id: '42' }, { sig: 'p.s' });
    expect(container.textContent).toContain('Hello summary text');
    expect(container.querySelector('.gp-digest-share__banner')).not.toBeNull();
    expect(container.querySelector('main.gp-digest-share')).not.toBeNull();
  });

  it('honors preset.skipEmpty + slot order on share render', async () => {
    // Preset 只声明 captures + new_entities 两个 slot,且 skipEmpty=true。
    // sampleSnapshot 的 captures.items 是空 → 即便在 slots 里也应被隐藏。
    mockGetDigestShare.mockResolvedValueOnce({
      snapshot: {
        ...sampleSnapshot,
        modules: {
          ...sampleSnapshot.modules,
          new_entities: {
            type: 'new_entities' as const,
            items: [{ id: 1, name: 'Visible Entity', description: null, createdAt: 0 }],
            hasMore: false,
            hiddenCount: 0,
          },
        },
      },
      preset: {
        slots: ['captures', 'new_entities'],
        skipEmpty: true,
        includeAiSummary: false,
        period: 'weekly' as const,
      },
    });
    const { container } = await renderPage({ id: '42' }, { sig: 'p.s' });
    // includeAiSummary=false → Hero 不渲染,所以 summary 文本不应出现
    expect(container.textContent).not.toContain('Hello summary text');
    // captures 空 + skipEmpty=true → captures section 整段不渲染
    expect(container.querySelector('.gp-digest-section--captures')).toBeNull();
    // new_entities 有内容 → 应渲染
    expect(container.textContent).toContain('Visible Entity');
  });
});
