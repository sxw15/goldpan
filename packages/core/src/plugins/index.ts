export { validateSsrf, validateSsrfIfEnabled } from '../utils/ssrf';
export { collectorWebPlugin } from './builtin/collector-web/index';
export { intentNotePlugin } from './builtin/intent-note/index';
export { intentQueryPlugin } from './builtin/intent-query/index';
export { intentSubmitPlugin } from './builtin/intent-submit/index';
// Re-exported so external intent plugins (plugins/tracking, plugins/digest, …)
// can validate `ctx.linkedSourceId` against `recentMessages` without reaching
// into the deep top-level `@goldpan/core` entry — keeps the plugin import
// surface flat under `@goldpan/core/plugins`.
export { collectMentionedSourceIds } from './builtin/utils/conversation-context';
export { emitCollectDiagnostic, runWithCollectDiagnostics } from './collect-diagnostics';
export {
  buildContributionEnvSchema,
  type ContributionValidationError,
  type ContributionValidationResult,
  isContributionRuntimeReady,
  type LocaleCode,
  type LocalizedString,
  type PluginActionContext,
  type PluginActionDescriptor,
  type PluginActionEnvPatch,
  type PluginActionHandler,
  type PluginActionResult,
  type PluginNotice,
  type PluginSettingsContribution,
  type PluginSettingsModule,
  type PluginSetupGuide,
  type PluginSetupStep,
  type ResolvedPluginActionDescriptor,
  type ResolvedPluginNotice,
  type ResolvedPluginSettingsContribution,
  type ResolvedPluginSetupGuide,
  type ResolvedPluginSetupStep,
  type ResolvedSettingsField,
  resolveContribution,
  resolveLocalized,
  type SettingsField,
  type SettingsFieldBase,
  type SettingsFieldKind,
  type SettingsGroup,
  type SettingsNumberField,
  type SettingsSegmentedField,
  type SettingsTextField,
  type SettingsToggleField,
  validateContribution,
} from './contribution';
export {
  CollectorError,
  type CollectorErrorCode,
  formatAbortSignalReason,
  ToolOutputValidationError,
} from './errors';
export { loadExternalPlugins } from './external';
export {
  type CreatePluginTranslatorOptions,
  createPluginTranslator,
  type PluginMessageBundle,
  type PluginTranslator,
} from './i18n';
export { PluginRegistry, type SettingsContributionRegistration } from './registry';
export { type LlmProviderPluginInfo, scanLlmProviderPlugins } from './scan';
export {
  SEARCH_TIME_RANGE_QDR,
  type SearchInput,
  type SearchOutput,
  searchInputSchema,
  searchOutputSchema,
} from './search-schema';
export { parseCollectedHtml } from './shared/parse-collected-html';
export {
  SharedResourceManager,
  type SharedResourceManagerOptions,
} from './shared-resource-manager';
export {
  type CollectorInput,
  type CollectorOutput,
  type CollectorPlugin,
  type CollectorResult,
  type GoldpanPlugin,
  type HandleInputRepos,
  type IntentDeclaration,
  type IntentExecutionContext,
  type IntentPlugin,
  type IntentPluginResult,
  type IntentPluginResultType,
  type IntentRegistration,
  type IntentSessionRef,
  isIntentPlugin,
  isLlmProviderPlugin,
  isToolPlugin,
  type LlmProviderPlugin,
  type PluginContext,
  type PluginType,
  resolvePluginDescription,
  type ServiceCallLlmFn,
  type ServiceCapabilities,
  type ToolDeclaration,
  type ToolPlugin,
} from './types';
