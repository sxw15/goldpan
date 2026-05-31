'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

/**
 * Library empty-state suggestion grid. Renders three static cards that
 * teach new users what to paste / write in the unified chat input. Each
 * card navigates to `/?q=<prefill>` so ChatView mounts with the textarea
 * pre-populated and focused — see `chat-view.tsx` `prefillQuery` handling.
 *
 * Static + i18n-driven by design: no remote sources, no seed data
 * pollution. Maintenance cost = a handful of translation keys.
 */
const SUGGESTIONS = ['url', 'note', 'query'] as const;

type SuggestionKind = (typeof SUGGESTIONS)[number];

export function LibraryEmptySuggestions() {
  const t = useTranslations('library');
  const router = useRouter();

  return (
    <div className="gp-empty-suggestions">
      <p className="gp-empty-suggestions__lede">{t('empty_suggest_lede')}</p>
      <div className="gp-empty-suggestions__grid">
        {SUGGESTIONS.map((kind) => (
          <SuggestionCard key={kind} kind={kind} t={t} router={router} />
        ))}
      </div>
    </div>
  );
}

function SuggestionCard({
  kind,
  t,
  router,
}: {
  kind: SuggestionKind;
  t: ReturnType<typeof useTranslations>;
  router: ReturnType<typeof useRouter>;
}) {
  const titleKey = `empty_suggest_card_${kind}_title` as const;
  const hintKey = `empty_suggest_card_${kind}_hint` as const;
  const prefillKey = `empty_suggest_card_${kind}_prefill` as const;

  const onClick = () => {
    const prefill = t(prefillKey);
    // Empty prefill still navigates (clears the textarea + focuses it) so
    // the "ask a question" card behaves like a CTA into the chat page.
    const qs = prefill ? `?q=${encodeURIComponent(prefill)}` : '';
    router.push(`/${qs}`);
  };

  return (
    <button type="button" className="gp-empty-suggestion-card" onClick={onClick}>
      <span className="gp-empty-suggestion-card__title">{t(titleKey)}</span>
      <span className="gp-empty-suggestion-card__hint">{t(hintKey)}</span>
    </button>
  );
}
