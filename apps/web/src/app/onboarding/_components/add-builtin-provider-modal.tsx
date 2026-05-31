// apps/web/src/app/onboarding/_components/add-builtin-provider-modal.tsx
//
// Single Modal for both adding and editing a builtin provider in the wizard.
// `mode='add'` shows an empty form; `mode='edit'` prefills from the provider's
// current wizard state. The split exists in i18n only (heading copy) — fields
// are identical so users see the same UI in both flows.
//
// Two field shapes by provider id:
//   - ollama → baseUrl (text). No apiKey. We don't surface the «enabled»
//     toggle the settings modal has — for the wizard, presence of a baseUrl
//     in `state.providers.ollama` already means the user wants it on; the
//     on/off toggle would just add a click for no benefit.
//   - everything else → apiKey (password).
//
// Plus a shared `models` chip editor (the «Available models» list). Users
// curate it themselves — no hardcoded prefill, since provider model lineups
// rot fast. StepCard falls into custom-input mode when the list is empty.
'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import {
  type Model,
  ModelRowsInput,
  type ModelRowsInputHandle,
} from '../../settings/groups/_components/model-rows-input';
import { type BuiltinId, builtinMeta } from './builtin-provider-defaults';
import { useWizard } from './wizard-state';

interface ProviderInitial {
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  embeddingModels?: string[];
}

interface Props {
  providerId: BuiltinId;
  /** Display label shown in the modal heading (e.g. "OpenAI", "Ollama (本地)"). */
  label: string;
  /** Optional placeholder for the apiKey input (e.g. "sk-..."). */
  apiKeyPlaceholder?: string;
  /** Optional placeholder for the models chip editor (e.g. "gpt-4o, gpt-4o-mini"). */
  modelsPlaceholder?: string;
  /** 'add' creates a fresh provider; 'edit' prefills from `existing`. */
  mode?: 'add' | 'edit';
  /** Caller context — see WizardProviderList. `embedding` adds a top Notice
   *  for providers without an embedding endpoint, and an extra hint listing
   *  known embedding-model ids for those that do. Default `pipeline` keeps
   *  the modal's chat-only copy. */
  context?: 'pipeline' | 'embedding';
  /** Required when `mode='edit'`. Current wizard-state value for this provider. */
  existing?: ProviderInitial;
  onClose: () => void;
}

export function AddBuiltinProviderModal({
  providerId,
  label,
  apiKeyPlaceholder,
  modelsPlaceholder,
  mode = 'add',
  context = 'pipeline',
  existing,
  onClose,
}: Props) {
  const isOllama = providerId === 'ollama';
  const isEdit = mode === 'edit';
  const isEmbeddingCtx = context === 'embedding';
  const meta = builtinMeta(providerId);
  const t = useTranslations('settings.llm');
  const tg = useTranslations('onboarding');
  const tp = useTranslations('onboarding.providers');
  const { patch } = useWizard();

  const [apiKey, setApiKey] = useState(existing?.apiKey ?? '');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(existing?.baseUrl ?? '');
  const [models, setModels] = useState<Model[]>(() => {
    const initChat = (existing?.models ?? []).map((mid) => ({ id: mid, embedding: false }));
    const initEmbed = (existing?.embeddingModels ?? []).map((mid) => ({
      id: mid,
      embedding: true,
    }));
    return [...initChat, ...initEmbed];
  });
  const rowsRef = useRef<ModelRowsInputHandle | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const apiKeyFieldId = useId();
  const ollamaBaseUrlFieldId = useId();
  const modelsFieldId = useId();

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!isOllama) {
      // In edit mode an empty apiKey means «keep existing» — only required on
      // first add. Builtin secrets are write-only after commit, so we can't
      // surface the masked current value; an empty input is the «no change»
      // signal.
      if (!isEdit && apiKey.length === 0) errs.apiKey = t('add_field_apikey_invalid');
    } else if (ollamaBaseUrl.length > 0 && !URL.canParse(ollamaBaseUrl)) {
      errs.ollamaBaseUrl = t('add_field_base_url_invalid');
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function onSave() {
    setGlobalError(null);
    // flush BEFORE validate so validation sees the list we're about to save
    // (a focused draft/row edit the footer button's preventDefault left
    // unblurred). Matches the settings modals; the reverse order would let a
    // future "≥1 model" / "no dup id" rule judge the pre-flush list.
    const finalModels = rowsRef.current?.flush() ?? models;
    if (!validate()) return;
    setSaving(true);
    try {
      const chatIds = finalModels.filter((m) => !m.embedding).map((m) => m.id);
      const embedIds = finalModels.filter((m) => m.embedding).map((m) => m.id);
      const next: ProviderInitial = { models: chatIds, embeddingModels: embedIds };
      if (isOllama) {
        next.baseUrl = ollamaBaseUrl.length === 0 ? 'http://localhost:11434/v1' : ollamaBaseUrl;
      } else if (apiKey.length > 0) {
        next.apiKey = apiKey;
      }
      // Edit mode with empty apiKey: preserve existing key (don't overwrite).
      const merged = isEdit ? { ...existing, ...next } : next;
      await patch({
        providers: { [providerId]: merged },
      });
      onClose();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : t('add_save_error_heading'));
    } finally {
      setSaving(false);
    }
  }

  const heading = isEdit
    ? t('edit_builtin_modal_heading', { provider: label })
    : t('add_builtin_modal_heading', { provider: label });
  const desc = isOllama ? t('add_builtin_modal_desc_ollama') : t('add_builtin_modal_desc');

  return (
    <Modal
      heading={heading}
      desc={desc}
      onConfirm={onSave}
      onClose={saving ? () => {} : onClose}
      closeLabel={t('add_btn_cancel')}
      confirmLabel={saving ? t('add_btn_saving') : t('add_btn_save')}
      cancelLabel={t('add_btn_cancel')}
      confirmDisabled={saving}
      cancelDisabled={saving}
    >
      <div className="gp-add-provider-form">
        {isEmbeddingCtx && !meta.embeddingSupported ? (
          <Notice kind="warn">{tp('embedding_unsupported_notice')}</Notice>
        ) : null}
        {isOllama ? (
          <FormRow
            htmlFor={ollamaBaseUrlFieldId}
            label={t('ollama_row_label')}
            hint={t('ollama_baseurl_hint')}
            error={errors.ollamaBaseUrl}
          >
            <input
              id={ollamaBaseUrlFieldId}
              type="url"
              className="gp-sinput gp-sinput--full gp-sinput--mono"
              placeholder={t('ollama_baseurl_placeholder')}
              value={ollamaBaseUrl}
              onChange={(e) => setOllamaBaseUrl(e.target.value)}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
            />
          </FormRow>
        ) : (
          <FormRow
            htmlFor={apiKeyFieldId}
            label={t('add_field_apikey_label')}
            hint={isEdit ? tg('edit_apikey_hint') : undefined}
            error={errors.apiKey}
          >
            <input
              id={apiKeyFieldId}
              type="password"
              className="gp-sinput gp-sinput--full gp-sinput--mono"
              placeholder={
                isEdit
                  ? tg('edit_apikey_placeholder')
                  : (apiKeyPlaceholder ?? t('add_field_apikey_placeholder'))
              }
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={saving}
              autoComplete="new-password"
              spellCheck={false}
            />
          </FormRow>
        )}
        <FormRow
          htmlFor={modelsFieldId}
          label={tg('models_field_label')}
          hint={t('add_field_models_hint')}
        >
          <ModelRowsInput
            ref={rowsRef}
            value={models}
            onChange={setModels}
            disabled={saving}
            placeholder={modelsPlaceholder ?? t('models_field_add_placeholder')}
            inputId={modelsFieldId}
            inputAriaLabel={tg('provider_models_aria', { provider: providerId })}
            embeddingLabel={t('model_row_embedding_label')}
            embeddingAriaLabel={(mid) => t('model_row_embedding_aria', { model: mid || '?' })}
            removeAriaLabel={(mid) => t('model_row_remove_aria', { model: mid || '?' })}
          />
        </FormRow>
        {isEmbeddingCtx && meta.embeddingSupported && meta.embeddingExamples ? (
          <Notice kind="info">
            {tp('embedding_examples_hint', {
              provider: label,
              examples: meta.embeddingExamples.join(' / '),
            })}
          </Notice>
        ) : null}
        {globalError ? (
          <div role="alert" className="gp-form-error-banner">
            <strong>{t('add_save_error_heading')}: </strong>
            {globalError}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

interface FormRowProps {
  htmlFor: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}

function FormRow({ htmlFor, label, hint, error, children }: FormRowProps) {
  return (
    <div className="gp-add-provider-row">
      <label className="gp-add-provider-row__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="gp-add-provider-row__hint">{hint}</p> : null}
      {error ? (
        <p role="alert" className="gp-add-provider-row__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
