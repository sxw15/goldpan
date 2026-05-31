import type { DigestPresetRow } from './types.js';

type DefaultPreset = Omit<DigestPresetRow, 'id' | 'channel'>;

export const DEFAULT_PRESETS: DefaultPreset[] = [
  {
    name: 'daily_default',
    period: 'daily',
    pushDay: null,
    pushTime: '08:00',
    windowMode: 'calendar',
    slots: ['stats', 'tracking_findings', 'captures', 'thoughts', 'new_entities', 'ai_summary'],
    skipEmpty: true,
    includeAiSummary: true,
    isDefault: true,
  },
  {
    name: 'daily_compact',
    period: 'daily',
    pushDay: null,
    pushTime: '08:00',
    windowMode: 'calendar',
    slots: ['stats', 'tracking_findings', 'ai_summary'],
    skipEmpty: true,
    includeAiSummary: true,
    isDefault: false,
  },
  {
    name: 'daily_reader',
    period: 'daily',
    pushDay: null,
    pushTime: '08:00',
    windowMode: 'calendar',
    slots: ['captures', 'thoughts', 'ai_summary'],
    skipEmpty: true,
    includeAiSummary: true,
    isDefault: false,
  },
  {
    name: 'weekly_default',
    period: 'weekly',
    pushDay: 1,
    pushTime: '09:00',
    windowMode: 'calendar',
    slots: ['stats', 'tracking_findings', 'captures', 'new_entities', 'ai_summary'],
    skipEmpty: true,
    includeAiSummary: true,
    isDefault: false,
  },
];
