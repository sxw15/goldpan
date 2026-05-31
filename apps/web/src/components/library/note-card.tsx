'use client';

import type { NoteDetail } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import type { KeyboardEvent } from 'react';
import { useTz } from '@/components/tz-provider';
import { formatDateOnly } from '@/lib/format';
import type { InspectorPayload } from '../inspector/payloads/types';

const PREVIEW_LIMIT = 80;
// 二轮 review N6: cap chip 数量与 sources-section.tsx:83 (topEntities) 模式一致，
// 防 P4 backfill 多 entity 时卡片溢出。
const MAX_VISIBLE_TAGS = 3;
const MAX_VISIBLE_ENTITIES = 3;
// aria-label 用的短预览长度——避免 screen reader 读完整 preview 太冗长。
const ARIA_PREVIEW_LIMIT = 30;

interface NoteCardProps {
  note: NoteDetail;
  onOpen: (payload: InspectorPayload) => void;
}

export function NoteCard({ note, onOpen }: NoteCardProps) {
  const t = useTranslations('library');
  const tz = useTz();
  const date = formatDateOnly(note.createdAt, tz);
  const preview =
    note.content.length > PREVIEW_LIMIT ? `${note.content.slice(0, PREVIEW_LIMIT)}…` : note.content;
  const visibleTags = note.tags.slice(0, MAX_VISIBLE_TAGS);
  const extraTagCount = Math.max(0, note.tags.length - MAX_VISIBLE_TAGS);
  const visibleEntities = note.linkedEntities.slice(0, MAX_VISIBLE_ENTITIES);
  const extraEntityCount = Math.max(0, note.linkedEntities.length - MAX_VISIBLE_ENTITIES);
  // F-NOTE-CARD-INVALID-HTML: 用 div role="button" 替换原 <button>——HTML5 禁止 <p>/<ul>
  // 嵌在 <button> 内（React validateDOMNesting 会警告，部分 AT 还会把整段内容当成 button 名）。
  // F-NOTE-CARD-ARIA: 加 aria-label，让 screen reader 读简短的 "笔记 #id：preview"
  // 而不是把 subtype + 日期 + preview + tags + entities 全部串成一个超长 accessible name。
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen({ kind: 'note', id: note.id });
    }
  };
  return (
    <li>
      {/* biome-ignore lint/a11y/useSemanticElements: HTML5 禁止 <button> 包含 <p>/<ul>（参见 F-NOTE-CARD-INVALID-HTML），故用 div + role="button" + tabIndex + onKeyDown 还原按钮可达性。 */}
      <div
        role="button"
        tabIndex={0}
        aria-label={t('note_card_aria', {
          id: note.id,
          preview: preview.slice(0, ARIA_PREVIEW_LIMIT),
        })}
        className={`gp-note-card gp-note-card--subtype-${note.subtype}`}
        onClick={() => onOpen({ kind: 'note', id: note.id })}
        onKeyDown={handleKeyDown}
      >
        <div className="gp-note-card__top">
          <span className={`gp-note-card__subtype gp-note-card__subtype--${note.subtype}`}>
            {t(`notes_subtype_${note.subtype}`)}
          </span>
          <span className="gp-note-card__date">{date}</span>
        </div>
        <p className="gp-note-card__content">{preview}</p>
        {visibleTags.length > 0 && (
          <ul className="gp-note-card__tags">
            {visibleTags.map((tag) => (
              <li key={tag} className="gp-chip">
                {tag}
              </li>
            ))}
            {extraTagCount > 0 && (
              <li className="gp-chip gp-note-card__chip--more">
                {t('notes_more_suffix', { count: extraTagCount })}
              </li>
            )}
          </ul>
        )}
        {visibleEntities.length > 0 && (
          <ul className="gp-note-card__entities">
            {visibleEntities.map((e) => (
              <li key={e.id} className="gp-chip gp-note-card__entity-chip">
                {e.name}
              </li>
            ))}
            {extraEntityCount > 0 && (
              <li className="gp-chip gp-note-card__chip--more">
                {t('notes_more_suffix', { count: extraEntityCount })}
              </li>
            )}
          </ul>
        )}
      </div>
    </li>
  );
}
