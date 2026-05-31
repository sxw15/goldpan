import type { IntentPluginResult, IntentSessionRef } from '@goldpan/core/plugins';
import type { DigestCrudService } from '../service.js';
import type { DigestPresetRow, DigestSubscriptionRow } from '../types.js';
import type { ParsedAction } from './action-parser.schema.js';
import { IM_FORMATTERS } from './formatters.js';

export interface HandlerDeps {
  action: ParsedAction;
  language: 'en' | 'zh';
  service: DigestCrudService;
  ref: IntentSessionRef;
}

export async function handleDigestAction(deps: HandlerDeps): Promise<IntentPluginResult> {
  const { action, service, ref, language } = deps;
  const presets = service.listPresets(ref.channelId);
  const matchPreset = (name?: string): DigestPresetRow | null =>
    name
      ? (presets.find((p) => p.name === name) ?? null)
      : (presets.find((p) => p.isDefault) ?? null);
  const subs = service.listSubscriptions(ref);
  const filterSubs = (name?: string): DigestSubscriptionRow[] => {
    if (!name) return subs;
    const preset = matchPreset(name);
    return preset ? subs.filter((s) => s.presetId === preset.id) : [];
  };

  switch (action.kind) {
    case 'subscribe': {
      const preset = matchPreset(action.presetName);
      if (!preset) return { type: 'action', message: IM_FORMATTERS.noMatch(language) };
      // 显式 pushTime 优先,缺省时落到 preset 自己的默认推送时间。
      const effectivePushTime = action.pushTime ?? preset.pushTime;
      service.upsertSubscription({
        ...ref,
        presetId: preset.id,
        pushTime: effectivePushTime,
      });
      return {
        type: 'action',
        message: IM_FORMATTERS.subscribe(language, preset, effectivePushTime),
      };
    }
    case 'unsubscribe': {
      const targets = filterSubs(action.presetName);
      service.runInTransaction(() => {
        for (const s of targets) service.deleteSubscription(s.id);
      });
      return { type: 'action', message: IM_FORMATTERS.unsubscribe(language, targets.length) };
    }
    case 'list':
      return {
        type: 'content',
        text: IM_FORMATTERS.list(language, subs, presets),
        format: 'markdown',
      };
    case 'pause': {
      const targets = filterSubs(action.presetName);
      service.runInTransaction(() => {
        for (const s of targets) service.updateSubscription(s.id, { paused: true });
      });
      return { type: 'action', message: IM_FORMATTERS.pause(language, targets.length) };
    }
    case 'resume': {
      const targets = filterSubs(action.presetName);
      service.runInTransaction(() => {
        for (const s of targets) service.updateSubscription(s.id, { paused: false });
      });
      return { type: 'action', message: IM_FORMATTERS.resume(language, targets.length) };
    }
    case 'set_push_time': {
      const targets = filterSubs(action.presetName);
      service.runInTransaction(() => {
        for (const s of targets) service.updateSubscription(s.id, { pushTime: action.pushTime });
      });
      return {
        type: 'action',
        message: IM_FORMATTERS.setPushTime(language, targets.length, action.pushTime),
      };
    }
  }
}
