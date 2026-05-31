'use client';

import { useEffect, useState } from 'react';

interface ProcessingHeroProps {
  /** Active step index over the full pipeline; used to drive progress bar. */
  currentIdx: number;
  totalSteps: number;
  currentStepName: string;
  /** Title format like "正在 {step} 原文里的知识点". */
  formatTitle: (step: string) => string;
  flavorLines: string[];
  /** ETA format. */
  formatEta: (percent: number) => string;
}

export function ProcessingHero({
  currentIdx,
  totalSteps,
  currentStepName,
  formatTitle,
  flavorLines,
  formatEta,
}: ProcessingHeroProps) {
  const percent = currentIdx < 0 ? 0 : Math.round(((currentIdx + 0.5) / totalSteps) * 100);
  const [flavorIdx, setFlavorIdx] = useState(0);

  useEffect(() => {
    if (flavorLines.length === 0) return;
    const id = setInterval(() => setFlavorIdx((i) => (i + 1) % flavorLines.length), 2200);
    return () => clearInterval(id);
  }, [flavorLines.length]);

  const flavor = flavorLines[flavorIdx] ?? '';

  return (
    <div className="gp-td-proc-hero">
      <div className="gp-td-proc-spinner" aria-hidden="true" />
      <h3 className="gp-td-proc-step-name">{formatTitle(currentStepName)}</h3>
      {flavor && <p className="gp-td-proc-flavor">{flavor}</p>}
      <div className="gp-td-progress" aria-hidden="true">
        <div className="gp-td-progress__bar" style={{ width: `${percent}%` }} />
      </div>
      <div className="gp-td-proc-eta">{formatEta(percent)}</div>
    </div>
  );
}
