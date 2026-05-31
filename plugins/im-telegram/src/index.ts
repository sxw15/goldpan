export type { TelegramAdapterDeps, TelegramChannelConfig } from './adapter.js';
export { createTelegramAdapter } from './adapter.js';
export {
  goldpanIMEnvSpec,
  goldpanIMRegistration,
  goldpanIMSettings,
  type TelegramChannelSlice,
} from './settings.js';
export {
  type SendTelegramTestMessageOptions,
  sendTelegramTestMessage,
  TelegramTestError,
  type TelegramTestErrorKind,
} from './transport/oneshot.js';
