'use client';

import { GoldpanApiError } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Btn } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Tag } from '@/components/ui/tag';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { LLM_STEPS } from '../../llm-steps';
import type { GroupProps } from '../../settings-shell';
import { AddOpenAICompatModal } from './add-openai-compat-modal';
import { ProviderModelsField } from './provider-models-field';

interface CustomProviderInfo {
  id: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKeyConfigured: boolean;
  models: string[];
  embeddingModels: string[];
}

interface Props {
  group: GroupProps;
  provider: CustomProviderInfo;
  /** Triggered after edit / delete commits so parent can refresh `getLlmProviders()`. */
  onChanged: () => void;
}

/**
 * 扫 LLM_STEPS 看哪些 step 当前用了这个 provider。看的是 effective value
 * (dirty patch ⊕ env mask ⊕ schema default)，与 PipelineStepRow 的解析逻辑一致：
 * 删除前先告诉用户「砍掉这个 provider 会让谁挂掉」，让他选择先去 Pipeline matrix 改用别的 provider 再回来删。
 */
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

export function CustomProviderRow({ group, provider, onChanged }: Props) {
  const t = useTranslations('settings.llm');
  const tShell = useTranslations('settings.a11y');
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const refs = deleteOpen ? findReferencingSteps(group, provider.id) : [];
  const isReferenced = refs.length > 0;

  async function performDelete() {
    setDeleting(true);
    try {
      const upperId = provider.id.toUpperCase().replace(/-/g, '_');
      // 四个 key 全部 null = 删除 runtime override，恢复 .env / default。
      // 用户写在 .env 文件里的同名 key 会重新生效（一致行为：reset 单 key 也是这样）。
      // apiKey 本身的 secret env (e.g. TOGETHER_API_KEY) 不删 —— 那可能被用户其它脚本依赖。
      // `_EMBEDDING_MODELS` 必须连带清掉,否则 server 端 llm-providers 仍会读取
      // 这个 key 的 override → 删 provider 后又重新添加同名 provider 时旧 embedding
      // models 会"复活",造成幽灵配置。
      const patch: Record<string, null> = {
        [`GOLDPAN_LLM_PROVIDER_${upperId}_BASE_URL`]: null,
        [`GOLDPAN_LLM_PROVIDER_${upperId}_API_KEY_ENV`]: null,
        [`GOLDPAN_LLM_PROVIDER_${upperId}_MODELS`]: null,
        [`GOLDPAN_LLM_PROVIDER_${upperId}_EMBEDDING_MODELS`]: null,
      };
      const result = await getBrowserApiClient().commitEnv(patch);
      if (result.kind === 'ok') {
        group.applyEnvItems(result.updatedItems);
        const shadowed = result.updatedItems.find(
          (i) =>
            (i.key === `GOLDPAN_LLM_PROVIDER_${upperId}_BASE_URL` ||
              i.key === `GOLDPAN_LLM_PROVIDER_${upperId}_API_KEY_ENV`) &&
            i.configured &&
            i.source === 'env',
        );
        group.toast(
          shadowed
            ? {
                msg: t('delete_save_shadowed_toast', {
                  id: provider.id,
                  key: shadowed?.key ?? provider.id,
                }),
                kind: 'danger',
              }
            : {
                msg: t('delete_save_ok_toast', { id: provider.id }),
                kind: 'success',
              },
        );
        setDeleteOpen(false);
        onChanged();
        return;
      }
      group.toast({
        msg: t('delete_save_error_toast', {
          message: result.errors[0]?.message ?? '',
        }),
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
    <>
      <div className="gp-llm-provider-block">
        <div className="gp-llm-provider-block__head">
          <span className="gp-llm-provider-block__name">{provider.id}</span>
          <Tag kind="default">{t('source_custom')}</Tag>
          <span className="gp-llm-provider-block__meta">{provider.baseUrl}</span>
          {provider.apiKeyConfigured ? (
            <Tag kind="live">{t('status_key_set')}</Tag>
          ) : (
            <Tag kind="restart">{t('status_key_missing')}</Tag>
          )}
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
          <ProviderModelsField group={group} providerId={provider.id} />
        </div>
      </div>
      {editing ? (
        <AddOpenAICompatModal
          group={group}
          onClose={() => setEditing(false)}
          onSaved={onChanged}
          initial={{
            id: provider.id,
            baseUrl: provider.baseUrl,
            apiKeyEnv: provider.apiKeyEnv,
            models: provider.models,
            embeddingModels: provider.embeddingModels,
          }}
        />
      ) : null}
      {deleteOpen ? (
        <Modal
          heading={t('delete_modal_heading', { id: provider.id })}
          desc={
            isReferenced
              ? t('delete_modal_desc_referenced', {
                  id: provider.id,
                  steps: refs.map((r) => r.stepId).join(', '),
                })
              : t('delete_modal_desc_unused', {
                  id: provider.id,
                  apiKeyEnv: provider.apiKeyEnv,
                })
          }
          closeLabel={tShell('modal_close')}
          confirmLabel={
            deleting
              ? t('add_btn_saving')
              : isReferenced
                ? t('delete_btn_cancel_force')
                : t('delete_btn_confirm')
          }
          cancelLabel={t('add_btn_cancel')}
          onClose={() => {
            if (!deleting) setDeleteOpen(false);
          }}
          onConfirm={performDelete}
        />
      ) : null}
    </>
  );
}
