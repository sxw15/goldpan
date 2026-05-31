/**
 * Collecting step task logs store `collectorPlugin` (after success) and
 * `collectorCandidates` (before collection) in JSON summaries — helpers for UI.
 */

export type CollectingPluginDisplay =
  | { kind: 'definitive'; name: string }
  | { kind: 'candidates'; names: string };

export function getCollectingPluginFromSummaries(summary: {
  step: string;
  inputSummary: Record<string, unknown> | null;
  outputSummary: Record<string, unknown> | null;
}): CollectingPluginDisplay | null {
  if (summary.step !== 'collecting') return null;
  const out = summary.outputSummary?.collectorPlugin;
  if (typeof out === 'string' && out.trim()) return { kind: 'definitive', name: out.trim() };
  const cands = summary.inputSummary?.collectorCandidates;
  if (Array.isArray(cands) && cands.length > 0) {
    const names = cands.filter((x): x is string => typeof x === 'string').join(', ');
    if (names) return { kind: 'candidates', names };
  }
  return null;
}

export function getCollectingPluginFromRawLog(log: {
  step: string;
  event: string;
  inputSummary: string | null;
  outputSummary: string | null;
}): CollectingPluginDisplay | null {
  if (log.step !== 'collecting') return null;
  let input: Record<string, unknown> | null = null;
  let output: Record<string, unknown> | null = null;
  try {
    if (log.inputSummary) input = JSON.parse(log.inputSummary);
  } catch {
    /* leave null */
  }
  try {
    if (log.outputSummary) output = JSON.parse(log.outputSummary);
  } catch {
    /* leave null */
  }
  if (log.event === 'end' && output) {
    const out = output.collectorPlugin;
    if (typeof out === 'string' && out.trim()) return { kind: 'definitive', name: out.trim() };
  }
  if (log.event === 'start' && input) {
    const cands = input.collectorCandidates;
    if (Array.isArray(cands) && cands.length > 0) {
      const names = cands.filter((x): x is string => typeof x === 'string').join(', ');
      if (names) return { kind: 'candidates', names };
    }
  }
  return null;
}
