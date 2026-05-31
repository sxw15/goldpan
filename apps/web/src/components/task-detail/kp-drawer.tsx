'use client';

import { useEffect, useMemo } from 'react';
import type { ProcessingResult } from '@/types/processing-result';

interface KpDrawerProps {
  open: boolean;
  onClose: () => void;
  result: ProcessingResult;
  labels: {
    title: (n: number) => string;
    subtitle: string;
    closeLabel: string;
  };
}

interface KpRow {
  pointKey: string;
  pointId?: number;
  content: string;
  kind: 'fact' | 'opinion';
  entity: string;
}

export function KpDrawer({ open, onClose, result, labels }: KpDrawerProps) {
  const rows: KpRow[] = useMemo(() => {
    const out: KpRow[] = [];
    for (const e of result.entities) {
      for (const f of e.newFactPoints) {
        out.push({
          pointKey: f.pointKey,
          pointId: f.pointId,
          content: f.content,
          kind: 'fact',
          entity: e.entityName,
        });
      }
      for (const o of e.newOpinionPoints ?? []) {
        out.push({
          pointKey: o.pointKey,
          pointId: o.pointId,
          content: o.content,
          kind: 'opinion',
          entity: e.entityName,
        });
      }
    }
    return out;
  }, [result]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <button
        type="button"
        className="gp-tdp-drawer-backdrop"
        aria-label={labels.closeLabel}
        onClick={onClose}
      />
      <aside className="gp-tdp-drawer" role="dialog" aria-modal="true">
        <div className="gp-tdp-drawer__head">
          <div>
            <h3 className="gp-tdp-drawer__title">{labels.title(rows.length)}</h3>
            <div className="gp-tdp-drawer__sub">{labels.subtitle}</div>
          </div>
          <button
            type="button"
            className="gp-tdp-drawer__close"
            onClick={onClose}
            aria-label={labels.closeLabel}
          >
            ✕
          </button>
        </div>
        <div className="gp-tdp-drawer__body">
          <ul className="gp-td-kp-list">
            {rows.map((r) => (
              <li
                key={r.pointKey}
                className={`gp-td-kp${r.kind === 'opinion' ? ' gp-td-kp--opinion' : ''}`}
              >
                <span className="gp-td-kp__content">{r.content}</span>
                <span className="gp-td-kp__entity">
                  ↳ <b>{r.entity}</b>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </>
  );
}
