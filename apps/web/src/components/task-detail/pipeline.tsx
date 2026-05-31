'use client';

export type PipelineStepKey =
  | 'collecting'
  | 'classifying'
  | 'extracting'
  | 'matching'
  | 'relating'
  | 'comparing'
  | 'verifying'
  | 'validatePipelineOutput'
  | 'translating'
  | 'storing'
  | 'content_validation';

export const PIPELINE_STEPS: PipelineStepKey[] = [
  'collecting',
  'classifying',
  'extracting',
  'matching',
  'relating',
  'comparing',
  'verifying',
  'validatePipelineOutput',
  'translating',
  'storing',
];

interface PipelineProps {
  /** Index of the current step (-1 = no current). */
  currentIdx: number;
  /** Index of the failed step (-1 = no failure). */
  failedIdx: number;
  /** Translate a step key into its display name. */
  stepLabel: (key: PipelineStepKey) => string;
  /** Status labels: done / current / failed / pending. */
  statusLabels: {
    done: string;
    current: string;
    failed: string;
    pending: string;
  };
  /** Step-counter format: "Step {n} / {total}". */
  formatStepNum: (n: number, total: number) => string;
}

export function Pipeline({
  currentIdx,
  failedIdx,
  stepLabel,
  statusLabels,
  formatStepNum,
}: PipelineProps) {
  const total = PIPELINE_STEPS.length;
  return (
    <div className="gp-td-pipeline" style={{ '--gp-td-pipe-cols': total } as React.CSSProperties}>
      {PIPELINE_STEPS.map((key, i) => {
        let cls = 'gp-td-pipe-step--pending';
        let label: string = statusLabels.pending;
        if (failedIdx >= 0) {
          if (i < failedIdx) {
            cls = 'gp-td-pipe-step--done';
            label = `✓ ${statusLabels.done}`;
          } else if (i === failedIdx) {
            cls = 'gp-td-pipe-step--failed';
            label = `✗ ${statusLabels.failed}`;
          }
        } else if (currentIdx >= 0) {
          if (i < currentIdx) {
            cls = 'gp-td-pipe-step--done';
            label = `✓ ${statusLabels.done}`;
          } else if (i === currentIdx) {
            cls = 'gp-td-pipe-step--current';
            label = `○ ${statusLabels.current}`;
          }
        }
        return (
          <div key={key} className={`gp-td-pipe-step ${cls}`}>
            <div className="gp-td-pipe-step__num">{formatStepNum(i + 1, total)}</div>
            <div className="gp-td-pipe-step__name">{stepLabel(key)}</div>
            <div className="gp-td-pipe-step__status">{label}</div>
          </div>
        );
      })}
    </div>
  );
}

export function pipelineIndexOf(key: string | null | undefined): number {
  if (!key) return -1;
  const idx = PIPELINE_STEPS.indexOf(key as PipelineStepKey);
  return idx;
}
