'use client';

import { useTranslations } from 'next-intl';
import { ClarifyChip } from './clarify-chip';

export interface ClarifyResultCardProps {
  result: {
    /** P2 keyed shape — `clarify_question.<questionKey>` i18n lookup. */
    questionKey?: string;
    /** P2 keyed shape — each chip carries intentKey + opaque payload. */
    structuredOptions?: Array<{ intentKey: string; payload?: string }>;
    /** Legacy plain-text question (free-text plugins not yet on the keyed shape). */
    question?: string;
    /** Legacy plain-text options — render-only static list, no dispatch. */
    options?: string[];
  };
  /** P4: chip click handler — chat-view 决定走 forcedIntent /input 还是
   * resolveTrackingClarify。默认 noop 让 message-bubble 透传更宽松。 */
  onChipClick: (intentKey: string, payload?: string) => void;
  disabled?: boolean;
}

export function ClarifyResultCard({ result, onChipClick, disabled }: ClarifyResultCardProps) {
  const t = useTranslations('intent_classifier');
  const tChat = useTranslations('chat');

  // Question 优先 keyed —— Task 10 才补 tracking_resolve_entity 这个 key，
  // 没命中时 next-intl 回退到 key 字符串本身（acceptable，spec 默许）。
  const question = result.questionKey
    ? t(`clarify_question.${result.questionKey}`)
    : (result.question ?? '');

  const structured = result.structuredOptions;
  const hasStructured = structured !== undefined && structured.length > 0;
  // 兼容外部 P2 plugin —— 仅 legacy `options` 时退回静态 <li> 列表（不可点击）。
  const hasLegacy = !hasStructured && result.options !== undefined && result.options.length > 0;

  return (
    <div className="gp-clarify-result">
      <div className="gp-clarify-result__question">{question}</div>
      {hasStructured && (
        <div className="gp-clarify-result__chips">
          {structured.map((opt, idx) => (
            <ClarifyChip
              // biome-ignore lint/suspicious/noArrayIndexKey: classifier-emitted intentKey 可能在结构选项列表里重复（例如同一 intent 多 payload），加 idx 前缀保证唯一
              key={`${idx}-${opt.intentKey}`}
              intentKey={opt.intentKey}
              payload={opt.payload}
              onClick={onChipClick}
              disabled={disabled}
            />
          ))}
        </div>
      )}
      {hasLegacy && (
        <ul className="gp-clarify-result__options">
          {result.options?.map((option, idx) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: LLM-generated options may contain duplicates; index ensures unique keys
              key={`${idx}-${option}`}
              className="gp-clarify-result__option"
            >
              {option}
            </li>
          ))}
        </ul>
      )}
      <div className="gp-clarify-result__hint">{tChat('clarify_hint')}</div>
    </div>
  );
}
