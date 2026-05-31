// Example IM channel adapter skeleton. Reads no real channel — exposes the
// runtime registration shape so plugin authors can see what an adapter looks
// like before implementing one. Reuses the existing ImSettingsManifest /
// ImChannelEnvSpec / ImChannelRegistrationFn protocol (Phase 2 will unify
// these with PluginSettingsContribution).
//
// Three exports the loader looks up by name:
//   - goldpanIMSettings   (ImSettingsModule = { manifest, handlers })
//   - goldpanIMEnvSpec    (ImChannelEnvSpec — env zod fragment + parse/toValues)
//   - goldpanIMRegistration (ImChannelRegistrationFn — slice -> adapter or null)

import type {
  ImChannelEnvSpec,
  ImChannelRegistrationFn,
  ImSettingsManifest,
  ImSettingsModule,
} from '@goldpan/im-runtime';
import { z } from 'zod';

interface NoopChannelSlice {
  enabled: boolean;
  greeting: string;
}

export const goldpanIMEnvSpec: ImChannelEnvSpec<NoopChannelSlice> = {
  channelId: 'noop',
  envSchema: {
    GOLDPAN_IM_NOOP_ENABLED: z.enum(['true', 'false']).default('false'),
    GOLDPAN_IM_NOOP_GREETING: z.string().default('hi'),
  },
  parse: (parsed) => ({
    enabled: parsed.GOLDPAN_IM_NOOP_ENABLED === 'true',
    greeting: String(parsed.GOLDPAN_IM_NOOP_GREETING ?? 'hi'),
  }),
  toValues: (slice) => ({ greeting: slice.greeting }),
};

export const goldpanIMRegistration: ImChannelRegistrationFn = (slice) => {
  const s = slice as NoopChannelSlice;
  if (!s.enabled) return null;
  // A real adapter would construct a ChannelAdapter here via something like
  //   const adapter = createNoopAdapter({ conversationRepo: deps.conversationRepo });
  //   return { adapter, channelConfig: { ... }, secrets: { ... } };
  // The skeleton returns null with no side effect so the noop plugin never
  // actually starts. Keeps the example compilable without pulling in a real
  // transport library.
  return null;
};

const manifest: ImSettingsManifest = {
  channelId: 'noop',
  branding: { name: { en: 'Noop channel', zh: '空渠道' } },
  enable: {
    envKey: 'GOLDPAN_IM_NOOP_ENABLED',
    label: { en: 'Enable Noop channel', zh: '启用 Noop 渠道' },
    default: false,
  },
  fields: [
    {
      name: 'greeting',
      kind: 'text',
      label: { en: 'Greeting', zh: '问候语' },
      envKey: 'GOLDPAN_IM_NOOP_GREETING',
      placeholder: { en: 'hi', zh: '你好' },
      required: false,
      requiresRestart: true,
    },
  ],
  actions: [],
  setupGuide: {
    allDoneTitle: { en: 'Noop channel ready', zh: 'Noop 渠道已就绪' },
    steps: [],
  },
};

export const goldpanIMSettings: ImSettingsModule = { manifest, handlers: {} };
