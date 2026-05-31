// Includes internal-only steps so debug views mirror the full orchestrator.
export const PIPELINE_MAIN_STEPS = [
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
] as const;

export const PIPELINE_TOTAL = PIPELINE_MAIN_STEPS.length;

export const STEP_INDEX: Record<string, number> = Object.fromEntries(
  PIPELINE_MAIN_STEPS.map((s, i) => [s, i + 1]),
);
