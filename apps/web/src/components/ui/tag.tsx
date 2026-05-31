'use client';

import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type TagKind =
  | 'live'
  | 'restart'
  | 'env'
  | 'readonly'
  | 'default'
  | 'beta'
  | 'todo'
  | 'shadowed';

function measureTipAnchor(anchor: HTMLElement): { top: number; left: number; maxWidth: number } {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const margin = 12;
  const maxW = Math.min(320, vw - margin * 2);
  let left = r.left;
  if (left + maxW > vw - margin) {
    left = vw - margin - maxW;
  }
  if (left < margin) {
    left = margin;
  }
  return { top: r.bottom + 8, left, maxWidth: maxW };
}

export function Tag({
  kind = 'env',
  children,
  tip,
}: {
  kind?: TagKind;
  children: ReactNode;
  /** Hover hint (portaled `position:fixed` bubble — not native `title`). */
  tip?: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const hideTimerRef = useRef<number | undefined>(undefined);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [bubbleBox, setBubbleBox] = useState<{
    top: number;
    left: number;
    maxWidth: number;
  } | null>(null);

  const cancelScheduledHide = () => {
    if (hideTimerRef.current !== undefined) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    }
  };

  const scheduleHide = () => {
    cancelScheduledHide();
    hideTimerRef.current = window.setTimeout(() => setOpen(false), 200);
  };

  const showTip = () => {
    cancelScheduledHide();
    const el = anchorRef.current;
    if (el) {
      setBubbleBox(measureTipAnchor(el));
    }
    setOpen(true);
  };

  useEffect(() => setMounted(true), []);

  useEffect(
    () => () => {
      if (hideTimerRef.current !== undefined) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = undefined;
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const el = anchorRef.current;
      if (el) setBubbleBox(measureTipAnchor(el));
    };
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  if (tip !== undefined && tip !== null) {
    const bubble =
      mounted && open && bubbleBox ? (
        <span
          role="tooltip"
          className="gp-tag-tip__bubble gp-tag-tip__bubble--portal"
          style={{
            top: bubbleBox.top,
            left: bubbleBox.left,
            maxWidth: bubbleBox.maxWidth,
          }}
          onMouseEnter={showTip}
          onMouseLeave={scheduleHide}
        >
          {tip}
        </span>
      ) : null;

    return (
      <>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only visual hint anchor; tooltip is supplementary. */}
        <span
          ref={anchorRef}
          className="gp-tag-tip"
          onMouseEnter={showTip}
          onMouseLeave={scheduleHide}
        >
          <span className={`gp-tag gp-tag--${kind}`}>
            {children}
            {kind === 'restart' ? (
              <span className="gp-tag__hover-affordance" aria-hidden="true">
                ?
              </span>
            ) : null}
          </span>
        </span>
        {bubble ? createPortal(bubble, document.body) : null}
      </>
    );
  }
  return <span className={`gp-tag gp-tag--${kind}`}>{children}</span>;
}
