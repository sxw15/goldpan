'use client';

import type { LlmProvidersResponse } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsHead } from '@/components/ui/settings-head';
import { Tag } from '@/components/ui/tag';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { LLM_STEP_CATEGORY_ORDER, LLM_STEPS, type LlmStepCategory } from '../llm-steps';
import type { GroupProps } from '../settings-shell';
import { AddProviderCard } from './_components/add-provider-card';
import { BuiltinProviderRow } from './_components/builtin-provider-row';
import { BUILTIN_PROVIDERS, findBuiltinMeta } from './_components/builtin-providers';
import { CustomProviderRow } from './_components/custom-provider-row';
import { LlmTimeoutPanel } from './_components/llm-timeout-panel';
import { PipelineStepRow } from './_components/pipeline-step-row';

type LlmSettingsTab = 'pipeline' | 'providers';

interface GroupLLMProps extends GroupProps {
  /** Deep-link hint from `navigateToGroup('llm', { llmTab: ... })` — picks the
   * tab to mount on. Consumed once at mount; the shell clears it when the user
   * leaves the LLM group, so re-entering without a hint resets to default. */
  initialTab?: LlmSettingsTab;
}

export function GroupLLM(props: GroupLLMProps) {
  const t = useTranslations('settings.llm');
  const [providers, setProviders] = useState<LlmProvidersResponse | null>(null);
  const [tab, setTab] = useState<LlmSettingsTab>(props.initialTab ?? 'providers');

  const loadProviders = useCallback(() => {
    // Failure 时回落空集：错误吞掉换"什么都不渲染" — 接口挂掉不该挡住用户操作
    // (Pipeline 下拉仍能用 step 默认值 / 已有 env 配置)。
    getBrowserApiClient()
      .getLlmProviders()
      .then(setProviders)
      .catch(() => setProviders({ builtin: [], custom: [], plugin: [] }));
  }, []);

  // 初次挂载 + 保存后 env 更新都触发 refetch：mount 时 props.env 是 initial Map ref，
  // 用户编辑 builtin 的 `_MODELS` 后通过 standard save bar 保存，settings-shell 替换
  // store.env Map ref → 这里重新跑 → Pipeline 下拉刷新。仅 LLM tab 挂载时执行；
  // 其它 group 的保存不会触发，因为 GroupLLM 已经卸载。
  useEffect(() => {
    void props.env.size;
    loadProviders();
  }, [props.env, loadProviders]);

  // Filter providers by configured state — main list only shows what's
  // actually wired up; the "Add Provider" card surfaces the rest.
  const builtinConfigured = useMemo(
    () => providers?.builtin.filter((b) => b.apiKeyConfigured) ?? [],
    [providers],
  );
  const builtinUnconfigured = useMemo(
    () => providers?.builtin.filter((b) => !b.apiKeyConfigured) ?? [],
    [providers],
  );
  const customs = useMemo(() => providers?.custom ?? [], [providers]);
  const plugins = useMemo(() => providers?.plugin ?? [], [providers]);

  // Add modal 用来挡 id 重复（commitEnv 不会拒，UI 不挡会静默覆盖现有 provider）。
  // builtin 全量 6 个都纳入：unconfigured builtin 也是「已分配的命名空间」。
  const existingProviderIds = useMemo<ReadonlySet<string>>(
    () =>
      new Set([
        ...BUILTIN_PROVIDERS.map((b) => b.id),
        ...customs.map((c) => c.id),
        ...plugins.map((p) => p.providerId),
      ]),
    [customs, plugins],
  );

  const hasConfigured = builtinConfigured.length > 0 || customs.length > 0;

  const stepsByCategory = useMemo(() => {
    const out: Record<LlmStepCategory, typeof LLM_STEPS> = {
      pipeline: [],
      query: [],
      digest: [],
    };
    for (const step of LLM_STEPS) {
      out[step.category] = [...out[step.category], step];
    }
    return out;
  }, []);

  // Lifted "pending provider" state: keyed by step envKey, holds the user's
  // provider pick for rows where a model hasn't been selected yet. Owning
  // this here (instead of inside each PipelineStepRow) keeps the picks
  // alive across Pipeline ↔ Providers tab switches — the pipeline panel
  // is conditional-rendered (`tab === 'pipeline' ? <div>...</div> : null`)
  // and unmounting would otherwise destroy every row's local state. The
  // setFieldEditing leave-guard wiring also lives up here for the same
  // reason: unmounted children can't keep reporting "editing".
  const [pendingProviders, setPendingProviders] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const updatePendingProvider = useCallback((envKey: string, value: string | null) => {
    setPendingProviders((prev) => {
      if (value === null) {
        if (!prev.has(envKey)) return prev;
        const next = new Map(prev);
        next.delete(envKey);
        return next;
      }
      if (prev.get(envKey) === value) return prev;
      const next = new Map(prev);
      next.set(envKey, value);
      return next;
    });
  }, []);
  // Pre-bind a per-step setter so each PipelineStepRow receives a stable
  // identity — important because the row keeps `setPendingProvider` in a
  // useEffect dep array and would otherwise re-run on every parent render.
  // updatePendingProvider is useCallback-stable; LLM_STEPS is a module
  // const so the Map only rebuilds when updatePendingProvider rotates
  // (effectively never after mount).
  const perStepSetters = useMemo(() => {
    const m = new Map<string, (v: string | null) => void>();
    for (const step of LLM_STEPS) {
      m.set(step.envKey, (v) => updatePendingProvider(step.envKey, v));
    }
    return m;
  }, [updatePendingProvider]);
  // Wire pending picks into the shell's leave-guard. Each pending key
  // reports editing=true; the cleanup releases the entries this effect
  // registered.
  //
  // Per-render cost: 2N setFieldEditing calls when the Map identity
  // changes (N for the cleanup releasing old registrations, N for the
  // setup re-registering current ones). setFieldEditing's underlying
  // setEditingFields uses bail-out reducers
  // (`prev.includes(envKey) ? prev : [...prev, envKey]` for adds,
  // `prev.includes(envKey) ? prev.filter(...) : prev` for removes — see
  // settings-shell.tsx setFieldEditing definition), so identical
  // re-registrations short-circuit at the reducer level and React only
  // reconciles on the actual delta. Net cost: O(N) function-call
  // overhead, O(actualDelta) React work.
  //
  // Trade-off vs. a per-key diff (track previous registered set in a
  // ref, send only add/remove deltas): simpler invariant here ("after
  // every render of GroupLLM, every key in pendingProviders is reported
  // editing=true"), no ref bookkeeping, no risk of leaving stale entries
  // if cleanup paths diverge. Accepted at current scale (≤15 LLM_STEPS).
  const { setFieldEditing } = props;
  useEffect(() => {
    const registered = Array.from(pendingProviders.keys());
    for (const key of registered) {
      setFieldEditing(key, true);
    }
    return () => {
      for (const key of registered) {
        setFieldEditing(key, false);
      }
    };
  }, [pendingProviders, setFieldEditing]);

  const pipelinePanel =
    tab === 'pipeline' ? (
      <div role="tabpanel" id="gp-llm-tab-panel-pipeline" aria-labelledby="gp-llm-tab-pipeline">
        <SettingsCard heading={t('matrix_heading')}>
          <div className="gp-llm-matrix">
            {LLM_STEP_CATEGORY_ORDER.map((cat, idx) => {
              const steps = stepsByCategory[cat];
              if (steps.length === 0) return null;
              return (
                <section
                  key={cat}
                  className={`gp-llm-section${idx > 0 ? ' gp-llm-section--separated' : ''}`}
                  aria-labelledby={`gp-llm-section-${cat}`}
                >
                  <header className="gp-llm-section__head">
                    <h3 id={`gp-llm-section-${cat}`} className="gp-llm-section__title">
                      {t(`matrix_section_${cat}_title`)}
                    </h3>
                    <p className="gp-llm-section__desc">{t(`matrix_section_${cat}_desc`)}</p>
                  </header>
                  {steps.map((step) => (
                    <PipelineStepRow
                      key={step.id}
                      step={step}
                      env={props.env}
                      providers={providers}
                      commit={props.commit}
                      resetEnvKey={props.resetEnvKey}
                      inFlightKeys={props.inFlightKeys}
                      pendingProvider={pendingProviders.get(step.envKey) ?? null}
                      // biome-ignore lint/style/noNonNullAssertion: perStepSetters seeds every LLM_STEPS entry; this Map always has the key.
                      setPendingProvider={perStepSetters.get(step.envKey)!}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        </SettingsCard>
        <SettingsCard heading={t('timeout_heading')}>
          <LlmTimeoutPanel
            env={props.env}
            commit={props.commit}
            resetEnvKey={props.resetEnvKey}
            setFieldEditing={props.setFieldEditing}
          />
        </SettingsCard>
      </div>
    ) : null;

  const providersPanel =
    tab === 'providers' ? (
      <div role="tabpanel" id="gp-llm-tab-panel-providers" aria-labelledby="gp-llm-tab-providers">
        <SettingsCard heading={t('configured_providers_heading')}>
          {hasConfigured ? (
            <div className="gp-llm-provider-list">
              {/* Render builtins in canonical order (BUILTIN_PROVIDERS), not in
                  whatever order the server returned them — keeps the list
                  stable across refreshes. */}
              {BUILTIN_PROVIDERS.flatMap((meta) => {
                const b = builtinConfigured.find((x) => x.id === meta.id);
                if (!b) return [];
                return [
                  <BuiltinProviderRow
                    key={`builtin-${meta.id}`}
                    group={props}
                    meta={meta}
                    builtin={b}
                    onChanged={loadProviders}
                  />,
                ];
              })}
              {customs.map((c) => (
                <CustomProviderRow
                  key={`custom-${c.id}`}
                  group={props}
                  provider={c}
                  onChanged={loadProviders}
                />
              ))}
            </div>
          ) : (
            <div className="gp-llm-provider-list">
              <p className="gp-llm-empty">{t('no_configured_providers')}</p>
            </div>
          )}
        </SettingsCard>
        {plugins.length > 0 ? (
          <SettingsCard heading={t('plugin_providers_heading')}>
            {/* Plugin 行仍只读 — plugin 注册由 plugin manifest 管控，UI 编辑会
                跨越层级。 */}
            {plugins.map((p) => (
              <div key={`plugin-${p.providerId}`} className="gp-llm-extra-row">
                <div className="gp-llm-extra-row__id">{p.providerId}</div>
                <Tag kind="default">{t('source_plugin')}</Tag>
                <div className="gp-llm-extra-row__meta">{p.pluginName}</div>
                {p.status === 'loaded' ? (
                  <Tag kind="live">{t('status_loaded')}</Tag>
                ) : p.status === 'failed' ? (
                  <Tag kind="shadowed">{t('status_failed')}</Tag>
                ) : (
                  <Tag kind="restart">{t('status_skipped_conflict')}</Tag>
                )}
                {p.status === 'failed' && p.error ? (
                  <details className="gp-llm-extra-row__error">
                    <summary>{t('error_details_summary')}</summary>
                    <pre>{p.error}</pre>
                  </details>
                ) : null}
              </div>
            ))}
          </SettingsCard>
        ) : null}
        <AddProviderCard
          group={props}
          onProviderSaved={loadProviders}
          unconfiguredBuiltins={builtinUnconfigured.flatMap((b) => {
            const meta = findBuiltinMeta(b.id);
            return meta ? [meta] : [];
          })}
          existingIds={existingProviderIds}
        />
      </div>
    ) : null;

  return (
    <>
      <SettingsHead crumb={t('crumb')} heading={t('heading')} desc={t('desc')} />
      <div className="gp-llm-tab-bar">
        <div className="gp-channel-tabs" role="tablist" aria-label={t('tabs_aria')}>
          <button
            type="button"
            role="tab"
            id="gp-llm-tab-providers"
            className="gp-channel-tab"
            aria-selected={tab === 'providers'}
            aria-controls="gp-llm-tab-panel-providers"
            tabIndex={tab === 'providers' ? 0 : -1}
            onClick={() => setTab('providers')}
          >
            {t('tab_providers')}
          </button>
          <button
            type="button"
            role="tab"
            id="gp-llm-tab-pipeline"
            className="gp-channel-tab"
            aria-selected={tab === 'pipeline'}
            aria-controls="gp-llm-tab-panel-pipeline"
            tabIndex={tab === 'pipeline' ? 0 : -1}
            onClick={() => setTab('pipeline')}
          >
            {t('matrix_heading')}
          </button>
        </div>
      </div>
      {pipelinePanel ?? providersPanel}
    </>
  );
}
