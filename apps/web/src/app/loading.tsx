// NOTE: Like error.tsx / global-error.tsx / not-found.tsx, this loading
// boundary intentionally uses a hardcoded bilingual aria-label rather than
// useTranslations(). Promoting Loading to async + getTranslations adds a
// failure point during route transitions: if messages fail to load the user
// sees an error page instead of a spinner. Bilingual text serves both
// audiences without an i18n dependency.

export default function Loading() {
  return (
    <div className="gp-loading-page">
      <div className="gp-loading-page__spinner" role="status" aria-label="Loading / 加载中" />
    </div>
  );
}
