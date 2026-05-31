'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Btn } from '@/components/ui/button';
import { rethrowNextErrors } from '@/lib/rethrow';
import type { GroupProps } from '../../settings-shell';
import { type Model, ModelRowsInput } from './model-rows-input';

interface Props {
  group: GroupProps;
  /** lowercase provider id — anthropic / openai / google / deepseek / openrouter / ollama / 自定义 */
  providerId: string;
}

function parseModelsCsv(csv: string): string[] {
  if (csv.length === 0) return [];
  return csv
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

/**
 * 「可用模型」 field rendered inside each provider block (builtin + custom).
 * 每行一个 model id + embedding 角色 toggle —— chat 和 embedding 在真实模型层
 * 面集合互斥，单 list + 每行 toggle 比"两栏分别填"更紧凑、更准确（一份 model
 * 集合 + 每个 model 有 role）。Pipeline 下拉只看 `embedding=false` 的，Embedding
 * 设置 / onboarding embedding 步骤只看 `embedding=true` 的。
 *
 * 持久化：分两个 env key 写——`_MODELS` (chat) 和 `_EMBEDDING_MODELS`。每次任
 * 一行 toggle / 编辑都重写两个 key。
 */
export function ProviderModelsField({ group, providerId }: Props) {
  const t = useTranslations('settings.llm');
  const tActions = useTranslations('settings.actions');
  const [resetting, setResetting] = useState<'chat' | 'embedding' | null>(null);

  const upperId = providerId.toUpperCase().replace(/-/g, '_');
  const chatEnvKey = `GOLDPAN_LLM_PROVIDER_${upperId}_MODELS`;
  const embedEnvKey = `GOLDPAN_LLM_PROVIDER_${upperId}_EMBEDDING_MODELS`;
  const chatState = group.env.get(chatEnvKey);
  const embedState = group.env.get(embedEnvKey);
  // Auto-commit drops the dirty-store interim layer — every model edit lands
  // on the server immediately via group.commit (see commit() below), so we
  // read straight from env state. Reset buttons remain inline below.
  const chatCsv = chatState?.mask ?? '';
  const embedCsv = embedState?.mask ?? '';
  const rows = useMemo<Model[]>(
    () => [
      ...parseModelsCsv(chatCsv).map((id) => ({ id, embedding: false })),
      ...parseModelsCsv(embedCsv).map((id) => ({ id, embedding: true })),
    ],
    [chatCsv, embedCsv],
  );

  const chatOverride = chatState?.source === 'override';
  const embedOverride = embedState?.source === 'override';

  // Optimistic rows for the auto-commit roundtrip. Without this the user
  // adds a model → commit fires async → env state lags 100-300ms → rows
  // (derived from env mask via useMemo) stay frozen on the OLD list,
  // so the just-added row VANISHES until the server replies. The
  // optimistic state holds the user's intent until env catches up, then
  // releases via the useEffect below.
  //
  // We mirror it on the *unprocessed* CSV strings (not the rows array)
  // so the "did env catch up?" check is a stable string comparison
  // immune to row-array identity churn from re-renders.
  const [optimistic, setOptimistic] = useState<{
    rows: Model[];
    chatCsv: string;
    embedCsv: string;
  } | null>(null);
  // Monotonic attempt counter. Each commit() captures a fresh id; resolves
  // / rejects that match the latest id are allowed to mutate optimistic
  // state. Older resolves (stale because the user typed again before
  // server replied) are dropped on the floor — without this, a first
  // commit's failure would `setOptimistic(null)` and erase the second
  // (still in-flight, latest user intent) optimistic snapshot.
  const attemptIdRef = useRef<number>(0);
  useEffect(() => {
    // Release optimistic state as soon as env has caught up to the
    // values we last committed. This must run BEFORE we render the next
    // user edit so we don't snap back to env-rows the user already
    // mutated again — we compare against the optimistic snapshot, not
    // a possibly newer in-flight intent.
    if (optimistic !== null && chatCsv === optimistic.chatCsv && embedCsv === optimistic.embedCsv) {
      setOptimistic(null);
    }
  }, [chatCsv, embedCsv, optimistic]);
  const displayRows = optimistic !== null ? optimistic.rows : rows;
  const modelCommitInFlight =
    resetting !== null || group.inFlightKeys.has(chatEnvKey) || group.inFlightKeys.has(embedEnvKey);

  function commit(next: Model[]): void {
    const chatIds = next.filter((m) => !m.embedding).map((m) => m.id);
    const embedIds = next.filter((m) => m.embedding).map((m) => m.id);
    const nextChatCsv = chatIds.join(',');
    const nextEmbedCsv = embedIds.join(',');
    // Optimistic snapshot before firing — gives the user immediate
    // feedback (new row appears in the list, removed row disappears)
    // and survives the server roundtrip latency.
    setOptimistic({ rows: next, chatCsv: nextChatCsv, embedCsv: nextEmbedCsv });
    const myAttempt = ++attemptIdRef.current;
    // Auto-commit: bundle both keys into a single commitEnv call so the
    // server applies them atomically (avoids the "chat dropped before
    // embedding committed" window). The hook helpers are single-key-only;
    // bypassing them is correct here — the model list has no per-key
    // inline status indicator (the reset buttons next to the heading carry
    // any user-facing state) and the commit error path falls through to
    // the shell-level toast.
    //
    // Stale-resolve guard: `myAttempt !== attemptIdRef.current` means a
    // newer commit overwrote us before the server replied; drop the resolve
    // on the floor so its (possibly older) outcome can't stomp the
    // optimistic snapshot the user has since updated. Without this guard
    // an older failure would `setOptimistic(null)` and the user's latest
    // edit would visually disappear until env eventually catches up.
    //
    // Failure release: on `kind: 'errors'` or thrown errors, env never
    // changes → the useEffect-on-CSV release path never fires → the user
    // keeps seeing a row that doesn't exist server-side. Explicitly clear
    // optimistic here so UI snaps back to actual env state; shell-level
    // toast carries the failure detail. NEXT_REDIRECT (401 session expiry)
    // is rethrown via rethrowNextErrors so Next's framework can navigate
    // — bare `(err) => {}` here previously swallowed it and stranded the
    // user on settings without ever seeing /login.
    // NOTE on the promise shape: use `.then(...).catch(rethrowNextErrors)`
    // rather than the two-argument `.then(success, failure)` form. The
    // latter would catch NEXT_REDIRECT inside the failure handler and
    // then need to `throw err` again to propagate — but that re-throw
    // becomes an unhandled rejection on the chain's own promise (no
    // downstream .catch), and Next 16's redirect mechanism in client
    // components isn't guaranteed to pick it up. Chaining .catch
    // AFTER .then puts both branches in one rejection lane so
    // rethrowNextErrors can re-throw freely; the resulting rejected
    // promise IS the framework signal Next expects.
    group
      .commit({ [chatEnvKey]: nextChatCsv, [embedEnvKey]: nextEmbedCsv })
      .then((result) => {
        if (myAttempt !== attemptIdRef.current) return;
        if (result.kind !== 'ok') {
          setOptimistic(null);
        }
        // Success: leave the useEffect-on-CSV release path to do its job.
        // env is still in transit (server returned 'ok' but the host's
        // setStore hasn't flushed yet); a race-free release waits for
        // the CSV deps to actually shift.
      })
      .catch((err) => {
        rethrowNextErrors(err);
        if (myAttempt !== attemptIdRef.current) return;
        setOptimistic(null);
      });
  }

  const hint = providerHint(providerId, t);

  return (
    <div className="gp-llm-models">
      {/* Block both Reset buttons while EITHER key has an in-flight
          commit. The reset bypasses this component's commit pipeline
          (calls group.resetEnvKey directly), so a slow-returning
          add/remove commit could write back AFTER the reset has
          already landed → last-write-wins → user clicks Reset, sees
          nothing happen, sometimes their pre-reset edit comes back.
          The lock also clears optimistic and bumps the attempt counter
          so any in-flight commit's resolve is recognised as stale and
          ignored. */}
      <div className="gp-llm-models__head">
        <span className="gp-llm-models__label">{t('models_field_label')}</span>
        {chatOverride ? (
          <span title={tActions('reset_hint')}>
            <Btn
              sm
              kind="ghost"
              disabled={
                resetting !== null ||
                group.inFlightKeys.has(chatEnvKey) ||
                group.inFlightKeys.has(embedEnvKey)
              }
              onClick={async () => {
                attemptIdRef.current += 1; // invalidate in-flight resolves
                setOptimistic(null);
                setResetting('chat');
                try {
                  await group.resetEnvKey(chatEnvKey);
                } finally {
                  setResetting(null);
                }
              }}
            >
              {resetting === 'chat' ? tActions('reset_in_progress') : t('models_reset_chat_label')}
            </Btn>
          </span>
        ) : null}
        {embedOverride ? (
          <span title={tActions('reset_hint')}>
            <Btn
              sm
              kind="ghost"
              disabled={
                resetting !== null ||
                group.inFlightKeys.has(chatEnvKey) ||
                group.inFlightKeys.has(embedEnvKey)
              }
              onClick={async () => {
                attemptIdRef.current += 1;
                setOptimistic(null);
                setResetting('embedding');
                try {
                  await group.resetEnvKey(embedEnvKey);
                } finally {
                  setResetting(null);
                }
              }}
            >
              {resetting === 'embedding'
                ? tActions('reset_in_progress')
                : t('models_reset_embedding_label')}
            </Btn>
          </span>
        ) : null}
      </div>
      {hint ? <p className="gp-llm-models__hint">{hint}</p> : null}
      <ModelRowsInput
        value={displayRows}
        onChange={commit}
        disabled={modelCommitInFlight}
        // Wire the trailing-add-input's draft state into the shell's leave-
        // guard. Use chatEnvKey as the representative key — drafted rows
        // default to embedding=false (chat); the leave-guard only checks
        // Set membership, so a single key is sufficient signal that "this
        // provider has uncommitted model edits". Without this, a typed-
        // but-not-yet-committed model row was silently lost on group nav.
        onEditingChange={(editing) => group.setFieldEditing(chatEnvKey, editing)}
        placeholder={t('models_field_add_placeholder')}
        inputAriaLabel={t('provider_models_aria', { provider: providerId })}
        embeddingLabel={t('model_row_embedding_label')}
        embeddingAriaLabel={(id) => t('model_row_embedding_aria', { model: id || '?' })}
        removeAriaLabel={(id) => t('model_row_remove_aria', { model: id || '?' })}
      />
    </div>
  );
}

/**
 * 拿 provider 对应的 chat / embedding hint 文案。builtin 走特定 key，custom
 * （以及未知 id）走通用 fallback。文案里告诉用户该 provider 常见的 chat /
 * embedding model 名字 —— 是引导文案不是默认值，用户照着输才生效。
 */
function providerHint(providerId: string, t: ReturnType<typeof useTranslations>): string {
  const knownKey = `provider_hint_${providerId}`;
  const knownIds = ['openai', 'anthropic', 'google', 'deepseek', 'openrouter', 'ollama'];
  if (knownIds.includes(providerId)) {
    // next-intl raw key lookup —— 已在 i18n 维护这些键，未维护时落到默认 key
    // (不让 missing-key 抛错把整个卡片打挂)。
    try {
      return t(knownKey);
    } catch {
      return t('provider_hint_custom');
    }
  }
  return t('provider_hint_custom');
}
