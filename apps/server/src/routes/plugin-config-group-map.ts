export type PluginConfigGroupId = 'collect' | 'notify' | 'digest' | 'search' | 'llm';

/**
 * Plugin 在 settings UI 中"前往配置"按钮跳转的 group id。
 * 未登记的 plugin 不渲染配置按钮。
 *
 * 这跟 PluginSettingsContribution.group 是相关但独立的字段:
 * - contribution.group = plugin 卡片渲染在哪个 group(plugin 自报)
 * - PLUGIN_CONFIG_GROUP_MAP = /settings/plugins 列表里"前往配置"按钮跳到哪个 group(host 决定,可与 contribution.group 不一致)
 *
 * IM plugin(im-telegram / im-feishu)不在此 map,走 notify group 通过 ImSettingsManifest 单独管理。
 *
 * Key 是 plugin 的 slug（plugin source 里 `goldpanPlugin = { name: '...' }`），
 * 不是 npm package name 也不是目录名 —— 三者可能不同（例：dir `github-collector/`
 * 的 plugin slug 是 `collector-github`）。
 */
export const PLUGIN_CONFIG_GROUP_MAP: Record<string, PluginConfigGroupId> = {
  'collector-browser': 'collect',
  'collector-media': 'collect',
  'collector-github': 'collect',
  'github-intent': 'collect',
  digest: 'digest',
  'tool-search-tavily': 'search',
  'tool-search-serper': 'search',
  'tool-search-exa': 'search',
  'tool-search-brave': 'search',
  'tool-search-searxng': 'search',
};
