'use client';

import { GoldpanApiError } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Toggle } from '@/components/ui/toggle';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import type { GroupProps } from '../../settings-shell';
import type { BuiltinProviderMeta } from './builtin-providers';
import { type Model, ModelRowsInput, type ModelRowsInputHandle } from './model-rows-input';

interface BuiltinProviderModalInitial {
  models: string[];
  embeddingModels: string[];
  /** Only for ollama edit mode. */
  ollamaBaseUrl?: string;
  ollamaEnabled?: boolean;
}

interface Props {
  group: GroupProps;
  meta: BuiltinProviderMeta;
  onClose: () => void;
  /** Triggered after a successful commit so parent can refetch providers. */
  onSaved?: () => void;
  /**
   * Edit mode: caller passes existing models (and ollama-specific state).
   * undefined → Add mode (blank inputs).
   *
   * API key is intentionally never re-populated — secrets are masked
   * server-side; treating empty input as "keep existing value" matches
   * `AddOpenAICompatModal` semantics.
   */
  initial?: BuiltinProviderModalInitial;
}

/**
 * Add / edit modal for a builtin LLM provider (Anthropic / OpenAI / DeepSeek /
 * OpenRouter / Google / Ollama). Replaces the inline `SecretRow` + `OllamaRow`
 * pattern in `llm.tsx` so:
 *   - users only see configured providers in the main list (cleaner page);
 *   - adding a new builtin is a focused modal flow per provider;
 *   - the same modal handles edit (prefill existing models / ollama state).
 *
 * Two field shapes by `meta.id`:
 *   - ollama: baseUrl (text) + enabled toggle + models (chips). No API key.
 *   - everything else: API key (password) + models (chips).
 */
export function AddBuiltinProviderModal({ group, meta, onClose, onSaved, initial }: Props) {
  const isEdit = initial !== undefined;
  const isOllama = meta.id === 'ollama';
  const t = useTranslations('settings.llm');

  // Shared — model rows，每行 id + embedding 角色 toggle，初始化时把 chat /
  // embedding 两份合并成一个统一列表。
  const [models, setModels] = useState<Model[]>(() => {
    const initChat = (initial?.models ?? []).map((mid) => ({ id: mid, embedding: false }));
    const initEmbed = (initial?.embeddingModels ?? []).map((mid) => ({ id: mid, embedding: true }));
    return [...initChat, ...initEmbed];
  });
  const rowsRef = useRef<ModelRowsInputHandle | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // API key (non-ollama)
  const [apiKey, setApiKey] = useState('');

  // Ollama
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(initial?.ollamaBaseUrl ?? '');
  const [ollamaEnabled, setOllamaEnabled] = useState(initial?.ollamaEnabled ?? true);

  const apiKeyFieldId = useId();
  const modelsFieldId = useId();
  const ollamaBaseUrlFieldId = useId();

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!isOllama) {
      // Add mode: API key required. Edit mode: optional (empty = keep existing).
      if (!isEdit && apiKey.length === 0) errs.apiKey = t('add_field_apikey_invalid');
    } else {
      // Ollama: baseUrl optional in edit mode (keeps current); for add, fall
      // back to the conventional default if user left it blank — that's the
      // most common case for first-run "I have a local daemon" users.
      if (ollamaBaseUrl.length > 0 && !URL.canParse(ollamaBaseUrl)) {
        errs.ollamaBaseUrl = t('add_field_base_url_invalid');
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function onSave() {
    setGlobalError(null);
    // Force-commit any in-progress trailing draft (see ModelRowsInputHandle).
    const finalModels = rowsRef.current?.flush() ?? models;
    if (!validate()) return;
    setSaving(true);
    try {
      const upperId = meta.id.toUpperCase().replace(/-/g, '_');
      const modelsKey = `GOLDPAN_LLM_PROVIDER_${upperId}_MODELS`;
      const embedModelsKey = `GOLDPAN_LLM_PROVIDER_${upperId}_EMBEDDING_MODELS`;
      const chatIds = finalModels.filter((m) => !m.embedding).map((m) => m.id);
      const embedIds = finalModels.filter((m) => m.embedding).map((m) => m.id);
      const patch: Record<string, string> = {
        [modelsKey]: chatIds.join(','),
        [embedModelsKey]: embedIds.join(','),
      };

      if (isOllama) {
        // First-run convention: enabling ollama implies the daemon at the
        // user's chosen base URL (or the default localhost endpoint) is
        // reachable. We don't probe — that's the user's job.
        const baseUrl = ollamaBaseUrl.length > 0 ? ollamaBaseUrl : 'http://localhost:11434/v1';
        patch.OLLAMA_BASE_URL = baseUrl;
        patch.GOLDPAN_OLLAMA_ENABLED = ollamaEnabled ? 'true' : 'false';
      } else if (apiKey.length > 0) {
        patch[meta.apiKeyEnv] = apiKey;
      }

      const result = await getBrowserApiClient().commitEnv(patch);
      if (result.kind === 'ok') {
        group.applyEnvItems(result.updatedItems);
        group.toast({
          msg: isEdit ? t('edit_save_ok_toast') : t('add_save_ok_toast'),
          kind: 'success',
        });
        onSaved?.();
        onClose();
        return;
      }
      // result.kind === 'errors' — surface field-level vs banner errors.
      const fieldErrors: Record<string, string> = {};
      const banner: string[] = [];
      for (const e of result.errors) {
        if (e.path === meta.apiKeyEnv) fieldErrors.apiKey = e.message;
        else if (e.path === 'OLLAMA_BASE_URL') fieldErrors.ollamaBaseUrl = e.message;
        else if (e.message.length > 0) banner.push(e.message);
      }
      if (Object.keys(fieldErrors).length > 0) setErrors(fieldErrors);
      if (banner.length > 0) setGlobalError(banner.join('; '));
      else if (Object.keys(fieldErrors).length === 0) {
        setGlobalError(t('add_save_error_heading'));
      }
    } catch (err) {
      const msg =
        err instanceof GoldpanApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : t('add_save_error_heading');
      setGlobalError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      heading={
        isEdit
          ? t('edit_builtin_modal_heading', { provider: meta.label })
          : t('add_builtin_modal_heading', { provider: meta.label })
      }
      desc={isOllama ? t('add_builtin_modal_desc_ollama') : t('add_builtin_modal_desc')}
      onConfirm={onSave}
      // Block re-close mid-save so the user can't dismiss the modal,
      // leaving the commit in flight while the page mounts something
      // else that races for the same env keys. Mirrors confirmDisabled.
      onClose={saving ? () => {} : onClose}
      closeLabel={t('add_btn_cancel')}
      confirmLabel={saving ? t('add_btn_saving') : t('add_btn_save')}
      cancelLabel={t('add_btn_cancel')}
      confirmDisabled={saving}
      cancelDisabled={saving}
    >
      <div className="gp-add-provider-form">
        {isOllama ? (
          <>
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
            <FormRow
              htmlFor={`${ollamaBaseUrlFieldId}-toggle`}
              label={t('ollama_enable_label')}
              hint={t('ollama_row_hint')}
            >
              <Toggle
                ariaLabel={t('ollama_enable_label')}
                on={ollamaEnabled}
                disabled={saving}
                onChange={setOllamaEnabled}
              />
            </FormRow>
          </>
        ) : (
          <FormRow
            htmlFor={apiKeyFieldId}
            label={t('add_field_apikey_label')}
            hint={isEdit ? t('edit_field_apikey_hint') : undefined}
            error={errors.apiKey}
          >
            <input
              id={apiKeyFieldId}
              type="password"
              className="gp-sinput gp-sinput--full gp-sinput--mono"
              placeholder={
                isEdit
                  ? t('edit_field_apikey_placeholder_keep')
                  : (meta.apiKeyPlaceholder ?? t('add_field_apikey_placeholder'))
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
          label={t('add_field_models_label')}
          hint={t('add_field_models_hint')}
        >
          <ModelRowsInput
            ref={rowsRef}
            value={models}
            onChange={setModels}
            disabled={saving}
            placeholder={t('models_field_add_placeholder')}
            inputId={modelsFieldId}
            inputAriaLabel={t('add_field_models_label')}
            embeddingLabel={t('model_row_embedding_label')}
            embeddingAriaLabel={(mid) => t('model_row_embedding_aria', { model: mid || '?' })}
            removeAriaLabel={(mid) => t('model_row_remove_aria', { model: mid || '?' })}
          />
        </FormRow>
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
