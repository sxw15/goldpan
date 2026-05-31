'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { type LoginState, loginAction } from '@/actions/auth';

export function LoginForm() {
  const [state, action, isPending] = useActionState<LoginState, FormData>(loginAction, {});
  const t = useTranslations('auth');

  return (
    <form action={action}>
      <div className="gp-login__field">
        <label htmlFor="password" className="gp-login__label">
          {t('password')}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          // biome-ignore lint/a11y/noAutofocus: login page should focus password input
          autoFocus
          disabled={isPending}
          className="gp-login__input"
        />
      </div>

      {state.error && (
        <div role="alert" className="gp-login__error">
          {state.error}
        </div>
      )}

      <button type="submit" disabled={isPending} className="gp-login__submit">
        {isPending ? t('login_pending') : t('login_button')}
      </button>
    </form>
  );
}
