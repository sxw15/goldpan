'use client';

import { GoldpanApiError } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import type { GroupProps } from '../../settings-shell';
import { type Model, ModelRowsInput, type ModelRowsInputHandle } from './model-rows-input';

interface Props {
  group: GroupProps;
  onClose: () => void;
  /**
   * Fired AFTER a successful commit, BEFORE `onClose`. Parent uses this to
   * re-fetch `getLlmProviders()` so the new entry shows up in both the
   * Provider list and the Pipeline matrix dropdown without a full page
   * reload — without it users mistake the stale UI for "needs restart".
   */
  onSaved?: () => void;
  /**
   * Edit mode 触发条件：传入既有 provider 信息。
   * - id 字段变只读：重命名 = 新建 + 删除，复杂度收益不成比例，强制走删除流程
   * - apiKey 字段语义变为「留空 = 保持原值，填入 = 覆盖」
   * - apiKey 字段语义变为「留空 = 保持原值，填入 = 覆盖」
   * - apiKeyEnv 不向用户展示 — 由 id 自动推导（Add）或沿用 existing（Edit），写入 .env
   * - models / embeddingModels 当作 source-of-truth 的初始值（缺省空数组 = 用户没预录）
   * 不传 / undefined → Add mode（原行为）。
   */
  initial?: {
    id: string;
    baseUrl: string;
    apiKeyEnv: string;
    models: string[];
    embeddingModels: string[];
  };
  /**
   * 已配置 provider id 集合（builtin + custom + plugin），用于 Add 模式下查重。
   * Edit 模式 id readonly 时跳过。Server 端 commit 是按 env key patch（直接
   * 覆盖），不报"重复"错误 — UI 必须自己挡住，否则会把现有 provider 的
   * baseUrl / apiKeyEnv 静默覆盖。
   */
  existingIds?: ReadonlySet<string>;
}

// Mirror server-side `parseCustomLlmProviders` regex so the UI rejects bad
// input before we ever hit `commitEnv`. Dashes are intentionally disallowed:
// dynamic env keys cannot distinguish `together-ai` from `together_ai`.
const ID_REGEX = /^[a-z][a-z0-9_]*$/;
const ENV_VAR_REGEX = /^[A-Z_][A-Z0-9_]*$/;

function suggestApiKeyEnv(id: string): string {
  if (id.length === 0) return '';
  // `together-ai` → `TOGETHER_AI_API_KEY`. Matches the convention every
  // builtin uses (e.g., OPENROUTER_API_KEY).
  return `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

export function AddOpenAICompatModal({ group, onClose, onSaved, initial, existingIds }: Props) {
  const isEdit = initial !== undefined;
  const t = useTranslations('settings.llm');
  const [id, setId] = useState(initial?.id ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  // Row 形式的 model 列表 —— 每行 id + embedding 角色 toggle。提交前
  // rowsRef.flush() 会把当前 trailing input 的草稿也并进列表，避免用户输完
  // 最后一个 model 没按回车 / 失焦就点保存导致丢字段。
  const [models, setModels] = useState<Model[]>(() => {
    const initChat = (initial?.models ?? []).map((mid) => ({ id: mid, embedding: false }));
    const initEmbed = (initial?.embeddingModels ?? []).map((mid) => ({ id: mid, embedding: true }));
    return [...initChat, ...initEmbed];
  });
  const rowsRef = useRef<ModelRowsInputHandle | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // apiKeyEnv 不向用户展示：Add 由 id 推导；Edit 沿用 existing。
  const apiKeyEnv = isEdit ? (initial?.apiKeyEnv ?? '') : suggestApiKeyEnv(id);

  const idFieldId = useId();
  const baseUrlFieldId = useId();
  const apiKeyFieldId = useId();
  const modelsFieldId = useId();

  function validate(): boolean {
    const errs: Record<string, string> = {};
    // Edit 模式 id 只读，跳过校验（initial.id 已经服务端验证过）。
    if (!isEdit && !ID_REGEX.test(id)) errs.id = t('add_field_id_invalid');
    // Add 模式查重：阻止覆盖现有 provider（server 端 commitEnv 不会拒绝）。
    if (!isEdit && existingIds?.has(id)) errs.id = t('add_field_id_duplicate');
    let baseUrlOk = false;
    if (baseUrl.length > 0) {
      try {
        // URL.canParse avoids the noUnusedExpressions lint that fires on `new URL(...)`
        // used purely for validation; same throw-on-invalid behavior, no allocation noise.
        baseUrlOk = URL.canParse(baseUrl);
      } catch {
        baseUrlOk = false;
      }
    }
    if (!baseUrlOk) errs.baseUrl = t('add_field_base_url_invalid');
    // Accept the schema's stricter regex (allows leading underscore) so the
    // UI never rejects a value the server would accept.
    if (!ENV_VAR_REGEX.test(apiKeyEnv)) errs.apiKeyEnv = t('add_field_apikey_env_invalid');
    // apiKey 必填条件：
    //  - Add 模式恒必填
    //  - Edit 模式 + apiKeyEnv 改名 → 必填（新 env 还没值）
    //  - Edit 模式 + apiKeyEnv 不变 → 可选（留空 = 保持原值）
    const apiKeyEnvChanged = isEdit && initial !== undefined && initial.apiKeyEnv !== apiKeyEnv;
    const apiKeyOptional = isEdit && !apiKeyEnvChanged;
    if (apiKey.length === 0 && !apiKeyOptional) errs.apiKey = t('add_field_apikey_invalid');
    setErrors(errs);
    return Object.keys(errs).length === 0 && baseUrlOk;
  }

  async function onSave() {
    setGlobalError(null);
    // Force-commit any in-progress trailing draft so users who type the last
    // model id and immediately hit Save don't silently drop it. We use the
    // returned list directly — same-event reads of `models` state would still
    // see the pre-flush array because React 18 batches setState updates.
    const finalModels = rowsRef.current?.flush() ?? models;
    if (!validate()) return;
    setSaving(true);
    try {
      const upperId = id.toUpperCase().replace(/-/g, '_');
      const baseKey = `GOLDPAN_LLM_PROVIDER_${upperId}_BASE_URL`;
      const apiKeyEnvKey = `GOLDPAN_LLM_PROVIDER_${upperId}_API_KEY_ENV`;
      const modelsKey = `GOLDPAN_LLM_PROVIDER_${upperId}_MODELS`;
      const embedModelsKey = `GOLDPAN_LLM_PROVIDER_${upperId}_EMBEDDING_MODELS`;
      const chatIds = finalModels.filter((m) => !m.embedding).map((m) => m.id);
      const embedIds = finalModels.filter((m) => m.embedding).map((m) => m.id);
      const patch: Record<string, string> = {
        [baseKey]: baseUrl,
        [apiKeyEnvKey]: apiKeyEnv,
        [modelsKey]: chatIds.join(','),
        [embedModelsKey]: embedIds.join(','),
      };
      if (apiKey.length > 0) patch[apiKeyEnv] = apiKey;
      // Edit 模式下 apiKeyEnv 改名时不主动清旧 secret —— 旧 env name 留着是
      // 孤立变量，对 provider 功能无影响；强制清掉反而可能误删用户其它脚本依赖的值。
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
      // result.kind === 'errors' — map server paths back onto our 4 fields.
      // Server returns env-var paths (e.g., `GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL`).
      // Anything that doesn't match a known field falls into the global banner.
      const fieldErrors: Record<string, string> = {};
      const banner: string[] = [];
      for (const e of result.errors) {
        if (e.path === baseKey) fieldErrors.baseUrl = e.message;
        else if (e.path === apiKeyEnvKey) banner.push(e.message);
        else if (e.path === apiKeyEnv) fieldErrors.apiKey = e.message;
        else if (e.message.length > 0) banner.push(e.message);
      }
      if (Object.keys(fieldErrors).length > 0) setErrors(fieldErrors);
      if (banner.length > 0) setGlobalError(banner.join('; '));
      else if (Object.keys(fieldErrors).length === 0) {
        // Defensive: server returned `errors` but we couldn't surface any.
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
      heading={isEdit ? t('edit_openai_modal_heading') : t('add_openai_modal_heading')}
      desc={isEdit ? t('edit_openai_modal_desc') : t('add_openai_modal_desc')}
      onConfirm={onSave}
      // Lock close + buttons during in-flight save so a fast click on
      // Cancel doesn't strand the commit and leave the modal closed
      // with the user unsure whether it landed.
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
          hint={isEdit ? t('edit_field_id_hint_readonly') : t('add_field_id_hint')}
          error={errors.id}
        >
          <input
            id={idFieldId}
            type="text"
            className="gp-sinput gp-sinput--full"
            placeholder={t('add_field_id_placeholder')}
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={isEdit || saving}
            autoComplete="off"
            spellCheck={false}
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
          hint={isEdit ? t('edit_field_apikey_hint') : undefined}
          error={errors.apiKey}
        >
          <input
            id={apiKeyFieldId}
            type="password"
            className="gp-sinput gp-sinput--full gp-sinput--mono"
            placeholder={
              isEdit ? t('edit_field_apikey_placeholder_keep') : t('add_field_apikey_placeholder')
            }
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={saving}
            autoComplete="new-password"
            spellCheck={false}
          />
        </FormRow>
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

// Inline form row primitive — not promoted to a shared component because
// no other settings flow needs label+hint+error inline (SecretRow uses the
// SettingsField shell with restart/env tag scaffolding we don't want here).
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
