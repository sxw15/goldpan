'use client';

import type {
  DigestPreset,
  ImSettingsManifest,
  ManagedEnvKey,
  PluginSettingsContributionDescriptor,
} from '@goldpan/web-sdk';
import { GripVertical, MoreHorizontal, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import type { ToastInput } from '@/components/toast-stack';
import { Btn } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsField } from '@/components/ui/settings-field';
import { SettingsHead } from '@/components/ui/settings-head';
import { Tag } from '@/components/ui/tag';
import { Toggle } from '@/components/ui/toggle';
import { rethrowNextErrors } from '@/lib/rethrow';
import { createPreset, deletePreset, updatePreset } from '../actions';
import { LLM_STEPS } from '../llm-steps';
import { PluginFieldRow } from '../plugin-contribution-card';
import { INITIAL_TELEGRAM_PRESETS, SLOT_KEYS, type SlotKey } from '../settings-data';
import type { GroupProps } from '../settings-shell';
import { useFieldTagLabels } from '../use-field-tag-labels';

/**
 * Mirror of `PROVIDER_KEY_ENV` in `packages/core/src/onboarding/provider-keys.ts`.
 * Used purely for the pre-flight "do we have an API key for digest_summary /
 * digest_action's provider?" check so the user is blocked at the toggle instead
 * of seeing a confusing "Missing API key(s) for referenced provider(s)" error
 * after committing. The authoritative validation still runs server-side; this
 * is a UX hint, not a security boundary. Keep in sync when core adds builtin
 * provider/key mappings.
 */
const PROVIDER_KEY_ENV: Readonly<Record<string, ManagedEnvKey>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};
const KEYLESS_PROVIDERS = new Set(['ollama']);
const DIGEST_LLM_STEP_IDS = ['digest_summary', 'digest_action'] as const;

function providerOf(modelId: string | undefined | null): string | null {
  if (!modelId) return null;
  const i = modelId.indexOf(':');
  return i > 0 ? modelId.slice(0, i) : null;
}

type DigestProps = GroupProps & {
  contributions?: PluginSettingsContributionDescriptor[];
  digestEnabled: boolean;
  presets: DigestPreset[];
  setPresets: (updater: DigestPreset[] | ((prev: DigestPreset[]) => DigestPreset[])) => void;
  manifests: ImSettingsManifest[];
  language: 'en' | 'zh';
};

interface DraftPreset {
  id?: number;
  name: string;
  period: 'daily' | 'weekly';
  pushDay: number | null;
  pushTime: string;
  windowMode: 'calendar' | 'rolling';
  slots: SlotKey[];
  skipEmpty: boolean;
  includeAiSummary: boolean;
  isDefault: boolean;
}

// 切 daily ↔ weekly 时给一个直觉上"自然"的默认时间(daily 早 8 / weekly 早 9),
// 而不是把上一个 period 的时间硬留下来 —— 用户感受会是"我刚改了 period 它就忘了
// 我上一次的设置";让 default 显式按 period 给值,保持和 DEFAULT_PRESETS 一致。
function defaultPushTimeFor(period: 'daily' | 'weekly'): string {
  return period === 'weekly' ? '09:00' : '08:00';
}

function presetToDraft(p: DigestPreset): DraftPreset {
  return {
    id: p.id,
    name: p.name,
    period: p.period,
    pushDay: p.pushDay,
    pushTime: p.pushTime,
    windowMode: p.windowMode,
    slots: p.slots as SlotKey[],
    skipEmpty: p.skipEmpty,
    includeAiSummary: p.includeAiSummary,
    isDefault: p.isDefault,
  };
}

function emptyDraft(): DraftPreset {
  return {
    name: '',
    period: 'daily',
    pushDay: null,
    pushTime: defaultPushTimeFor('daily'),
    windowMode: 'calendar',
    slots: ['stats'],
    skipEmpty: true,
    includeAiSummary: true,
    isDefault: false,
  };
}

// ISO 周序号 → i18n key。提到 module top-level 供 GroupDigest 和 PresetDrawer 共享。
const WEEKDAY_KEYS = [
  'weekday_mon',
  'weekday_tue',
  'weekday_wed',
  'weekday_thu',
  'weekday_fri',
  'weekday_sat',
  'weekday_sun',
] as const;

export function GroupDigest(props: DigestProps) {
  const {
    env,
    commit,
    resetEnvKey,
    contributions,
    digestEnabled,
    presets,
    setPresets,
    toast,
    navigateToGroup,
    manifests,
    language,
  } = props;
  const t = useTranslations('settings.digest');
  // `contributions` is undefined when not threaded through (older tests).
  // The two extra digest fields stay hidden in that case — they're a
  // contribution-driven addition, not a hard requirement of the group.
  const digestContribution = contributions?.find((c) => c.pluginId === 'digest');
  const tA11y = useTranslations('settings.a11y');
  const tActions = useTranslations('settings.actions');
  const fieldTagLabels = useFieldTagLabels();
  const [channel, setChannel] = useState<string>('web');

  // IM channel 启用状态判断 —— 与 notify 页面 fallback chain 完全一致,确保两处同步:
  // 用户在通知里开关 channel 后,日报这里的 tab 立即反映 mute / 正常态。详见
  // groups/notify.tsx `legacyConfiguredDefault` + `enabledRaw`。
  // useCallback 包装是为了让下面 useEffect 的 deps 引用稳定 fn,避免 env/dirty 列在
  // useEffect deps 上同时被 biome useExhaustiveDependencies 当成多余依赖。
  const imChannelEnabled = useCallback(
    (manifest: ImSettingsManifest): boolean => {
      const enableEntry = env.get(manifest.enable.envKey);
      let fallback = manifest.enable.default;
      if (!enableEntry?.configured) {
        const requiredFields = manifest.fields.filter((f) => f.required);
        if (requiredFields.length > 0) {
          fallback = requiredFields.every((f) => env.get(f.envKey)?.configured === true);
        }
      }
      const enabledRaw = (enableEntry?.mask || undefined) ?? String(fallback);
      return enabledRaw === 'true';
    },
    [env],
  );
  const activeManifest = manifests.find((m) => m.channelId === channel);
  const webChannelActive = channel === 'web';
  // 用户切到 non-web channel 后,如果在 notify 关掉 / dirty 改回 disabled,自动回 Web。
  // 没有这一步,channel 会卡在已选 channel id 上但 tab 已变 mute,显示空白预设区。
  useEffect(() => {
    if (channel === 'web') return;
    if (!activeManifest || !imChannelEnabled(activeManifest)) setChannel('web');
  }, [channel, activeManifest, imChannelEnabled]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<DigestPreset | null>(null);
  const [resettingDigest, setResettingDigest] = useState(false);
  useEffect(() => {
    if (webChannelActive) return;
    setEditingId(null);
    setCreating(false);
  }, [webChannelActive]);
  const digestEnabledLive = (env.get('GOLDPAN_DIGEST_ENABLED')?.mask ?? 'false') === 'true';
  const digestEnabledState = env.get('GOLDPAN_DIGEST_ENABLED');
  const onResetDigestEnabled =
    digestEnabledState?.source === 'override'
      ? async () => {
          setResettingDigest(true);
          try {
            await resetEnvKey('GOLDPAN_DIGEST_ENABLED');
          } finally {
            setResettingDigest(false);
          }
        }
      : undefined;

  const SLOT_LABELS: Record<SlotKey, string> = {
    tracking_findings: t('slot_tracking_findings'),
    captures: t('slot_captures'),
    thoughts: t('slot_thoughts'),
    new_entities: t('slot_new_entities'),
    stats: t('slot_stats'),
    ai_summary: t('slot_ai_summary'),
  };

  const PERIOD_LABELS: Record<'daily' | 'weekly', string> = {
    daily: t('period_daily'),
    weekly: t('period_weekly'),
  };

  function formatPushTime(p: DigestPreset): string {
    if (p.period === 'daily') return p.pushTime;
    const day = p.pushDay ?? 1;
    const dayLabel = t(WEEKDAY_KEYS[day - 1]);
    return `${t('weekday_prefix')}${dayLabel} ${p.pushTime}`;
  }

  // Pre-flight: digest 启用会让 backend 校验 digest_summary / digest_action 引用
  // 的 provider 是否配置了 API key。前端先解一遍,缺 key 时禁用 Toggle + 指引用户
  // 去 LLM 配置页改这两个 step 的 model 或补对应 provider 的 key,避免"切了 toggle
  // → 提交 → 看到 `Missing API key(s) for referenced provider(s)` 才一脸懵"的反直觉
  // 路径。Backend `missingKeyedProviders` 是最终防线;此处任何分歧(unknown provider
  // / custom provider)都 fail-open,让后端拒绝兜底。
  // 阻塞条件不能跟 toggle 的 live 状态挂钩:`&& !digestEnabledLive` 会让 toggle
  // 一旦被 patched 成 'true'(例如 fix 落地前用户就切过 + Next.js Fast Refresh
  // 保留了 store dirty),disabled 立刻翻成 false,用户照样能 save 出错。只看
  // "缺不缺 key" 这个事实。step → provider → key 的具体绑定故意不暴露给用户:
  // 用户可以改 step 的 model 也可以补 key,把临时绑定 painted 在 UI 上会让人
  // 以为"只能补这个 env",反而误导。引导用户去 LLM 设置自己看就好。
  const digestEnableBlocked = DIGEST_LLM_STEP_IDS.some((stepId) => {
    const stepDef = LLM_STEPS.find((s) => s.id === stepId);
    if (!stepDef) return false;
    // env mask 在 source='default' 时是空字符串("没显式 set 过") —— 必须用 `||`,
    // 否则 `??` 把 '' 当作有效值,model 解析为空 → provider null → 误判为不缺 key。
    const model = env.get(stepDef.envKey)?.mask || stepDef.defaultProviderModel;
    const provider = providerOf(model);
    if (!provider || KEYLESS_PROVIDERS.has(provider)) return false;
    const apiKeyEnvKey = PROVIDER_KEY_ENV[provider];
    if (!apiKeyEnvKey) return false; // unknown / custom provider — let backend decide
    return !(env.get(apiKeyEnvKey)?.configured ?? false);
  });
  // Auto-commit removed the legacy "dirty stuck on 'true' across Fast Refresh"
  // window the old useEffect guarded against — every toggle commit lands on
  // the server immediately, so dirty never carries a stale value forward.
  // Pre-flight blocking still hides the toggle's on-action below (see the
  // `disabled={digestEnableBlocked}` prop), so a blocked user cannot fire
  // commit in the first place.

  if (!digestEnabled) {
    return (
      <>
        <SettingsHead crumb={t('crumb')} heading={t('heading')} desc={t('desc')} />
        <SettingsCard heading={t('card_enable_heading')}>
          <SettingsField
            tagLabels={fieldTagLabels}
            label={t('field_digest_enabled_label')}
            restart="restart"
            source={digestEnabledState?.source}
            baselineDiffers={digestEnabledState?.baselineDiffers}
            onReset={onResetDigestEnabled}
            resetting={resettingDigest}
            resetLabel={tActions('reset')}
            resetInProgressLabel={tActions('reset_in_progress')}
            resetTitle={tActions('reset_hint')}
            hint={t('field_digest_enabled_hint')}
            value={digestEnabledLive ? t('on_label') : t('off_label')}
            control={
              <Toggle
                on={digestEnabledLive}
                // Only block while OFF — a user with missing API keys who's
                // already ON must still be able to turn Digest off, otherwise
                // they're locked into an unworkable state until they go fix
                // the upstream provider. Pre-fix `disabled={digestEnableBlocked}`
                // blocked BOTH directions. The earlier worry about
                // `&& !digestEnabledLive` re-enabling the toggle and letting
                // the user save-and-fail is moot — `useToggleCommit.fire`
                // rolls `current` back on commit error, so a brief optimistic
                // ON state self-heals.
                disabled={digestEnableBlocked && !digestEnabledLive}
                onChange={(v) => {
                  commit({ GOLDPAN_DIGEST_ENABLED: v ? 'true' : 'false' }).catch(rethrowNextErrors);
                }}
              />
            }
          />
          {digestEnableBlocked ? (
            <DigestPrereqNotice onNavigate={() => navigateToGroup('llm', { llmTab: 'pipeline' })} />
          ) : null}
        </SettingsCard>
      </>
    );
  }

  const editing = editingId != null ? (presets.find((p) => p.id === editingId) ?? null) : null;

  return (
    <>
      <SettingsHead crumb={t('crumb')} heading={t('heading')} desc={t('desc')} />
      <SettingsCard heading={t('card_enable_heading')}>
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_digest_enabled_label')}
          restart="restart"
          source={digestEnabledState?.source}
          baselineDiffers={digestEnabledState?.baselineDiffers}
          onReset={onResetDigestEnabled}
          resetting={resettingDigest}
          resetLabel={tActions('reset')}
          resetInProgressLabel={tActions('reset_in_progress')}
          resetTitle={tActions('reset_hint')}
          shadowed={
            digestEnabledState?.source === 'override' &&
            digestEnabledState?.baselineDiffers === true
          }
          hint={t('field_digest_enabled_hint')}
          value={digestEnabledLive ? t('on_label') : t('off_label')}
          control={
            <Toggle
              on={digestEnabledLive}
              disabled={digestEnableBlocked && !digestEnabledLive}
              onChange={(v) => {
                commit({ GOLDPAN_DIGEST_ENABLED: v ? 'true' : 'false' }).catch(rethrowNextErrors);
              }}
            />
          }
        />
        {digestContribution?.fields.map((field) => (
          <PluginFieldRow
            key={field.name}
            field={field}
            group={props}
            secretI18nNamespace="settings.collect"
          />
        ))}
      </SettingsCard>
      <div className="gp-scard gp-scard--digest">
        <div className="gp-channel-tabs">
          <button
            type="button"
            className="gp-channel-tab"
            aria-pressed={channel === 'web'}
            onClick={() => setChannel('web')}
          >
            Web <span className="gp-channel-tab__count">{presets.length}</span>
          </button>
          {manifests.map((m) => {
            const name = m.branding.name[language];
            if (!imChannelEnabled(m)) {
              return (
                <button
                  type="button"
                  key={m.channelId}
                  className="gp-channel-tab gp-channel-tab--mute"
                  onClick={() =>
                    toast({
                      msg: t('channel_unconfigured_toast', { channelName: name }),
                    })
                  }
                >
                  {name} <Tag kind="readonly">{t('tab_unconfigured_tag')}</Tag>
                </button>
              );
            }
            return (
              <button
                type="button"
                key={m.channelId}
                className="gp-channel-tab"
                aria-pressed={channel === m.channelId}
                onClick={() => setChannel(m.channelId)}
              >
                {name}{' '}
                <span className="gp-channel-tab__count">{INITIAL_TELEGRAM_PRESETS.length}</span>
              </button>
            );
          })}
        </div>
        <div className="gp-scard__head gp-scard__head--no-border">
          <div>
            <h3 className="gp-scard__title">
              {channel === 'web'
                ? t('channel_web_title')
                : t('channel_im_title', {
                    channelName: activeManifest?.branding.name[language] ?? channel,
                  })}
            </h3>
            <p className="gp-scard__sub">
              {channel === 'web' ? t('channel_web_sub') : t('channel_im_sub')}
            </p>
          </div>
          <Btn
            kind="primary"
            sm
            disabled={!webChannelActive}
            onClick={() => {
              setCreating(true);
              setEditingId(null);
            }}
          >
            <Plus size={12} />
            <span>{t('new_preset_button')}</span>
          </Btn>
        </div>
        <div className="gp-preset-grid">
          {channel === 'web' &&
            presets.map((p) => (
              <PresetCard
                key={p.id}
                preset={p}
                slotLabels={SLOT_LABELS}
                periodLabels={PERIOD_LABELS}
                formatPushTime={formatPushTime}
                active={editingId === p.id}
                onEdit={() => {
                  setEditingId(p.id);
                  setCreating(false);
                }}
                onSetDefault={() => {
                  void updatePreset(p.id, { isDefault: !p.isDefault })
                    .then(({ preset: next }) => {
                      setPresets((prev) =>
                        prev.map((x) =>
                          x.id === next.id ? next : next.isDefault ? { ...x, isDefault: false } : x,
                        ),
                      );
                      toast({
                        msg: next.isDefault
                          ? t('set_default_toast', { name: p.name })
                          : t('unset_default_toast'),
                        kind: 'success',
                      });
                    })
                    .catch((err: unknown) => {
                      toast({
                        msg: err instanceof Error ? err.message : t('update_failed_toast'),
                        kind: 'danger',
                      });
                    });
                }}
                onDuplicate={() => {
                  void createPreset(p.channel, {
                    name: `${p.name}_copy`,
                    period: p.period,
                    pushDay: p.pushDay,
                    pushTime: p.pushTime,
                    windowMode: p.windowMode,
                    slots: p.slots,
                    skipEmpty: p.skipEmpty,
                    includeAiSummary: p.includeAiSummary,
                    isDefault: false,
                  })
                    .then(({ preset }) => {
                      setPresets((prev) => [...prev, preset]);
                      toast({
                        msg: t('clone_done_toast', { name: preset.name }),
                        kind: 'success',
                      });
                    })
                    .catch((err: unknown) => {
                      toast({
                        msg: err instanceof Error ? err.message : t('clone_failed_toast'),
                        kind: 'danger',
                      });
                    });
                }}
                onDelete={() => setConfirmDelete(p)}
              />
            ))}
          {channel !== 'web' && activeManifest && (
            <ChannelPresetsMock
              channelName={activeManifest.branding.name[language]}
              toast={toast}
              slotLabels={SLOT_LABELS}
              periodLabels={PERIOD_LABELS}
              formatPushTime={formatPushTime}
            />
          )}
          <button
            type="button"
            className="gp-preset-card gp-preset-card--new"
            disabled={!webChannelActive}
            onClick={() => {
              setCreating(true);
              setEditingId(null);
            }}
          >
            <div className="gp-preset-card--new__plus">＋</div>
            <div className="gp-preset-card--new__title">{t('new_preset_card_title')}</div>
            <div className="gp-preset-card--new__sub">{t('new_preset_card_sub')}</div>
          </button>
        </div>
        {(editing || creating) && channel === 'web' ? (
          <PresetEditDrawer
            preset={editing}
            slotLabels={SLOT_LABELS}
            onClose={() => {
              setEditingId(null);
              setCreating(false);
            }}
            onSaved={(next, isCreate) => {
              setPresets((prev) => {
                const cleared = next.isDefault
                  ? prev.map((x) => ({ ...x, isDefault: x.id === next.id }))
                  : prev;
                const idx = cleared.findIndex((x) => x.id === next.id);
                return idx === -1
                  ? [...cleared, next]
                  : cleared.map((x) => (x.id === next.id ? next : x));
              });
              setEditingId(null);
              setCreating(false);
              toast({
                msg: isCreate ? t('create_done_toast') : t('save_done_toast'),
                kind: 'success',
              });
            }}
            onDelete={() => editing && setConfirmDelete(editing)}
            toast={toast}
          />
        ) : null}
      </div>
      <SettingsCard heading={t('log_card_heading')}>
        <SettingsField
          tagLabels={fieldTagLabels}
          todo
          label={t('log_today_web_label')}
          hint={t('log_today_web_hint')}
          value={t('log_today_web_value')}
          valueInk
          control={
            <Btn sm disabled>
              {t('log_view_button')}
            </Btn>
          }
        />
        <SettingsField
          tagLabels={fieldTagLabels}
          todo
          label={t('log_today_telegram_label')}
          hint={t('log_today_telegram_hint')}
          value={t('log_today_telegram_value')}
          valueInk
          control={
            <Btn sm disabled>
              {t('log_view_button')}
            </Btn>
          }
        />
        <SettingsField
          tagLabels={fieldTagLabels}
          todo
          label={t('log_yesterday_label')}
          hint={t('log_yesterday_hint')}
          value={t('log_yesterday_value')}
        />
      </SettingsCard>
      {confirmDelete ? (
        <Modal
          heading={t('modal_delete_heading', { name: confirmDelete.name })}
          desc={t('modal_delete_desc')}
          danger
          closeLabel={tA11y('modal_close')}
          confirmLabel={t('modal_delete_confirm')}
          cancelLabel={tA11y('modal_cancel')}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            const target = confirmDelete;
            setConfirmDelete(null);
            void deletePreset(target.id)
              .then((res) => {
                if ('error' in res) {
                  toast({
                    msg: t('delete_in_use_toast', { count: res.error.usages.length }),
                    kind: 'danger',
                  });
                  return;
                }
                setPresets((prev) => prev.filter((p) => p.id !== target.id));
                setEditingId((id) => (id === target.id ? null : id));
                toast({ msg: t('delete_done_toast'), kind: 'success' });
              })
              .catch((err: unknown) => {
                toast({
                  msg: err instanceof Error ? err.message : t('delete_failed_toast'),
                  kind: 'danger',
                });
              });
          }}
        />
      ) : null}
    </>
  );
}

function DigestPrereqNotice({ onNavigate }: { onNavigate: () => void }) {
  const t = useTranslations('settings.digest');
  const tSteps = useTranslations('settings.llm.steps');
  return (
    <Notice
      kind="warn"
      icon="⚠"
      heading={t('prereq_missing_heading')}
      className="gp-notice--card-footer"
      trailing={
        <Btn sm kind="primary" onClick={onNavigate}>
          {t('prereq_missing_cta')}
        </Btn>
      }
    >
      <p className="gp-prereq-steps__body">{t('prereq_missing_body')}</p>
      <ul className="gp-prereq-steps__list">
        {DIGEST_LLM_STEP_IDS.map((id) => (
          <li key={id}>{tSteps(`${id}.label`)}</li>
        ))}
      </ul>
    </Notice>
  );
}

function PresetCard({
  preset,
  slotLabels,
  periodLabels,
  formatPushTime,
  onEdit,
  onSetDefault,
  onDuplicate,
  onDelete,
  active,
}: {
  preset: DigestPreset;
  slotLabels: Record<SlotKey, string>;
  periodLabels: Record<'daily' | 'weekly', string>;
  formatPushTime: (p: DigestPreset) => string;
  onEdit: () => void;
  onSetDefault: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  active?: boolean;
}) {
  const tA11y = useTranslations('settings.a11y');
  const t = useTranslations('settings.digest');
  const [menuOpen, setMenuOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [previewBox, setPreviewBox] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const cardRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    if (!hover || menuOpen) return;
    const reposition = () => {
      const el = cardRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 12;
      const w = Math.min(360, Math.max(280, r.width));
      let left = r.left;
      if (left + w > vw - margin) left = vw - margin - w;
      if (left < margin) left = margin;
      let top = r.bottom + 6;
      const h = previewRef.current?.offsetHeight ?? 0;
      if (h > 0 && top + h > vh - margin && r.top - h - 6 > margin) {
        top = r.top - h - 6;
      }
      setPreviewBox({ top, left, width: w });
    };
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [hover, menuOpen]);

  const showPreview = mounted && hover && !menuOpen && previewBox !== null;

  return (
    <div className="gp-preset-card-wrap">
      <button
        ref={cardRef}
        type="button"
        className={[
          'gp-preset-card',
          preset.isDefault ? 'gp-preset-card--default' : '',
          active ? 'gp-preset-card--active' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={onEdit}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
      >
        <div className="gp-preset-card__head">
          <div className="gp-preset-card__name">{preset.name}</div>
          <div className="gp-preset-card__period">
            {periodLabels[preset.period]} · {formatPushTime(preset)}
            {preset.isDefault ? <Tag kind="default">{t('preset_default_tag')}</Tag> : null}
          </div>
        </div>
        <div className="gp-preset-card__chips">
          {SLOT_KEYS.map((s) => (
            <span
              key={s}
              className={`gp-preset-card__chip ${preset.slots.includes(s) ? 'gp-preset-card__chip--active' : 'gp-preset-card__chip--off'}`}
            >
              {slotLabels[s]}
            </span>
          ))}
        </div>
        <div className="gp-preset-card__foot">
          <span>{preset.isDefault ? t('preset_chip_main') : t('preset_chip_secondary')}</span>
          <span>{t('preset_modules_count', { count: preset.slots.length })}</span>
        </div>
      </button>
      <div className="gp-preset-card__menu-wrap">
        <button
          type="button"
          className="gp-btn"
          data-variant="ghost"
          data-size="sm"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <MoreHorizontal size={12} />
        </button>
        {menuOpen ? (
          <>
            <button
              type="button"
              className="gp-preset-card__menu-shield"
              onClick={() => setMenuOpen(false)}
              aria-label={tA11y('menu_close')}
            />
            <div className="gp-preset-card__menu">
              <button
                type="button"
                className="gp-preset-card__menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onSetDefault();
                }}
              >
                {preset.isDefault ? t('menu_unset_default') : t('menu_set_default')}
              </button>
              <button
                type="button"
                className="gp-preset-card__menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onDuplicate();
                }}
              >
                {t('menu_clone')}
              </button>
              <button
                type="button"
                className="gp-preset-card__menu-item gp-preset-card__menu-item--danger"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
              >
                {t('menu_delete')}
              </button>
            </div>
          </>
        ) : null}
      </div>
      {showPreview
        ? createPortal(
            <div
              ref={previewRef}
              className="gp-preset-card__preview"
              role="presentation"
              style={{
                top: previewBox.top,
                left: previewBox.left,
                width: previewBox.width,
              }}
            >
              <PresetPreviewBox
                name={preset.name}
                slots={preset.slots as SlotKey[]}
                slotLabels={slotLabels}
                skipEmpty={preset.skipEmpty}
                includeAiSummary={preset.includeAiSummary}
                className="gp-preset-preview--floating"
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function ChannelPresetsMock({
  channelName,
  toast,
  slotLabels,
  periodLabels,
  formatPushTime,
}: {
  channelName: string;
  toast: (t: ToastInput) => void;
  slotLabels: Record<SlotKey, string>;
  periodLabels: Record<'daily' | 'weekly', string>;
  formatPushTime: (p: DigestPreset) => string;
}) {
  const t = useTranslations('settings.digest');
  const tShell = useTranslations('settings.shell');
  return (
    <>
      <Notice kind="info" icon="ⓘ">
        {tShell('unimplemented')}
      </Notice>
      {INITIAL_TELEGRAM_PRESETS.map((p) => (
        <PresetCard
          key={p.id}
          preset={p}
          slotLabels={slotLabels}
          periodLabels={periodLabels}
          formatPushTime={formatPushTime}
          onEdit={() => toast({ msg: t('im_preset_edit_toast', { channelName }) })}
          onSetDefault={() => undefined}
          onDuplicate={() => undefined}
          onDelete={() => undefined}
        />
      ))}
    </>
  );
}

function PresetEditDrawer({
  preset,
  slotLabels,
  onClose,
  onSaved,
  onDelete,
  toast,
}: {
  preset: DigestPreset | null;
  slotLabels: Record<SlotKey, string>;
  onClose: () => void;
  onSaved: (next: DigestPreset, isCreate: boolean) => void;
  onDelete: () => void;
  toast: (t: ToastInput) => void;
}) {
  const tA11y = useTranslations('settings.a11y');
  const t = useTranslations('settings.digest');
  const isNew = !preset;
  const [draft, setDraft] = useState<DraftPreset>(preset ? presetToDraft(preset) : emptyDraft());
  const [pending, startTransition] = useTransition();
  const [dragKey, setDragKey] = useState<SlotKey | null>(null);
  const [overKey, setOverKey] = useState<SlotKey | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleSlot = (k: SlotKey) =>
    setDraft((d) => ({
      ...d,
      slots: d.slots.includes(k) ? d.slots.filter((s) => s !== k) : [...d.slots, k],
    }));

  const reorderSlot = (from: SlotKey, to: SlotKey) =>
    setDraft((d) => {
      if (from === to) return d;
      const fromIdx = d.slots.indexOf(from);
      const toIdx = d.slots.indexOf(to);
      if (fromIdx < 0 || toIdx < 0) return d;
      const next = [...d.slots];
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, from);
      return { ...d, slots: next };
    });

  const onSave = () => {
    if (!draft.name.trim()) {
      toast({ msg: t('drawer_name_required_toast'), kind: 'danger' });
      return;
    }
    startTransition(async () => {
      try {
        if (isNew) {
          const { preset: created } = await createPreset('web', {
            name: draft.name,
            period: draft.period,
            pushDay: draft.period === 'weekly' ? (draft.pushDay ?? 1) : null,
            pushTime: draft.pushTime,
            windowMode: draft.windowMode,
            slots: draft.slots,
            skipEmpty: draft.skipEmpty,
            includeAiSummary: draft.includeAiSummary,
            isDefault: draft.isDefault,
          });
          onSaved(created, true);
        } else if (preset) {
          const { preset: updated } = await updatePreset(preset.id, {
            name: draft.name,
            period: draft.period,
            pushDay: draft.period === 'weekly' ? (draft.pushDay ?? 1) : null,
            pushTime: draft.pushTime,
            windowMode: draft.windowMode,
            slots: draft.slots,
            skipEmpty: draft.skipEmpty,
            includeAiSummary: draft.includeAiSummary,
            isDefault: draft.isDefault,
          });
          onSaved(updated, false);
        }
      } catch (err) {
        toast({
          msg: err instanceof Error ? err.message : t('drawer_save_failed_toast'),
          kind: 'danger',
        });
      }
    });
  };

  return (
    <>
      <button
        type="button"
        className="gp-drawer-backdrop"
        onClick={onClose}
        aria-label={tA11y('drawer_close')}
      />
      <div className="gp-drawer">
        <div className="gp-drawer__head">
          <div>
            <h3 className="gp-drawer__title">{isNew ? t('drawer_new') : t('drawer_edit')}</h3>
            <p className="gp-drawer__meta">
              {t('drawer_meta_channel')}{' '}
              {!isNew && preset ? `· ${t('drawer_meta_id', { id: preset.id })}` : null}
            </p>
          </div>
          <button
            type="button"
            className="gp-btn"
            data-variant="ghost"
            data-size="sm"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="gp-drawer__body">
          <div className="gp-form-row">
            <label className="gp-form-row__label" htmlFor="preset-name">
              {t('drawer_form_name')}
            </label>
            <input
              id="preset-name"
              className="gp-sinput gp-sinput--full gp-sinput--mono"
              value={draft.name}
              placeholder={tA11y('preset_name_placeholder')}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </div>
          <div className="gp-form-grid-2">
            <div className="gp-form-row">
              <label className="gp-form-row__label" htmlFor="preset-period">
                {t('drawer_form_period')}
              </label>
              <select
                id="preset-period"
                className="gp-sselect"
                value={draft.period}
                onChange={(e) => {
                  const period = e.target.value as 'daily' | 'weekly';
                  setDraft((d) => ({
                    ...d,
                    period,
                    pushDay: period === 'weekly' ? (d.pushDay ?? 1) : null,
                    // 切 period 时如果用户没动过 time(还是上一个 period 的默认),
                    // 自动跟到新 period 的默认。已经显式改过就保留。
                    pushTime:
                      d.pushTime === defaultPushTimeFor(d.period)
                        ? defaultPushTimeFor(period)
                        : d.pushTime,
                  }));
                }}
              >
                <option value="daily">{t('period_daily')}</option>
                <option value="weekly">{t('period_weekly')}</option>
              </select>
              <span className="gp-form-row__hint">
                {t(
                  `drawer_form_period_hint_${draft.windowMode}_${draft.period}` as
                    | 'drawer_form_period_hint_calendar_daily'
                    | 'drawer_form_period_hint_calendar_weekly'
                    | 'drawer_form_period_hint_rolling_daily'
                    | 'drawer_form_period_hint_rolling_weekly',
                )}
              </span>
            </div>
            <div className="gp-form-row">
              <label className="gp-form-row__label" htmlFor="preset-push-time">
                {t('drawer_form_push_time')}
              </label>
              <input
                id="preset-push-time"
                type="time"
                className="gp-sinput gp-sinput--full gp-sinput--mono"
                value={draft.pushTime}
                onChange={(e) => setDraft((d) => ({ ...d, pushTime: e.target.value }))}
              />
              <span className="gp-form-row__hint">{t('drawer_form_push_time_hint')}</span>
            </div>
          </div>
          <div className="gp-form-grid-2">
            <div className="gp-form-row">
              <label className="gp-form-row__label" htmlFor="preset-window-mode">
                {t('drawer_form_window_mode')}
              </label>
              <select
                id="preset-window-mode"
                className="gp-sselect"
                value={draft.windowMode}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    windowMode: e.target.value as 'calendar' | 'rolling',
                  }))
                }
              >
                <option value="calendar">{t('drawer_form_window_mode_calendar')}</option>
                <option value="rolling">{t('drawer_form_window_mode_rolling')}</option>
              </select>
              <span className="gp-form-row__hint">{t('drawer_form_window_mode_hint')}</span>
            </div>
            {draft.period === 'weekly' && (
              <div className="gp-form-row">
                <label className="gp-form-row__label" htmlFor="preset-push-day">
                  {t('drawer_form_push_weekly')}
                </label>
                <select
                  id="preset-push-day"
                  className="gp-sselect"
                  value={draft.pushDay ?? 1}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, pushDay: Number(e.target.value) || 1 }))
                  }
                >
                  {WEEKDAY_KEYS.map((k, idx) => (
                    <option key={k} value={idx + 1}>
                      {t(k)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="gp-form-row">
            <span className="gp-form-row__label">{t('drawer_form_modules')}</span>
            <span className="gp-form-row__hint">{t('drawer_form_modules_hint')}</span>
            <div className="gp-slots">
              {draft.slots.map((s, idx) => (
                <button
                  type="button"
                  key={s}
                  className="gp-slot-chip"
                  data-on="1"
                  data-dragging={dragKey === s ? '1' : undefined}
                  data-drop-target={overKey === s && dragKey && dragKey !== s ? '1' : undefined}
                  draggable
                  onClick={() => toggleSlot(s)}
                  onDragStart={(e) => {
                    setDragKey(s);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', s);
                  }}
                  onDragOver={(e) => {
                    if (!dragKey || dragKey === s) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (overKey !== s) setOverKey(s);
                  }}
                  onDragLeave={() => {
                    setOverKey((k) => (k === s ? null : k));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragKey && dragKey !== s) reorderSlot(dragKey, s);
                    setDragKey(null);
                    setOverKey(null);
                  }}
                  onDragEnd={() => {
                    setDragKey(null);
                    setOverKey(null);
                  }}
                >
                  <span className="gp-slot-chip__handle" aria-hidden="true">
                    <GripVertical size={12} />
                  </span>
                  <span className="gp-slot-chip__label">{slotLabels[s]}</span>
                  <span className="gp-slot-chip__order">{idx + 1}</span>
                </button>
              ))}
              {SLOT_KEYS.filter((s) => !draft.slots.includes(s)).map((s) => (
                <button
                  type="button"
                  key={s}
                  className="gp-slot-chip"
                  data-on="0"
                  onClick={() => toggleSlot(s)}
                >
                  <span className="gp-slot-chip__handle" aria-hidden="true">
                    <GripVertical size={12} />
                  </span>
                  <span className="gp-slot-chip__label">{slotLabels[s]}</span>
                  <span className="gp-slot-chip__add" aria-hidden="true">
                    <Plus size={12} />
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="gp-form-row">
            <span className="gp-form-row__label">{t('drawer_form_behavior')}</span>
            <div className="gp-behavior-list">
              <ToggleRow
                on={draft.skipEmpty}
                onChange={(v) => setDraft((d) => ({ ...d, skipEmpty: v }))}
                label={t('drawer_form_skip_empty')}
                hint={t('drawer_form_skip_empty_hint')}
              />
              <ToggleRow
                on={draft.includeAiSummary}
                onChange={(v) => setDraft((d) => ({ ...d, includeAiSummary: v }))}
                label={t('drawer_form_include_ai')}
                hint={t('drawer_form_include_ai_hint')}
              />
              <ToggleRow
                on={draft.isDefault}
                onChange={(v) => setDraft((d) => ({ ...d, isDefault: v }))}
                label={t('drawer_form_set_default')}
              />
            </div>
          </div>
          <div className="gp-form-row">
            <span className="gp-form-row__label">{t('drawer_form_preview')}</span>
            <PresetPreviewBox
              name={draft.name}
              slots={draft.slots}
              slotLabels={slotLabels}
              skipEmpty={draft.skipEmpty}
              includeAiSummary={draft.includeAiSummary}
            />
          </div>
        </div>
        <div className="gp-drawer__foot">
          {!isNew ? (
            <Btn kind="danger" sm onClick={onDelete}>
              {t('drawer_delete_button')}
            </Btn>
          ) : null}
          <div className="gp-drawer__foot-spacer" />
          <Btn sm onClick={onClose}>
            {t('drawer_cancel_button')}
          </Btn>
          <Btn sm kind="primary" onClick={onSave} disabled={pending}>
            {pending ? t('drawer_saving_button') : t('drawer_save_button')}
          </Btn>
        </div>
      </div>
    </>
  );
}

function ToggleRow({
  on,
  onChange,
  label,
  hint,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  // Inline button (not <Toggle> component) so biome's `noLabelWithoutControl`
  // can see the form control as a direct descendant of <label>; component
  // wrapping hides it from the rule's static analysis.
  return (
    <label className="gp-behavior-row">
      <button
        type="button"
        className="gp-toggle"
        data-on={on ? '1' : '0'}
        aria-pressed={on}
        onClick={() => onChange(!on)}
      >
        <i />
      </button>
      <span>
        {label}
        {hint ? <span className="gp-behavior-row__hint"> · {hint}</span> : null}
      </span>
    </label>
  );
}

function previewBody(
  slot: SlotKey,
  skipEmpty: boolean,
  ai: boolean,
  t: (key: string) => string,
): string {
  if (slot === 'stats') return t('preview_stats');
  if (slot === 'tracking_findings') return t('preview_tracking');
  if (slot === 'captures') return t('preview_captures');
  if (slot === 'thoughts') return skipEmpty ? t('preview_thoughts_skip') : t('preview_thoughts');
  if (slot === 'new_entities') return t('preview_new_entities');
  if (slot === 'ai_summary') return ai ? t('preview_ai_summary') : t('preview_ai_summary_off');
  return '';
}

function PresetPreviewBox({
  name,
  slots,
  slotLabels,
  skipEmpty,
  includeAiSummary,
  className,
}: {
  name: string;
  slots: SlotKey[];
  slotLabels: Record<SlotKey, string>;
  skipEmpty: boolean;
  includeAiSummary: boolean;
  className?: string;
}) {
  const t = useTranslations('settings.digest');
  return (
    <div className={`gp-preset-preview${className ? ` ${className}` : ''}`}>
      <div className="gp-preset-preview__head">
        <span>
          {name || t('drawer_preview_untitled')} · {t('drawer_preview_date')}
        </span>
        <span className="gp-mono-ink">{t('drawer_preview_channel')}</span>
      </div>
      {slots.length === 0 ? (
        <div className="gp-preset-preview__empty">{t('drawer_preview_empty')}</div>
      ) : null}
      {slots.map((sk) => {
        const empty = sk === 'thoughts' && skipEmpty;
        return (
          <div
            key={sk}
            className={`gp-preset-preview__section${empty ? ' gp-preset-preview__section--off' : ''}`}
          >
            <span className="gp-preset-preview__section-label">{slotLabels[sk]}</span>
            <span className="gp-preset-preview__section-body">
              {previewBody(sk, skipEmpty, includeAiSummary, t)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
