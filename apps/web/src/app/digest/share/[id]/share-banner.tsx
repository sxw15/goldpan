import { getTranslations } from 'next-intl/server';

export async function ShareBanner() {
  const t = await getTranslations('digest');
  return (
    <div className="gp-digest-share__banner" role="note">
      <span aria-hidden>ℹ️</span>
      <span>{t('share_banner')}</span>
    </div>
  );
}
