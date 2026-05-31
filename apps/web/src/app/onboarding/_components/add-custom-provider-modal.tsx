// apps/web/src/app/onboarding/_components/add-custom-provider-modal.tsx
//
// Single Modal for both adding and editing a custom OpenAI-compatible provider
// in the wizard. `mode='add'` shows an empty form with id editable; `mode='edit'`
// prefills from the provider's current wizard state and locks `id` (renaming
// would force the server to remap env keys — out of scope).
//
// Wizard-side mirror of the settings page «Add OpenAI-compat Provider» modal
// (`apps/web/src/app/settings/groups/_components/add-openai-compat-modal.tsx`).
// Reuses the settings.llm i18n keys verbatim. Writes to wizard state via
// `useWizard().patch({ providers: ... })` instead of `commitEnv`. The final
// env-var fan-out (BASE_URL / API_KEY_ENV / MODELS / secret) happens
// server-side in `apps/server/src/routes/onboarding/commit.ts`'s
// `stateToEnvKeys` once the wizard reaches the F8 commit step.
'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import {
  type Model,
  ModelRowsInput,
  type ModelRowsInputHandle,
} from '../../settings/groups/_components/model-rows-input';
import { useWizard } from './wizard-state';

interface ProviderInitial {
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  embeddingModels?: string[];
  apiKeyEnv?: string;
}

interface Props {
  onClose: () => void;
  /** Optional callback after a successful save (for caller-side state cleanup). */
  onSaved?: () => void;
  /** 'add' creates a fresh provider; 'edit' prefills from `existing` and locks id. */
  mode?: 'add' | 'edit';
  /** Required when `mode='edit'`. Provider id whose record we're editing. */
  providerId?: string;
  /** Required when `mode='edit'`. Current wizard-state value for this provider. */
  existing?: ProviderInitial;
}

const ID_REGEX = /^[a-z][a-z0-9_]*$/;
const ENV_VAR_REGEX = /^[A-Z_][A-Z0-9_]*$/;

function suggestApiKeyEnv(id: string): string {
  if (id.length === 0) return '';
  return `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

export function AddCustomProviderModal({
  onClose,
  onSaved,
  mode = 'add',
  providerId,
  existing,
}: Props) {
  const isEdit = mode === 'edit';
  const t = useTranslations('settings.llm');
  const tg = useTranslations('onboarding');
  const { state, patch, availableProviders } = useWizard();

  const [id, setId] = useState(isEdit ? (providerId ?? '') : '');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
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

  // apiKeyEnv 不向用户展示：Add 由 id 推导；Edit 沿用 existing（避免破坏 .env
  // 里非约定名）。提交时仍写入 GOLDPAN_LLM_PROVIDER_*_API_KEY_ENV 与密钥变量。
  const apiKeyEnv = isEdit ? (existing?.apiKeyEnv ?? '') : suggestApiKeyEnv(id);

  const idFieldId = useId();
  const baseUrlFieldId = useId();
  const apiKeyFieldId = useId();
  const modelsFieldId = useId();

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!isEdit) {
      if (!ID_REGEX.test(id)) errs.id = t('add_field_id_invalid');
      // Reject ids that would collide with a builtin — the builtin secret env
      // mapping in commit.ts owns those slots, and overriding via the custom
      // path would emit conflicting env vars.
      if (['openai', 'anthropic', 'deepseek', 'openrouter', 'google', 'ollama'].includes(id)) {
        errs.id = t('add_field_id_duplicate');
      }
      // Reject duplicate id (already configured in this wizard session or
      // discovered from .env/plugin providers). Wizard state would shadow the
      // external provider after commit, which is never an intentional add flow.
      if (state.providers[id] || availableProviders.some((p) => p.id === id)) {
        errs.id = t('add_field_id_duplicate');
      }
    }
    let baseUrlOk = false;
    if (baseUrl.length > 0) {
      try {
        baseUrlOk = URL.canParse(baseUrl);
      } catch {
        baseUrlOk = false;
      }
    }
    if (!baseUrlOk) errs.baseUrl = t('add_field_base_url_invalid');
    if (!ENV_VAR_REGEX.test(apiKeyEnv)) errs.apiKeyEnv = t('add_field_apikey_env_invalid');
    // Edit mode allows empty apiKey (= keep existing). Add mode requires it.
    if (!isEdit && apiKey.length === 0) errs.apiKey = t('add_field_apikey_invalid');
    setErrors(errs);
    return Object.keys(errs).length === 0 && baseUrlOk;
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
      const next: ProviderInitial = {
        baseUrl,
        apiKeyEnv,
        models: chatIds,
        embeddingModels: embedIds,
      };
      if (apiKey.length > 0) next.apiKey = apiKey;
      // Edit mode with empty apiKey: preserve existing key (don't overwrite).
      const merged = isEdit ? { ...existing, ...next } : next;
      await patch({
        providers: { [id]: merged },
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : t('add_save_error_heading'));
    } finally {
      setSaving(false);
    }
  }

  const heading = isEdit ? t('edit_openai_modal_heading') : t('add_openai_modal_heading');

  return (
    <Modal
      heading={heading}
      desc={t('add_openai_modal_desc')}
      onConfirm={onSave}
      onClose={saving ? () => {} : onClose}
      closeLabel={t('add_btn_cancel')}
      confirmLabel={saving ? t('add_btn_saving') : t('add_btn_save')}
      cancelLabel={t('add_btn_cancel')}
      confirmDisabled={saving}
      cancelDisabled={saving}
    >
      <div className="gp-add-provider-form">
        <FormRow
          htmlFor={idFieldId}
          label={t('add_field_id_label')}
          hint={t('add_field_id_hint')}
          error={errors.id}
        >
          <input
            id={idFieldId}
            type="text"
            className="gp-sinput gp-sinput--full"
            placeholder={t('add_field_id_placeholder')}
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={saving}
            autoComplete="off"
            spellCheck={false}
            readOnly={isEdit}
          />
        </FormRow>
        <FormRow
          htmlFor={baseUrlFieldId}
          label={t('add_field_base_url_label')}
          hint={t('add_field_base_url_hint')}
          error={errors.baseUrl}
        >
          <input
            id={baseUrlFieldId}
            type="url"
            className="gp-sinput gp-sinput--full gp-sinput--mono"
            placeholder={t('add_field_base_url_placeholder')}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            disabled={saving}
            autoComplete="off"
            spellCheck={false}
          />
        </FormRow>
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
            placeholder={isEdit ? tg('edit_apikey_placeholder') : t('add_field_apikey_placeholder')}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={saving}
            autoComplete="new-password"
            spellCheck={false}
          />
        </FormRow>
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
            placeholder={t('models_field_add_placeholder')}
            inputId={modelsFieldId}
            inputAriaLabel={tg('provider_models_aria', { provider: id || 'provider' })}
            embeddingLabel={t('model_row_embedding_label')}
            embeddingAriaLabel={(mid) => t('model_row_embedding_aria', { model: mid || '?' })}
            removeAriaLabel={(mid) => t('model_row_remove_aria', { model: mid || '?' })}
          />
        </FormRow>
        {errors.apiKeyEnv ? (
          <div role="alert" className="gp-form-error-banner">
            {errors.apiKeyEnv}
          </div>
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
