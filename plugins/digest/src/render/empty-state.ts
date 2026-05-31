import type { ChannelSlot, DataSnapshot } from '../types.js';

/**
 * True when every requested slot has no content to render. Stats with all
 * zero counters and an empty ai_summary both count as empty. The caller
 * uses this to emit a single "nothing to report" placeholder instead of a
 * skeleton of empty sections.
 */
export function isFullyEmpty(snapshot: DataSnapshot, slots: ChannelSlot[]): boolean {
  for (const slot of slots) {
    if (slot === 'ai_summary') {
      if (snapshot.aiSummary.text.trim().length > 0) return false;
      continue;
    }
    const mod = snapshot.modules[slot];
    if (!mod) continue;
    if (mod.type === 'stats') {
      if (mod.captures > 0 || mod.findings > 0 || mod.thoughts > 0 || mod.entities > 0) {
        return false;
      }
      continue;
    }
    if (mod.items.length > 0) return false;
  }
  return true;
}
