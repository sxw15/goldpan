import type { DigestPreset, EnvKeyState, ManagedEnvKey, PluginsSnapshot } from '@goldpan/web-sdk';

export type SettingsGroupId =
  | 'account'
  | 'data'
  | 'appearance'
  | 'llm'
  | 'embedding'
  | 'plugins'
  | 'collect'
  | 'search'
  | 'notify'
  | 'digest'
  | 'about';

export type SettingsSectionId = 'workspace' | 'ai' | 'sources' | 'push' | 'system';

export interface GroupMeta {
  id: SettingsGroupId;
  section: SettingsSectionId;
  readonly?: boolean;
}

export const SECTION_ORDER: SettingsSectionId[] = ['workspace', 'ai', 'sources', 'push', 'system'];

export const GROUPS: GroupMeta[] = [
  { id: 'account', section: 'workspace' },
  { id: 'data', section: 'workspace' },
  { id: 'appearance', section: 'workspace' },
  { id: 'llm', section: 'ai' },
  { id: 'embedding', section: 'ai' },
  { id: 'collect', section: 'sources' },
  { id: 'search', section: 'sources' },
  { id: 'notify', section: 'push' },
  { id: 'digest', section: 'push' },
  { id: 'about', section: 'system' },
  { id: 'plugins', section: 'system' },
];

export const SLOT_KEYS = [
  'tracking_findings',
  'captures',
  'thoughts',
  'new_entities',
  'stats',
  'ai_summary',
] as const;

export type SlotKey = (typeof SLOT_KEYS)[number];

/**
 * Per-group whitelist of env keys the group can edit. The shell uses these to
 * scope dirty patches, save calls, and undo to one group at a time. Groups
 * not listed here have `[]` (no env-backed fields — pure todo / mock).
 *
 * Editing this map is the only place that should grow when Phase-N PRs add new
 * env-wired fields. Adding a key here without also adding the corresponding
 * `<SettingsField env={K} />` will not break anything but will leak the dirty
 * scope (the user's edit shows in saveBar but no field renders the input).
 *
 * `notify` intentionally does NOT enumerate per-channel IM env keys (token,
 * appId, etc.) — those are now plugin-managed and discovered at
 * render time via the manifests fetched from the server. `settings-shell.tsx`
 * merges those plugin envKeys with this static base before scoping dirty / save /
 * navigation. Hardcoding them here would re-couple the host to specific
 * channels (the very thing the IM plugin protocol exists to avoid).
 */
export const GROUP_ENV_KEYS: Record<SettingsGroupId, ReadonlyArray<ManagedEnvKey>> = {
  account: ['GOLDPAN_AUTH_PASSWORD', 'GOLDPAN_SSRF_VALIDATION_ENABLED'],
  data: [],
  appearance: ['GOLDPAN_LANGUAGE', 'GOLDPAN_TRANSLATE_PIPELINE_OUTPUT'],
  llm: [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'OLLAMA_BASE_URL',
    'GOLDPAN_OLLAMA_ENABLED',
    'GOLDPAN_LLM_CLASSIFIER',
    'GOLDPAN_LLM_EXTRACTOR',
    'GOLDPAN_LLM_MATCHER',
    'GOLDPAN_LLM_RELATOR',
    'GOLDPAN_LLM_COMPARATOR',
    'GOLDPAN_LLM_VERIFIER',
    'GOLDPAN_LLM_TRANSLATOR',
    'GOLDPAN_LLM_INTENT',
    'GOLDPAN_LLM_QUERY',
    'GOLDPAN_LLM_DIGEST_SUMMARY',
    'GOLDPAN_LLM_DIGEST_ACTION',
    'GOLDPAN_LLM_VERIFIER_ENABLED',
    'GOLDPAN_RELATION_ENABLED',
    'GOLDPAN_TRANSLATE_PIPELINE_OUTPUT',
    // Per-step timeout overrides edited via LlmTimeoutPanel. These MUST be in
    // groupKeys, otherwise `groupDirty = pickKeys(store.dirty, groupKeys)`
    // silently drops them on save — committing nothing while the UI looks
    // like it persisted. The global timeout is also included so the
    // GOLDPAN_LLM_TIMEOUT input at the top of the panel writes through.
    'GOLDPAN_LLM_TIMEOUT',
    'GOLDPAN_LLM_CLASSIFIER_TIMEOUT',
    'GOLDPAN_LLM_EXTRACTOR_TIMEOUT',
    'GOLDPAN_LLM_MATCHER_TIMEOUT',
    'GOLDPAN_LLM_RELATOR_TIMEOUT',
    'GOLDPAN_LLM_COMPARATOR_TIMEOUT',
    'GOLDPAN_LLM_VERIFIER_TIMEOUT',
    'GOLDPAN_LLM_TRANSLATOR_TIMEOUT',
    'GOLDPAN_LLM_INTENT_TIMEOUT',
    'GOLDPAN_LLM_QUERY_TIMEOUT',
    'GOLDPAN_LLM_DIGEST_SUMMARY_TIMEOUT',
    'GOLDPAN_LLM_DIGEST_ACTION_TIMEOUT',
  ],
  embedding: [
    'GOLDPAN_EMBEDDING_ENABLED',
    'GOLDPAN_EMBEDDING_MODEL',
    'GOLDPAN_EMBEDDING_DIMENSIONS',
    'GOLDPAN_EMBEDDING_BATCH_SIZE',
  ],
  plugins: [],
  collect: [
    'GOLDPAN_COLLECT_TIMEOUT',
    'GOLDPAN_BROWSER_STRATEGY',
    'GOLDPAN_BROWSER_EXECUTABLE_PATH',
    'GOLDPAN_MEDIA_COLLECT_TIMEOUT',
    'GOLDPAN_YT_DLP_AUTO_UPDATE',
    'GOLDPAN_YT_DLP_BINARY_PATH',
    'GOLDPAN_YT_DLP_COOKIES_PATH',
    'GOLDPAN_GITHUB_TOKEN',
    'GOLDPAN_MAX_CONTENT_LENGTH',
    'GOLDPAN_MIN_CONTENT_LENGTH',
    'GOLDPAN_MAX_TEXT_INPUT_LENGTH',
  ],
  search: [
    'TAVILY_API_KEY',
    'SERPER_API_KEY',
    'EXA_API_KEY',
    'BRAVE_SEARCH_API_KEY',
    'SEARXNG_BASE_URL',
    'GOLDPAN_GOOGLE_SEARCH_ENABLED',
  ],
  notify: [],
  digest: ['GOLDPAN_DIGEST_ENABLED'],
  about: [],
};

// ─── Mock data for groups without real backend wiring ───────────────────────

export interface MockSearchTool {
  id: string;
  name: string;
  sub: string;
  env: string;
  status: 'ok' | 'off';
  cost: string;
}

export const INITIAL_SEARCH_TOOLS: MockSearchTool[] = [
  {
    id: 'tavily',
    name: 'Tavily',
    sub: '通用 web search',
    env: 'TAVILY_API_KEY',
    status: 'ok',
    cost: '~$0.01 / query',
  },
  {
    id: 'exa',
    name: 'Exa',
    sub: '语义搜索 · 论文 / 长文友好',
    env: 'EXA_API_KEY',
    status: 'off',
    cost: '~$0.005 / q',
  },
  {
    id: 'serper',
    name: 'Serper',
    sub: 'Google SERP fallback',
    env: 'SERPER_API_KEY',
    status: 'ok',
    cost: '~$0.001 / q',
  },
  {
    id: 'brave',
    name: 'Brave Search',
    sub: '隐私优先',
    env: 'BRAVE_SEARCH_API_KEY',
    status: 'off',
    cost: '免费 (限速)',
  },
  {
    id: 'searx',
    name: 'SearXNG',
    sub: '自托管 meta-search',
    env: 'SEARXNG_BASE_URL',
    status: 'off',
    cost: '本地',
  },
  {
    id: 'google',
    name: 'Google',
    sub: 'Playwright 抓 SERP · 兜底无 key 方案',
    env: '—',
    status: 'off',
    cost: '免费 (限速 + 反爬)',
  },
];

// Mock state slices used purely by todo fields (UI demo only).
export interface DataMockState {
  dbSize: string;
  cacheSize: number;
  autoBackup: boolean;
  lastBackup: string;
  lastBackupFile: string;
}
export interface AppearanceMockState {
  density: 'compact' | 'regular' | 'comfy';
}

export interface SettingsMockSlice {
  data: DataMockState;
  appearance: AppearanceMockState;
  searchTools: MockSearchTool[];
}

export interface SettingsStore {
  /** Server snapshot of every MANAGED_ENV_KEY from `GET /settings/env-state`. */
  env: ReadonlyMap<ManagedEnvKey, EnvKeyState>;
  /** Cross-group unsaved patch. Empty string = clear that key from .env. */
  dirty: Readonly<Record<string, string>>;
  /** Mock data for fields without real backend wiring (todo). */
  mock: SettingsMockSlice;
  /** From digest plugin probe — controls whether digest group renders preset list or "disabled" card. */
  digestEnabled: boolean;
  /** From listDigestPresetsCached. */
  presets: DigestPreset[];
  /** Server snapshot of registered plugins from `GET /settings/plugins`. */
  pluginsSnapshot: PluginsSnapshot;
}

export const INITIAL_MOCK: SettingsMockSlice = {
  data: {
    dbSize: '42.7',
    cacheSize: 118,
    autoBackup: true,
    lastBackup: '2 小时前',
    lastBackupFile: '~/.goldpan/backups/2026-04-26.tar.gz',
  },
  appearance: { density: 'regular' },
  searchTools: INITIAL_SEARCH_TOOLS,
};

export function indexEnvState(items: EnvKeyState[]): ReadonlyMap<ManagedEnvKey, EnvKeyState> {
  const m = new Map<ManagedEnvKey, EnvKeyState>();
  for (const it of items) m.set(it.key as ManagedEnvKey, it);
  return m;
}

export function pickKeys(
  source: Readonly<Record<string, string>>,
  keys: ReadonlyArray<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (k in source) out[k] = source[k];
  }
  return out;
}

export function omitKeys(
  source: Readonly<Record<string, string>>,
  keys: ReadonlyArray<string>,
): Record<string, string> {
  const drop = new Set<string>(keys);
  const out: Record<string, string> = {};
  for (const k of Object.keys(source)) {
    if (!drop.has(k)) out[k] = source[k];
  }
  return out;
}

export const INITIAL_TELEGRAM_PRESETS: DigestPreset[] = [
  {
    id: -1,
    channel: 'telegram',
    name: 'tg_morning',
    period: 'daily',
    pushDay: null,
    pushTime: '08:00',
    windowMode: 'calendar',
    slots: ['stats', 'ai_summary'],
    skipEmpty: true,
    includeAiSummary: true,
    isDefault: true,
  },
  {
    id: -2,
    channel: 'telegram',
    name: 'tg_eod',
    period: 'daily',
    pushDay: null,
    pushTime: '18:00',
    windowMode: 'calendar',
    slots: ['captures', 'thoughts', 'ai_summary'],
    skipEmpty: false,
    includeAiSummary: true,
    isDefault: false,
  },
];

/**
 * Map a core config cross-field constraint error `code` (thrown by
 * `loadConfig` in packages/core/src/config/index.ts) to its `settings.shell`
 * i18n key, or `null` for codeless / unknown errors. Single source of the
 * code→key mapping, shared by the two surfaces that show commit errors: the
 * settings-shell toast (`localizeCommitError`) and the content-length fields'
 * inline error (collect.tsx wraps `commit` to localize before the field hook
 * renders the otherwise-raw English `message`).
 */
export function configErrorI18nKey(
  code: string | undefined,
): 'err_content_length_min_gt_max' | 'err_content_length_text_gt_max' | null {
  switch (code) {
    case 'content_length_min_exceeds_max':
      return 'err_content_length_min_gt_max';
    case 'content_length_text_exceeds_max':
      return 'err_content_length_text_gt_max';
    default:
      return null;
  }
}
