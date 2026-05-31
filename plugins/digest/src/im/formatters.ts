import type { DigestPresetRow, DigestSubscriptionRow } from '../types.js';

type Lang = 'en' | 'zh';

export const IM_FORMATTERS = {
  subscribe(lang: Lang, preset: DigestPresetRow, pushTime: string): string {
    return lang === 'zh'
      ? `已订阅 "${preset.name}"，每日 ${pushTime} 推送。`
      : `Subscribed to "${preset.name}" — pushes daily at ${pushTime}.`;
  },
  unsubscribe(lang: Lang, count: number): string {
    return lang === 'zh' ? `已取消 ${count} 个订阅。` : `Unsubscribed ${count} subscription(s).`;
  },
  list(lang: Lang, subs: DigestSubscriptionRow[], presets: DigestPresetRow[]): string {
    if (subs.length === 0) {
      return lang === 'zh' ? '你还没有订阅。' : 'You have no subscriptions.';
    }
    const byId = new Map(presets.map((p) => [p.id, p.name]));
    return subs
      .map((s) => {
        const name = byId.get(s.presetId) ?? `#${s.presetId}`;
        const pausedTag = s.paused ? (lang === 'zh' ? '（已暂停）' : ' (paused)') : '';
        return `- ${name} · ${s.pushTime}${pausedTag}`;
      })
      .join('\n');
  },
  pause(lang: Lang, count: number): string {
    return lang === 'zh' ? `已暂停 ${count} 个订阅。` : `Paused ${count} subscription(s).`;
  },
  resume(lang: Lang, count: number): string {
    return lang === 'zh' ? `已恢复 ${count} 个订阅。` : `Resumed ${count} subscription(s).`;
  },
  setPushTime(lang: Lang, count: number, pushTime: string): string {
    return lang === 'zh'
      ? `已把 ${count} 个订阅的推送时间改为 ${pushTime}。`
      : `Updated push time for ${count} subscription(s) to ${pushTime}.`;
  },
  noMatch(lang: Lang): string {
    return lang === 'zh' ? '找不到匹配的预设 / 订阅。' : 'No matching preset or subscription.';
  },
} as const;
