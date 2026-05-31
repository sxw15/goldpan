'use client';

import type { ReactNode } from 'react';
import { useEnvMappingVisible } from '@/app/settings/env-mapping-visibility';
import { OriginBadge } from '@/app/settings/settings-primitives';
import { Btn } from './button';
import { Tag } from './tag';

/**
 * Discriminator for which interaction mode a field uses. Drives hook selection
 * (useToggleCommit / useEditableCommit) and renderer choice in group components.
 *
 * - toggle / segmented / enum: onChange triggers immediate commit
 * - text / number: draft → user clicks [Save] → commit
 * - secret: inline edit mode (entering edit shows input + [Cancel][Save])
 * - display: read-only value, no commit path
 */
export type SettingsFieldKind =
  | 'toggle'
  | 'segmented'
  | 'enum'
  | 'text'
  | 'number'
  | 'secret'
  | 'display';

export interface FieldTagLabels {
  restart: ReactNode;
  /** Hover hint for the restart-required tag (rich content, e.g. link to Service page). */
  restartHint: ReactNode;
  readonly: ReactNode;
  /** Prefix shown before the env var name (e.g. ".env · "). */
  envPrefix: ReactNode;
  /** Label for fields with no real backend wiring yet. */
  todo: ReactNode;
  /** Label for fields whose live value is injected by the host environment
   * (docker/k8s/supervisor) and shadows any `.env` write. */
  shadowed: ReactNode;
}

export function SettingsField({
  label,
  hint,
  value,
  valueInk,
  control,
  restart,
  env,
  readonly,
  todo,
  shadowed,
  stack,
  tagLabels,
  source,
  baselineDiffers,
  onReset,
  resetting,
  resetLabel,
  resetInProgressLabel,
  resetTitle,
  status,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  valueInk?: boolean;
  control?: ReactNode;
  restart?: 'restart';
  env?: string;
  readonly?: boolean;
  /** Renders a TODO tag and signals "no real backend yet". */
  todo?: boolean;
  /** Renders a "shadowed" warning tag when the live env value comes from the
   * host environment (docker/k8s/supervisor) and writes to `.env` won't take
   * effect until that injection is removed. */
  shadowed?: boolean;
  stack?: boolean;
  /** i18n labels for restart/env/readonly tags. Required to enforce caller-side i18n at compile time, mirroring Modal.closeLabel/confirmLabel/cancelLabel. */
  tagLabels: FieldTagLabels;
  /** Origin of the live value (env baseline / runtime override / default).
   * Renders an OriginBadge inline with the meta tags row when provided. */
  source?: 'env' | 'override' | 'default';
  /** Only meaningful when `source === 'override'`. Surfaces a `!` mark on the
   * badge + hover hint warning that the baseline disagrees with the override. */
  baselineDiffers?: boolean;
  /** Click handler for the reset button. Only renders when source === 'override'.
   * Caller should commit `{ [key]: null }` to revert the override and refresh.
   * Return type intentionally loose — consumers may forward `resetEnvKey`
   * (`Promise<boolean>`) directly or wrap it; the field discards the result
   * since the click side-effects all happen inside the handler. */
  onReset?: () => unknown;
  /** True while the reset round-trip is in flight; disables the reset button
   * and swaps the label. */
  resetting?: boolean;
  /** i18n: label shown on the reset button (e.g. "Reset" / "重置"). */
  resetLabel?: ReactNode;
  /** i18n: label while the reset is in flight (e.g. "Resetting…" / "正在重置…"). */
  resetInProgressLabel?: ReactNode;
  /** i18n: hover hint on the reset button explaining what it does. */
  resetTitle?: string;
  /** Inline status indicator (rendered next to control). Pass FieldStatus
   * element from useFieldCommit hook, or null when field has no commit path
   * (display kind, or pre-migration callers). */
  status?: ReactNode;
}) {
  const envMappingVisible = useEnvMappingVisible();
  const showRestartTags = restart === 'restart';
  // env tag、OriginBadge、shadowed 都属于 ".env / 配置后端" 概念，由全局开关
  // 控制是否露出。readonly / todo 与 .env 无关，无论开关都显示。
  const showEnvTag = Boolean(env) && envMappingVisible;
  const showOrigin = Boolean(source) && envMappingVisible;
  const showShadowed = Boolean(shadowed) && envMappingVisible;
  const showMetaTags = showEnvTag || showOrigin || showShadowed || readonly || todo;
  const showReset = source === 'override' && typeof onReset === 'function';
  return (
    <div className={`gp-field${stack ? ' gp-field--stack' : ''}`}>
      <div className="gp-field__label">
        <div className="gp-field__title-row">
          <span className="gp-field__label-main">{label}</span>
          {showRestartTags ? (
            <span className="gp-field__title-tags">
              <Tag kind="restart" tip={tagLabels.restartHint}>
                {tagLabels.restart}
              </Tag>
            </span>
          ) : null}
        </div>
        {hint ? <div className="gp-field__hint">{hint}</div> : null}
        {showMetaTags ? (
          <span className="gp-field__tags">
            {showEnvTag && (
              <Tag kind="env">
                {tagLabels.envPrefix}
                {env}
              </Tag>
            )}
            {showOrigin && source ? (
              <OriginBadge source={source} baselineDiffers={baselineDiffers} />
            ) : null}
            {readonly && <Tag kind="readonly">{tagLabels.readonly}</Tag>}
            {todo && <Tag kind="todo">{tagLabels.todo}</Tag>}
            {showShadowed && <Tag kind="shadowed">{tagLabels.shadowed}</Tag>}
          </span>
        ) : null}
      </div>
      <div className="gp-field__trail">
        <div className={`gp-field__value${valueInk ? ' gp-field__value--ink' : ''}`}>{value}</div>
        {status}
        <div className="gp-field__control">
          {control}
          {showReset ? (
            <span className="gp-field__reset" title={resetTitle}>
              <Btn
                sm
                kind="ghost"
                disabled={resetting === true}
                onClick={() => {
                  void onReset?.();
                }}
              >
                {resetting ? resetInProgressLabel : resetLabel}
              </Btn>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
