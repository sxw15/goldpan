import { GoldpanApiError } from '@goldpan/web-sdk';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { DigestSections } from '@/components/digest/digest-sections';
import { StateEmpty } from '@/components/state/state-empty';
import { createPublicClient, rethrowNextErrors } from '@/lib/api';
import { ShareBanner } from './share-banner';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return {
    title: t('page_digest_share'),
    robots: { index: false, follow: false, nocache: true },
  };
}

export default async function DigestSharePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sig?: string }>;
}) {
  const { id } = await params;
  const { sig } = await searchParams;
  const idNum = Number(id);
  const t = await getTranslations('digest');

  if (!Number.isInteger(idNum) || idNum <= 0 || !sig) {
    return (
      <StateEmpty title={t('share_expired_title')} description={t('share_expired_description')} />
    );
  }

  // Public client (no session cookie, no onUnauthorized → /login redirect):
  // share URLs are intentionally accessible without auth (HMAC sig is the
  // sole gate). `createServerClient` would register a 401 → /login side
  // effect that destroys the public share URL the moment any upstream
  // (proxy auth enforcement, server-side bug) returns 401.
  const client = createPublicClient();
  let data: Awaited<ReturnType<typeof client.getDigestShare>>;
  try {
    data = await client.getDigestShare(idNum, sig);
  } catch (err) {
    rethrowNextErrors(err);
    if (
      err instanceof GoldpanApiError &&
      (err.status === 410 || err.status === 400 || err.status === 401 || err.status === 403)
    ) {
      // 401/403 也走 expired:share URL 不应触发 "session 过期 → /login" 心智 ——
      // 边缘代理 auth 强制 (401/403) 应当显示 "link 失效",不是登录提示。
      return (
        <StateEmpty title={t('share_expired_title')} description={t('share_expired_description')} />
      );
    }
    throw err;
  }

  return (
    <main className="gp-digest-share">
      <ShareBanner />
      <DigestSections snapshot={data.snapshot} preset={data.preset} pageContext="share" />
    </main>
  );
}
