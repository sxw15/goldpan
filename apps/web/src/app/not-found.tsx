import Link from 'next/link';

// NOTE: Like error.tsx and global-error.tsx, this 404 page intentionally uses
// hardcoded bilingual strings rather than useTranslations(). Although the
// NextIntlClientProvider in layout.tsx does mount before this renders, keeping
// all three boundary fallback pages on the same pattern (a) reduces reader
// cognitive load when scanning error / boundary code and (b) eliminates the
// edge case where a future i18n provider misconfiguration breaks the 404 page.
// Bilingual text serves both audiences without an i18n dependency.

export default function NotFound() {
  return (
    <div className="gp-not-found">
      <h2 className="gp-not-found__title">404</h2>
      <p className="gp-not-found__message">Page not found / 页面未找到</p>
      <Link href="/" className="gp-not-found__link">
        Go home / 返回首页
      </Link>
    </div>
  );
}
