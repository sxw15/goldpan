'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { refreshGithubByUrl } from '@/actions/refreshGithub';
import { useTz } from '@/components/tz-provider';

export interface GithubRepoCardProps {
  owner: string;
  repo: string;
  normalizedUrl: string;
  archived: boolean;
  lastRefreshed: number | null;
}

type Feedback = { kind: 'success' | 'error' | 'info' | 'warning'; message: string } | null;

export function GithubRepoCard({
  owner,
  repo,
  normalizedUrl,
  archived,
  lastRefreshed,
}: GithubRepoCardProps) {
  const t = useTranslations('github');
  const tz = useTz();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const display = `${owner}/${repo}`;

  const handleClick = () => {
    setFeedback(null);
    startTransition(async () => {
      const res = await refreshGithubByUrl(normalizedUrl);
      if (!res.ok) {
        const key =
          res.code === 'unauthorized' ? 'refresh.toast.unauthorized' : 'refresh.toast.error';
        setFeedback({ kind: 'error', message: t(key) });
        return;
      }
      switch (res.result.status) {
        case 'started':
          setFeedback({ kind: 'success', message: t('refresh.toast.started', { display }) });
          break;
        case 'in_progress':
          setFeedback({ kind: 'info', message: t('refresh.toast.inProgress', { display }) });
          break;
        case 'too_recent':
          setFeedback({
            kind: 'warning',
            message: t('refresh.toast.tooRecent', { seconds: res.result.retryAfterSeconds }),
          });
          break;
        case 'rate_limited':
          setFeedback({
            kind: 'warning',
            message: t('refresh.toast.rateLimited', { resetsAt: res.result.resetsAt }),
          });
          break;
        case 'not_found':
          setFeedback({ kind: 'error', message: t('refresh.toast.notFound', { display }) });
          break;
        case 'archived':
          setFeedback({ kind: 'info', message: t('refresh.toast.archived', { display }) });
          break;
      }
    });
  };

  return (
    <div className="gp-github-repo-card">
      <div className="gp-github-repo-card__header">
        <span className="gp-github-repo-card__chip">{t('project.chip')}</span>
        <span className="gp-github-repo-card__slug">{display}</span>
        {lastRefreshed && (
          <span className="gp-github-repo-card__last">
            {t('refresh.lastRefreshed', {
              when: new Date(lastRefreshed).toLocaleString(locale, { timeZone: tz }),
            })}
          </span>
        )}
      </div>
      <button
        type="button"
        disabled={archived || pending}
        onClick={handleClick}
        className="gp-github-repo-card__button"
      >
        {archived
          ? t('refresh.button.archived')
          : pending
            ? t('refresh.button.pending')
            : t('refresh.button.idle')}
      </button>
      {feedback && (
        <div
          className={`gp-github-repo-card__feedback gp-github-repo-card__feedback--${feedback.kind}`}
        >
          {feedback.message}
        </div>
      )}
    </div>
  );
}
