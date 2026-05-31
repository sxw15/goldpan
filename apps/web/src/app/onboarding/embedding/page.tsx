'use client';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { Btn } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsHead } from '@/components/ui/settings-head';
import { Toggle } from '@/components/ui/toggle';
import { BUILTIN_PROVIDER_IDS } from '../_components/builtin-provider-defaults';
import { hasCompleteModelId } from '../_components/model-id';
import { nextVisibleHref, prevVisibleHref, visibleIndex, visibleTotal } from '../_components/steps';
import { WizardField } from '../_components/wizard-field';
import { WizardProviderList } from '../_components/wizard-provider-list';
import { useWizard, useWizardNavigate, type WizardState } from '../_components/wizard-state';

type EmbeddingState = NonNullable<WizardState['embedding']>;

const DEFAULT_EMBEDDING: EmbeddingState = {
  enabled: false,
  dimensions: 0, // auto-detect
  batchSize: 100,
};

interface ProviderOption {
  id: string;
  source: 'builtin' | 'custom' | 'plugin';
}

export default function EmbeddingPage() {
  const t = useTranslations('onboarding.embedding');
  const tt = useTranslations('onboarding');
  const tp = useTranslations('onboarding.providers');
  const tProgress = useTranslations('onboarding.progress');
  const nav = useWizardNavigate();
  const { state, patch, availableProviders } = useWizard();

  const e = state.embedding ?? DEFAULT_EMBEDDING;

  function update(partial: Partial<EmbeddingState>): void {
    patch({ embedding: { ...e, ...partial } });
  }

  // Provider 列表来源对齐 step-card.tsx：
  //   1. 用户在 wizard 里已配置（apiKey / baseUrl 任一非空）的 provider；
  //   2. server 报告的 custom (.env) / plugin provider，且不与 wizard 项重复。
  // builtin 但用户还没配 apiKey 的不出现 —— 用户在本页顶部 <WizardProviderList />
  // 就近添加即可，不必回 pipeline 步骤。这样和 chat model 选择保持一致的契约：
  // 「provider × model 都来自用户已经录入的内容，不靠前端硬编码兜底」。
  const builtinIdSet = useMemo(() => new Set<string>(BUILTIN_PROVIDER_IDS), []);
  const providerOptions: ProviderOption[] = useMemo(() => {
    const map = new Map<string, ProviderOption>();
    for (const [id, cfg] of Object.entries(state.providers)) {
      if (!cfg?.apiKey && !cfg?.baseUrl) continue;
      const source: 'builtin' | 'custom' = builtinIdSet.has(id) ? 'builtin' : 'custom';
      map.set(id, { id, source });
    }
    for (const ap of availableProviders) {
      if (ap.source === 'builtin') continue;
      if (map.has(ap.id)) continue;
      map.set(ap.id, { id: ap.id, source: ap.source });
    }
    return Array.from(map.values());
  }, [state.providers, availableProviders, builtinIdSet]);

  // Decompose `e.model` (`provider:model`) into parts. 留空兼容历史 wizard state。
  const colonIdx = e.model?.indexOf(':') ?? -1;
  const effectiveProvider = colonIdx >= 0 && e.model ? e.model.slice(0, colonIdx) : '';
  const effectiveModel = colonIdx >= 0 && e.model ? e.model.slice(colonIdx + 1) : '';

  // Embedding 步骤只看 user 标记为 embedding 角色的 model（`_EMBEDDING_MODELS`
  // 来源），不看 chat models —— 真实模型层面 chat / embedding 集合互斥
  // (`gpt-4o` 没 embedding endpoint、`text-embedding-3-small` 没 chat endpoint)，
  // 不分离会让用户把 chat-only model 选进 embedding 而在运行时 400 / 404。
  // Fallback 与 step-card.tsx 的 chat 路径一致：wizard state 没记录就退到
  // server snapshot —— custom / plugin provider 完全 env-only 配置时（`.env`
  // 里有 `_EMBEDDING_MODELS`，wizard 没经手），下拉才能拿到列表。
  const embeddingModelsFor = (providerId: string): string[] =>
    state.providers[providerId]?.embeddingModels ??
    availableProviders.find((p) => p.id === providerId)?.embeddingModels ??
    [];
  const providerModels = embeddingModelsFor(effectiveProvider);
  const offListModel = effectiveModel !== '' && !providerModels.includes(effectiveModel);

  function selectProvider(providerId: string): void {
    if (providerId === effectiveProvider) return;
    const nextModels = embeddingModelsFor(providerId);
    const nextModel = nextModels[0] ?? '';
    update({ model: nextModel === '' ? `${providerId}:` : `${providerId}:${nextModel}` });
  }

  function selectModel(modelId: string): void {
    if (effectiveProvider === '') return;
    update({ model: `${effectiveProvider}:${modelId}` });
  }

  const providerLabel = (id: string): string => (builtinIdSet.has(id) ? tp(`${id}_label`) : id);

  return (
    <>
      <SettingsHead
        crumb={tProgress('step_n_of_total', {
          current: visibleIndex('embedding'),
          total: visibleTotal(),
        })}
        heading={t('section_title')}
        desc={t('enable_description')}
      />

      {/* Provider 卡与 pipeline 步骤复用同一个 <WizardProviderList />：两步都
          需要 provider × model，挂在两处让用户在 embedding 这步也能就近添加，
          而不用回退到 pipeline。state 同源 (useWizard)，删除 provider 时
          buildRemoveProviderPatch 已经会清掉 embedding.model 引用。
          context="embedding" 让组件把支持 embedding 的 provider 排在前面，
          并对不支持的 provider 标 tag、modal 里加示例 hint / 警告。 */}
      <WizardProviderList context="embedding" />

      {e.enabled && <Notice kind="info">{t('first_time_no_backfill')}</Notice>}

      <SettingsCard
        heading={t('enable_label')}
        right={<Toggle on={e.enabled} onChange={(v) => update({ enabled: v })} />}
      >
        {e.enabled && (
          <>
            <WizardField
              label={t('model_label')}
              control={
                <span className="gp-step-card__pickers">
                  <select
                    className="gp-sselect gp-step-card__provider-select"
                    aria-label={t('provider_select_aria')}
                    value={effectiveProvider}
                    onChange={(ev) => selectProvider(ev.target.value)}
                    disabled={providerOptions.length === 0}
                  >
                    <option value="" disabled>
                      {providerOptions.length === 0
                        ? tt('model_no_provider_configured')
                        : tt('model_provider_select_placeholder')}
                    </option>
                    {providerOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {providerLabel(o.id)}
                      </option>
                    ))}
                    {effectiveProvider !== '' &&
                    !providerOptions.some((o) => o.id === effectiveProvider) ? (
                      <option value={effectiveProvider}>{effectiveProvider} · ?</option>
                    ) : null}
                  </select>
                  <select
                    className="gp-sselect gp-sselect--mono gp-step-card__model-select"
                    aria-label={t('model_select_aria')}
                    value={effectiveModel}
                    onChange={(ev) => selectModel(ev.target.value)}
                    disabled={effectiveProvider === '' || providerModels.length === 0}
                  >
                    {effectiveModel === '' ? (
                      <option value="" disabled>
                        {providerModels.length === 0 && effectiveProvider !== ''
                          ? t('model_no_embedding_models')
                          : tt('model_select_placeholder')}
                      </option>
                    ) : null}
                    {providerModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {offListModel ? (
                      <option value={effectiveModel}>{effectiveModel} · ?</option>
                    ) : null}
                  </select>
                </span>
              }
              hint={t('model_hint_pick_embedding')}
            />
            <details className="gp-onboarding-advanced">
              <summary>{t('advanced_collapse')}</summary>
              <WizardField
                label={t('dimensions_label')}
                control={
                  <input
                    type="number"
                    min={0}
                    value={e.dimensions ?? 0}
                    onChange={(ev) => update({ dimensions: Number(ev.target.value) })}
                  />
                }
              />
              <WizardField
                label={t('batch_size_label')}
                control={
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={e.batchSize ?? 100}
                    onChange={(ev) => update({ batchSize: Number(ev.target.value) })}
                  />
                }
              />
            </details>
          </>
        )}
      </SettingsCard>

      <div className="gp-onboarding__actions gp-onboarding__actions--split">
        <Btn kind="ghost" onClick={() => nav(prevVisibleHref('embedding'))}>
          {tt('back_button')}
        </Btn>
        <Btn
          kind="primary"
          // 与 pipeline 步骤对称：embedding enabled 时必须有完整 `provider:model`
          // 才允许 Next。半成品 `'openai:'` 落到 .env 会让 loadConfig 时
          // modelIdSchema 抛错，server 起不来；上一版没校验是 silent failure。
          // disabled 时禁用：embedding 关闭则无所谓 model 是否填。
          disabled={e.enabled && !hasCompleteModelId(e.model)}
          onClick={() => nav(nextVisibleHref('embedding'))}
        >
          {tt('next_button')}
        </Btn>
      </div>
    </>
  );
}
