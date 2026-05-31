'use client';

import { DUAL_PROCESS_RESTART_KEYS } from '@goldpan/web-sdk';
import { useMessages, useTranslations } from 'next-intl';
import { Btn } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';

const DUAL_PROCESS_SET = new Set<string>(DUAL_PROCESS_RESTART_KEYS);

/**
 * Pull the friendly label for an env key out of `settings.restart_prompt.key_labels`,
 * falling back to the env key itself when no localized label is registered.
 * Reads via `useMessages()` (raw dict lookup) instead of `t()` because:
 *
 *   - new restart-required keys land here automatically the moment the user
 *     hits save (server already knows the env key, the modal shouldn't have
 *     to enumerate them client-side); a `t(env_key)` call on a key the i18n
 *     dict hasn't caught up to would emit a missing-message warning, and the
 *     "fallback to env key" path is the *expected* behaviour here, not an
 *     error worth flagging.
 *   - `useTranslations(namespace)` only resolves keys inside that namespace,
 *     so this approach would either require duplicating the key list as a TS
 *     allowlist (extra source of drift) or accepting the missing-key warning.
 *     Dict lookup sidesteps both.
 */
function pickKeyLabels(messages: unknown): Record<string, string> {
  const settings = (messages as { settings?: unknown })?.settings;
  const block = (settings as { restart_prompt?: unknown })?.restart_prompt;
  const labels = (block as { key_labels?: unknown })?.key_labels;
  if (labels && typeof labels === 'object') {
    return labels as Record<string, string>;
  }
  return {};
}

export interface RestartPromptProps {
  /** Keys that require a process restart to take effect — drives both the list
   * rendered in the body and the dual-process warning gate. Caller passes the
   * `pendingRestartKeys` from the most recent `commitEnv` response; rendering
   * of this component is conditional on the array being non-empty (caller
   * sets `null` to hide). */
  keys: string[];
  /** Trigger `client.serverRestart()`. Caller is responsible for the post-call
   * UX (transient toast / page reload). */
  onConfirm: () => void;
  /** Dismiss the prompt without restarting — caller hides the modal. The
   * pendingRestartKeys remain queued on the server and will resurface in the
   * next /health response, so deferring is safe. */
  onCancel: () => void;
  /** Disables the confirm button + swaps its label to a "Restarting…" state.
   * Caller toggles this around the in-flight `serverRestart()` call. */
  inProgress?: boolean;
}

/**
 * Pending-restart confirmation modal shown after a successful `commitEnv` when
 * the server reports keys that cannot take effect at runtime. The list shows
 * each key verbatim — env-key strings are stable contracts, and the field
 * already renders the user-facing label up in the settings card the user just
 * came from, so the modal's job is to identify *which* of those fields needs
 * the restart, not relabel them.
 *
 * Dual-process warning surfaces when any key is in `DUAL_PROCESS_RESTART_KEYS`.
 * Those are read by `apps/web`'s own Node process at boot and cached for the
 * lifetime of the process; settings now write to the DB override layer (not
 * `.env`), so the user does NOT need to sync values back to `.env`. They only
 * need to make sure the web process restarts — dev mode does this automatically
 * via the supervisor cascade; split-container deploys may require restarting
 * the web container manually.
 *
 * Footer uses the Modal primitive's built-in confirm/cancel slot for visual
 * parity with other settings modals (proper border-top, raised footer
 * background). Mid-flight `inProgress` is wired through `confirmDisabled` /
 * `cancelDisabled` instead of hand-rolling the footer.
 */
export function RestartPrompt({ keys, onConfirm, onCancel, inProgress }: RestartPromptProps) {
  const t = useTranslations('settings.restart_prompt');
  const tA11y = useTranslations('settings.a11y');
  const keyLabels = pickKeyLabels(useMessages());
  const dualProcess = keys.some((k) => DUAL_PROCESS_SET.has(k));
  return (
    <Modal
      heading={t('title')}
      desc={t('body')}
      closeLabel={tA11y('modal_close')}
      onClose={onCancel}
      onConfirm={onConfirm}
      confirmLabel={inProgress ? t('in_progress') : t('confirm_restart')}
      cancelLabel={t('later')}
      confirmDisabled={inProgress}
      cancelDisabled={inProgress}
    >
      <ul className="gp-restart-prompt__keys">
        {keys.map((key) => {
          const label = keyLabels[key];
          return (
            <li key={key}>
              {label ? (
                <span className="gp-restart-prompt__keys-label">{label}</span>
              ) : (
                <code>{key}</code>
              )}
            </li>
          );
        })}
      </ul>
      {dualProcess ? (
        <p className="gp-restart-prompt__dual-warn">{t('dual_process_warn')}</p>
      ) : null}
    </Modal>
  );
}

/**
 * Sticky bottom banner shown after the user dismisses RestartPrompt with
 * "稍后" but still has unrestarted keys queued. Reuses the same i18n
 * namespace so the wording stays consistent with the modal (this is the
 * non-modal counterpart, not a separate concept). Sits at viewport bottom
 * like the save bar so it remains visible while the user keeps editing.
 */
export function RestartPendingBanner({ count, onOpen }: { count: number; onOpen: () => void }) {
  const t = useTranslations('settings.restart_prompt');
  return (
    <div className="gp-restart-pending-banner" role="status">
      <span className="gp-restart-pending-banner__msg">{t('pending_banner', { count })}</span>
      <Btn sm kind="primary" onClick={onOpen}>
        {t('confirm_restart')}
      </Btn>
    </div>
  );
}
