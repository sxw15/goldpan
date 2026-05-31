// apps/web/src/app/onboarding/_components/wizard-provider-list.tsx
//
// Replaces the old `ChipArea` on the F2 Pipeline page. Visually mirrors the
// settings-page «LLM Provider» layout — same two-card split (Card 1:
// configured providers / empty state; Card 2: add provider, with heading +
// desc + builtin add buttons), so users moving between onboarding and
// settings see the identical affordance.
//
// State source is the wizard (`useWizard()` → `state.providers`), NOT the
// settings env store. The settings-page components (`BuiltinProviderRow`,
// `AddProviderCard`, …) couldn't be reused directly because they read/write
// env keys via `GroupProps`. Sharing visual classes is fine; sharing state
// adapters would require unifying two store shapes — out of scope here.
//
// Removing a provider must also clear any step / digest / embedding model
// that referenced it — otherwise dropdowns hold dangling `provider:model`
// strings whose provider chip just vanished. See `buildRemoveProviderPatch`.
'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Btn } from '@/components/ui/button';
import { SettingsCard } from '@/components/ui/settings-card';
import { Tag } from '@/components/ui/tag';
import { AddBuiltinProviderModal } from './add-builtin-provider-modal';
import { AddCustomProviderModal } from './add-custom-provider-modal';
import { BUILTIN_PROVIDER_IDS, type BuiltinId, builtinMeta } from './builtin-provider-defaults';
import { useWizard, type WizardState, type WizardStatePatch } from './wizard-state';

/** Caller context. `embedding` reorders unconfigured builtins so providers
 *  with an embedding endpoint surface first, tags the rest, and forwards the
 *  flag to the modal so it can render embedding-specific hints / warnings. */
export type ProviderListContext = 'pipeline' | 'embedding';

interface Props {
  context?: ProviderListContext;
}

const BUILTIN_ID_SET: ReadonlySet<string> = new Set<string>(BUILTIN_PROVIDER_IDS);

const KNOWN_LABEL_IDS = new Set<string>(BUILTIN_PROVIDER_IDS);

const PLACEHOLDER_MODELS_DISPLAY: Readonly<Record<string, string>> = {
  anthropic: 'claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001',
  openai: 'gpt-4o, gpt-4o-mini',
  google: 'gemini-2.0-flash, gemini-1.5-pro',
  deepseek: 'deepseek-v4-flash, deepseek-v4-pro',
  openrouter: 'anthropic/claude-sonnet-4, openai/gpt-4o-mini',
  ollama: 'llama3.2:8b, qwen2.5:7b',
};

function providerLabel(id: string, tp: (key: string) => string): string {
  return KNOWN_LABEL_IDS.has(id) ? tp(`${id}_label`) : id;
}

/**
 * Compute a wizard patch that removes a provider and clears every model
 * reference that depended on it. Exported standalone so other onboarding
 * pages (digest, embedding) can audit removal effects in tests.
 */
export function buildRemoveProviderPatch(id: string, state: WizardState): WizardStatePatch {
  const patch: WizardStatePatch = {
    providers: { [id]: null },
  };
  for (const [step, cfg] of Object.entries(state.steps)) {
    if (cfg.model?.startsWith(`${id}:`)) {
      patch.steps = patch.steps ?? {};
      patch.steps[step] = { ...cfg, model: null };
    }
  }
  const digestPatch: NonNullable<WizardStatePatch['digest']> = {};
  if (state.digest?.summaryModel?.startsWith(`${id}:`)) digestPatch.summaryModel = null;
  if (state.digest?.actionModel?.startsWith(`${id}:`)) digestPatch.actionModel = null;
  if (Object.keys(digestPatch).length > 0) patch.digest = digestPatch;
  if (state.embedding?.model?.startsWith(`${id}:`)) {
    patch.embedding = { model: null };
  }
  return patch;
}

export function WizardProviderList({ context = 'pipeline' }: Props = {}) {
  const t = useTranslations('onboarding.providers');
  const tg = useTranslations('onboarding');
  const tSettings = useTranslations('settings.llm');
  const { state, patch } = useWizard();
  const isEmbedding = context === 'embedding';
  /**
   * Provider modal slot. `kind` picks the form variant (builtin vs custom);
   * `mode='edit'` swaps add-Modal copy for edit copy and prefills from the
   * existing wizard-state record. One slot is enough — only one Modal can be
   * open at a time, so we don't need separate states for each (kind, mode).
   */
  const [providerModal, setProviderModal] = useState<
    | { kind: 'builtin'; providerId: BuiltinId; mode: 'add' | 'edit' }
    | { kind: 'custom'; providerId?: string; mode: 'add' | 'edit' }
    | null
  >(null);

  const configured = Object.entries(state.providers).filter(([, v]) =>
    Boolean(v.apiKey ?? v.baseUrl),
  );
  const configuredIds = new Set(configured.map(([id]) => id));

  // Builtins not yet configured → render as "+ Add X" buttons. Default order
  // follows BUILTIN_PROVIDER_IDS to match the canonical settings-page order.
  // In embedding context: stable-sort so providers with embedding endpoint
  // come first, keeping the original relative order within each group. We
  // don't filter — onboarding users may still want to add chat-only providers
  // here as a one-stop convenience; the trailing tag explains why those are
  // de-prioritized.
  const unconfiguredBuiltins: BuiltinId[] = BUILTIN_PROVIDER_IDS.filter(
    (id: BuiltinId) => !configuredIds.has(id),
  );
  if (isEmbedding) {
    unconfiguredBuiltins.sort((a, b) => {
      const sa = builtinMeta(a).embeddingSupported ? 0 : 1;
      const sb = builtinMeta(b).embeddingSupported ? 0 : 1;
      return sa - sb;
    });
  }

  function removeProvider(id: string): void {
    void patch(buildRemoveProviderPatch(id, state));
  }

  return (
    <>
      <SettingsCard heading={tg('configured_providers_label')} padded>
        {configured.length > 0 ? (
          <div className="gp-llm-provider-list">
            {configured.map(([id, cfg]) => {
              const isBuiltin = BUILTIN_ID_SET.has(id);
              return (
                <div className="gp-llm-provider-block" key={id}>
                  <div className="gp-llm-provider-block__head">
                    <span className="gp-llm-provider-block__name">{providerLabel(id, t)}</span>
                    <Tag kind={isBuiltin ? 'live' : 'default'}>
                      {isBuiltin ? tg('builtin_tag_label') : tSettings('source_custom')}
                    </Tag>
                    <span className="gp-llm-provider-block__meta">
                      {/* Custom providers always have a baseUrl (required by the
                        modal); show it. Builtin providers may have a baseUrl
                        override (e.g. user-pointed Ollama) or just the apiKey
                        mask if no override. */}
                      {cfg.baseUrl ?? (cfg.apiKey ? '••••' : '')}
                    </span>
                    <div className="gp-llm-provider-block__actions">
                      <Btn
                        sm
                        kind="ghost"
                        onClick={() =>
                          setProviderModal(
                            isBuiltin
                              ? { kind: 'builtin', providerId: id as BuiltinId, mode: 'edit' }
                              : { kind: 'custom', providerId: id, mode: 'edit' },
                          )
                        }
                        aria-label={tg('edit_provider_btn_label')}
                      >
                        {tg('edit_provider_btn_label')}
                      </Btn>
                      <Btn
                        sm
                        kind="ghost"
                        onClick={() => removeProvider(id)}
                        aria-label={tg('remove_provider_chip')}
                      >
                        {tg('remove_provider_chip')}
                      </Btn>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="gp-llm-provider-list">
            <p className="gp-llm-empty">{tg('no_configured_providers')}</p>
          </div>
        )}
      </SettingsCard>

      <SettingsCard heading={tg('add_provider_card_heading')} sub={tg('add_provider_card_desc')}>
        <div className="gp-add-provider-actions">
          {unconfiguredBuiltins.map((id) => {
            const showUnsupportedTag = isEmbedding && !builtinMeta(id).embeddingSupported;
            return (
              <Btn
                key={id}
                kind="primary"
                onClick={() => setProviderModal({ kind: 'builtin', providerId: id, mode: 'add' })}
              >
                {tg('add_provider_label', { provider: providerLabel(id, t) })}
                {showUnsupportedTag ? (
                  <Tag kind="readonly">{t('embedding_unsupported_tag')}</Tag>
                ) : null}
              </Btn>
            );
          })}
          <Btn kind="ghost" onClick={() => setProviderModal({ kind: 'custom', mode: 'add' })}>
            {tSettings('add_btn_openai_compat')}
          </Btn>
        </div>
      </SettingsCard>

      {providerModal?.kind === 'builtin' ? (
        <AddBuiltinProviderModal
          providerId={providerModal.providerId}
          label={providerLabel(providerModal.providerId, t)}
          modelsPlaceholder={PLACEHOLDER_MODELS_DISPLAY[providerModal.providerId]}
          mode={providerModal.mode}
          context={context}
          existing={
            providerModal.mode === 'edit' ? state.providers[providerModal.providerId] : undefined
          }
          onClose={() => setProviderModal(null)}
        />
      ) : null}
      {providerModal?.kind === 'custom' ? (
        <AddCustomProviderModal
          mode={providerModal.mode}
          providerId={providerModal.providerId}
          existing={
            providerModal.mode === 'edit' && providerModal.providerId
              ? state.providers[providerModal.providerId]
              : undefined
          }
          onClose={() => setProviderModal(null)}
        />
      ) : null}
    </>
  );
}
