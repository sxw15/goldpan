import type { InspectorKind } from './payloads/types';

interface InspectorHeaderProps {
  currentTitle: string;
  kind: InspectorKind;
  /** Previous layer's title; null = first layer (no back button); '' = layer 2 but title not yet ready */
  previousTitle: string | null;
  onBack: () => void;
  onClose: () => void;
  /** Fallback label when previousTitle is '' but layer 2 */
  backFallbackLabel?: string;
  /** aria-label for close button (i18n) */
  closeLabel?: string;
  /** Display label for kind badge (i18n) */
  kindLabel?: string;
}

const KIND_LABEL_DEFAULTS: Record<InspectorKind, string> = {
  entity: '实体',
  source: '来源',
  note: '笔记',
  interest: '追踪项',
  task: '任务',
};

export function InspectorHeader({
  currentTitle,
  kind,
  previousTitle,
  onBack,
  onClose,
  backFallbackLabel = '返回',
  closeLabel = '关闭',
  kindLabel,
}: InspectorHeaderProps) {
  const showBack = previousTitle !== null;
  const backText = previousTitle && previousTitle.length > 0 ? previousTitle : backFallbackLabel;
  const kindDisplay = kindLabel ?? KIND_LABEL_DEFAULTS[kind];

  return (
    <header className="gp-inspector__header">
      <div className="gp-inspector__header-top">
        {showBack ? (
          <button type="button" className="gp-inspector__back" onClick={onBack}>
            ← {backText}
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        <button
          type="button"
          className="gp-inspector__close"
          aria-label={closeLabel}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="gp-inspector__header-bottom">
        <span className="gp-inspector__kind-badge">{kindDisplay}</span>
        <h2 className="gp-inspector__title" id="inspector-title">
          {currentTitle}
        </h2>
      </div>
    </header>
  );
}
