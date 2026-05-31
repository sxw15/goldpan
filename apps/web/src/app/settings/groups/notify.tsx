'use client';

import type { ImSettingsManifest } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ImChannelCard } from '@/components/im-channel-card';
import { SettingsHead } from '@/components/ui/settings-head';
import { rethrowNextErrors } from '@/lib/rethrow';
import { runImAction } from '../actions';
import type { GroupProps } from '../settings-shell';
import { useFieldTagLabels } from '../use-field-tag-labels';

export function GroupNotify(
  props: GroupProps & { manifests: ImSettingsManifest[]; language: 'en' | 'zh' },
) {
  const t = useTranslations('settings.notify');
  const fieldTagLabels = useFieldTagLabels();
  const { env, commit, manifests, language, inFlightKeys, setFieldEditing } = props;
  // Track per-field editing locally so envMeta.dirty can reflect BOTH
  // "user typed but hasn't blurred yet" (editing) and "blur fired a
  // commit but the server hasn't replied yet" (in-flight). The shell's
  // editingFields is a global Set that doesn't expose membership-by-key
  // on GroupProps; instead we mirror IM card's onEditingChange events
  // into a local Set so envMeta can be a synchronous read.
  const [imEditingKeys, setImEditingKeys] = useState<ReadonlySet<string>>(new Set());

  function envMeta(envKey: string) {
    const entry = env.get(envKey);
    return {
      configured: !!entry?.configured,
      mask: entry?.mask,
      source: entry?.source,
      // dirty = "should the Test action button wait?". Combines
      // (a) in-flight commit on this key (blur fired, server hasn't
      //     replied) — server would still read OLD process.env if action
      //     ran now;
      // (b) user typing into THIS key (localDraft !== null) — even before
      //     blur, the user clearly hasn't committed yet, so Test would
      //     run against the OLD env. Pre-fix only (a) was tracked, so
      //     a fast paste + click sequence bypassed the gate.
      dirty: inFlightKeys.has(envKey) || imEditingKeys.has(envKey),
    };
  }

  function legacyConfiguredDefault(manifest: ImSettingsManifest): boolean {
    const enableEntry = env.get(manifest.enable.envKey);
    if (enableEntry?.configured) return manifest.enable.default;
    const requiredFields = manifest.fields.filter((f) => f.required);
    if (requiredFields.length === 0) return manifest.enable.default;
    return requiredFields.every((f) => env.get(f.envKey)?.configured === true);
  }

  return (
    <>
      <SettingsHead crumb={t('crumb')} heading={t('heading')} desc={t('desc')} />
      {manifests.map((manifest) => {
        // Fresh-state fallback chain：env 优先，最后 manifest default。空字符串
        // 视为缺失（buildEnvState 给未配置返回 `mask: ''`），让 default 生效。
        const envMask = env.get(manifest.enable.envKey)?.mask;
        const fallbackEnabled = legacyConfiguredDefault(manifest);
        const enabledRaw = (envMask || undefined) ?? String(fallbackEnabled);
        const enabledOn = enabledRaw === 'true';
        const values: { __enabled?: boolean } & Record<string, string | boolean | undefined> = {
          __enabled: enabledOn,
        };
        for (const f of manifest.fields) {
          if (f.kind === 'toggle') {
            // env 层把 toggle 序列化成 'true'/'false' 字符串；ImChannelCard 的
            // FieldRenderer 用 `!!value` 判 toggle，非空字符串无论 'true' 或
            // 'false' 都会被当成 true。这里按 kind 还原成 boolean。
            const raw = env.get(f.envKey)?.mask;
            values[f.name] =
              raw === 'true' ? true : raw === 'false' ? false : (f.default as boolean | undefined);
          } else if (f.kind === 'secret') {
            // 不把 mask 字符串（如 `••••abcd`）当 input value 绑给 secret 字段
            // —— 浏览器自动填充 / 用户随手点一下都会把 mask 当成新凭据 commit
            // 回 server，覆盖真值。空 input + envMeta 提供的 mask 由
            // FieldRenderer 渲染成 placeholder。
            values[f.name] = '';
          } else {
            // text / segmented：保留 mask 显示当前值，让用户看到 / 编辑现有
            // 配置（非 secret 类 mask 经过 stripUrlCredentials 处理后是 raw value）。
            values[f.name] = env.get(f.envKey)?.mask ?? '';
          }
        }
        return (
          <ImChannelCard
            key={manifest.channelId}
            manifest={manifest}
            mode="settings"
            language={language}
            values={values}
            envMeta={envMeta}
            tagLabels={fieldTagLabels}
            toast={props.toast}
            // onChange is required by the wizard-shared interface but
            // intentionally inert in settings mode — `onCommit` below
            // owns all commit-firing for text/secret (blur) and
            // toggle/segmented (click). Without this no-op, ImChannelCard's
            // FieldRenderer would still call onChange for the local-draft
            // sync path, which would land here and double-fire commit.
            onChange={() => {
              // intentional no-op — see comment above.
            }}
            onCommit={async (name, value) => {
              // Settings-mode commit hook. Returns Promise<boolean> so
              // TextSecretField can decide whether to clear localDraft
              // (success → clear) or retain it (failure → keep visible
              // for retry).
              const envKey =
                name === '__enabled'
                  ? manifest.enable.envKey
                  : manifest.fields.find((f) => f.name === name)?.envKey;
              if (envKey === undefined) return false;
              try {
                const result = await commit({
                  [envKey]: typeof value === 'boolean' ? String(value) : value,
                });
                return result.kind === 'ok';
              } catch (err) {
                // Propagate NEXT_REDIRECT (401 session expiry) so Next's
                // framework can navigate; other errors fall through
                // silently because the shell already toasted.
                rethrowNextErrors(err);
                return false;
              }
            }}
            onEditingChange={(name, editing) => {
              // Wire IM text/secret drafts into the shell's leave-guard
              // AND into envMeta.dirty so the Test action waits while
              // user is typing.
              const envKey =
                name === '__enabled'
                  ? manifest.enable.envKey
                  : manifest.fields.find((f) => f.name === name)?.envKey;
              if (envKey === undefined) return;
              setFieldEditing(envKey, editing);
              setImEditingKeys((prev) => {
                if (editing) {
                  if (prev.has(envKey)) return prev;
                  const next = new Set(prev);
                  next.add(envKey);
                  return next;
                }
                if (!prev.has(envKey)) return prev;
                const next = new Set(prev);
                next.delete(envKey);
                return next;
              });
            }}
            onAction={async (actionId) => {
              try {
                return await runImAction(manifest.channelId, actionId);
              } catch (err) {
                rethrowNextErrors(err);
                return { ok: false, code: 'internal' };
              }
            }}
          />
        );
      })}
    </>
  );
}
