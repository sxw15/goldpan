'use client';

import type { LlmProviderBuiltin } from '@goldpan/web-sdk';
import { GoldpanApiError } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Btn } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Tag } from '@/components/ui/tag';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { useEnvMappingVisible } from '../../env-mapping-visibility';
import { LLM_STEPS } from '../../llm-steps';
import type { GroupProps } from '../../settings-shell';
import { AddBuiltinProviderModal } from './add-builtin-provider-modal';
import type { BuiltinProviderMeta } from './builtin-providers';
import { ProviderModelsField } from './provider-models-field';

interface Props {
  group: GroupProps;
  meta: BuiltinProviderMeta;
  builtin: LlmProviderBuiltin;
  /** Triggered after edit / delete commit so parent can refresh providers. */
  onChanged: () => void;
}

/**
 * Card-style row for a configured builtin LLM provider. Head row shows
 * provider name + hot-reload caption + 编辑/删除 actions; body shows the chip
 * editor for the provider's model list (same `ProviderModelsField` reused
 * across builtin / custom).
 *
 * Replaces the inline `SecretRow` + `OllamaRow` layout in `llm.tsx`. Adding
 * a builtin now goes through `AddBuiltinProviderModal` (launched from the
 * 「添加 Provider」 card), while edit / delete are inline buttons here.
 */
export function BuiltinProviderRow({ group, meta, builtin, onChanged }: Props) {
  const t = useTranslations('settings.llm');
  const tShell = useTranslations('settings.a11y');
  const envMappingVisible = useEnvMappingVisible();
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isOllama = meta.id === 'ollama';

  // Same algorithm as CustomProviderRow.findReferencingSteps — prevents users
  // from silently breaking pipeline steps that point at this provider.
  const refs = deleteOpen ? findReferencingSteps(group, meta.id) : [];
  const isReferenced = refs.length > 0;

  // The env var that gates "this provider is configured" on the server
  // (`buildLlmProvidersSnapshot.apiKeyConfigured`). For ollama there's no API
  // key — `apiKeyConfigured` is `config.ollamaEnabled`, which derives from
  // `GOLDPAN_OLLAMA_ENABLED`. For everything else it's `meta.apiKeyEnv`.
  // Used to decide whether a delete will actually make the row disappear.
  const gatingEnvKey = isOllama ? 'GOLDPAN_OLLAMA_ENABLED' : meta.apiKeyEnv;

  // True when the gating value comes purely from the boot baseline (.env file
  // / docker / k8s injection captured at process start) with no UI-set runtime
  // override. In this state, deleting from the UI clears nothing visible —
  // `mergeEnv(bootEnv, overrides)` rebuilds `process.env` with the baseline
  // value, so `apiKeyConfigured` stays true and the row reappears immediately
  // after `loadProviders()` re-fetches. We can't safely edit the user's .env
  // from here, so the only honest path is to tell them and offer to clear the
  // models override (which IS UI-managed) instead of pretending the delete
  // worked.
  const apiKeyState = group.env.get(gatingEnvKey);
  const isFromBaseline = apiKeyState?.configured === true && apiKeyState?.source === 'env';

  // For ollama edit, prefill base URL + enabled state from current env so the
  // modal can show what the user previously chose. Read effective value (dirty
  // patch ⊕ env mask) — same precedence as OllamaRow used to.
  const ollamaBaseUrl = isOllama
    ? (group.dirty.OLLAMA_BASE_URL ?? group.env.get('OLLAMA_BASE_URL')?.mask ?? '')
    : '';
  const ollamaEnabled = isOllama
    ? (group.dirty.GOLDPAN_OLLAMA_ENABLED ?? group.env.get('GOLDPAN_OLLAMA_ENABLED')?.mask) ===
      'true'
    : false;

  async function performDelete() {
    setDeleting(true);
    try {
      // Delete semantics: clear the user's UI-set runtime override. If the
      // user also has the same key in their `.env` file (baseline), it
      // resurfaces — that's correct behavior since we can't safely edit
      // their .env from here. Toast wording reflects this.
      const patch: Record<string, null> = {};
      if (isOllama) {
        // Disable + reset baseUrl override. Models override is also cleared
        // so the next pipeline step doesn't surface a model id no longer
        // managed.
        patch.GOLDPAN_OLLAMA_ENABLED = null;
        patch.OLLAMA_BASE_URL = null;
      } else {
        patch[meta.apiKeyEnv] = null;
      }
      // Always also clear the per-provider models lists. Without this, the
      // chat and embedding model overrides would linger and pollute the
      // Pipeline / Embedding dropdowns after the provider is "deleted".
      // Both keys must be cleared — server scans BOTH `_MODELS` (chat) AND
      // `_EMBEDDING_MODELS` (embedding) when building provider snapshots
      // (llm-providers.ts), so re-adding a provider with the same id would
      // otherwise resurrect the embedding override silently.
      const upperId = meta.id.toUpperCase().replace(/-/g, '_');
      patch[`GOLDPAN_LLM_PROVIDER_${upperId}_MODELS`] = null;
      patch[`GOLDPAN_LLM_PROVIDER_${upperId}_EMBEDDING_MODELS`] = null;

      const result = await getBrowserApiClient().commitEnv(patch);
      if (result.kind === 'ok') {
        group.applyEnvItems(result.updatedItems);
        // Post-flight baseline-shadow check (authoritative — uses the freshly
        // built EnvKeyState the server returns, not stale `group.env`). If the
        // gating key is still configured from `source: 'env'` after our null
        // patch, the boot baseline is shadowing the cleared override and the
        // provider row will pop right back. Tell the user instead of leaving
        // them with a misleading "deleted" toast.
        const stillFromEnv = result.updatedItems.some(
          (i) => i.key === gatingEnvKey && i.configured && i.source === 'env',
        );
        if (stillFromEnv) {
          group.toast({
            msg: t('delete_save_shadowed_toast', { id: meta.label, key: gatingEnvKey }),
            kind: 'danger',
          });
        } else {
          group.toast({ msg: t('delete_save_ok_toast', { id: meta.label }), kind: 'success' });
        }
        setDeleteOpen(false);
        onChanged();
        return;
      }
      group.toast({
        msg: t('delete_save_error_toast', { message: result.errors[0]?.message ?? '' }),
        kind: 'danger',
      });
    } catch (err) {
      const msg =
        err instanceof GoldpanApiError ? err.message : err instanceof Error ? err.message : '';
      group.toast({ msg: t('delete_save_error_toast', { message: msg }), kind: 'danger' });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="gp-llm-provider-block">
      <div className="gp-llm-provider-block__head">
        <span className="gp-llm-provider-block__name">{meta.label}</span>
        <Tag kind="live">{t('builtin_tag_label')}</Tag>
        {/* Ollama 显示的是 baseUrl（用户友好 URL，与 .env 概念无关）—— 总是渲染。
         * 其它 builtin 显示的 meta 是 apiKeyEnv 名（如 OPENAI_API_KEY），属于 .env
         * 映射，跟随全局开关。 */}
        {isOllama ? (
          <span className="gp-llm-provider-block__meta">
            {ollamaBaseUrl || t('ollama_baseurl_placeholder')}
          </span>
        ) : envMappingVisible ? (
          <span className="gp-llm-provider-block__meta">{meta.apiKeyEnv}</span>
        ) : null}
        <div className="gp-llm-provider-block__actions">
          <Btn sm kind="ghost" onClick={() => setEditing(true)}>
            {t('edit_btn')}
          </Btn>
          <Btn sm kind="ghost" onClick={() => setDeleteOpen(true)}>
            {t('delete_btn')}
          </Btn>
        </div>
      </div>
      <div className="gp-llm-provider-block__body">
        <ProviderModelsField group={group} providerId={meta.id} />
      </div>
      {editing ? (
        <AddBuiltinProviderModal
          group={group}
          meta={meta}
          onClose={() => setEditing(false)}
          onSaved={onChanged}
          initial={{
            models: builtin.models,
            embeddingModels: builtin.embeddingModels,
            ...(isOllama ? { ollamaBaseUrl, ollamaEnabled } : {}),
          }}
        />
      ) : null}
      {deleteOpen ? (
        <Modal
          heading={t('delete_modal_heading', { id: meta.label })}
          desc={
            isReferenced
              ? t('delete_modal_desc_referenced', {
                  id: meta.label,
                  steps: refs.map((r) => r.stepId).join(', '),
                })
              : isFromBaseline
                ? t('delete_builtin_modal_desc_from_baseline', {
                    id: meta.label,
                    key: gatingEnvKey,
                  })
                : t('delete_builtin_modal_desc', { id: meta.label })
          }
          closeLabel={tShell('modal_close')}
          confirmLabel={
            deleting
              ? t('add_btn_saving')
              : isReferenced
                ? t('delete_btn_cancel_force')
                : isFromBaseline
                  ? t('delete_btn_confirm_baseline_aware')
                  : t('delete_btn_confirm')
          }
          cancelLabel={t('add_btn_cancel')}
          onClose={() => {
            if (!deleting) setDeleteOpen(false);
          }}
          onConfirm={performDelete}
        />
      ) : null}
    </div>
  );
}

function findReferencingSteps(
  group: GroupProps,
  providerId: string,
): { stepId: string; envKey: string }[] {
  const out: { stepId: string; envKey: string }[] = [];
  for (const step of LLM_STEPS) {
    const dirtyVal = group.dirty[step.envKey];
    const envMask = group.env.get(step.envKey)?.mask;
    const raw = dirtyVal ?? (envMask || step.defaultProviderModel);
    const idx = raw.indexOf(':');
    if (idx < 0) continue;
    if (raw.slice(0, idx) === providerId) {
      out.push({ stepId: step.id, envKey: step.envKey });
    }
  }
  return out;
}
