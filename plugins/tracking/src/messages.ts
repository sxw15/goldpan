import { getLanguage } from '@goldpan/core/i18n';

type MessageMap = {
  interest_created: (name: string) => string;
  interest_updated: (id: number) => string;
  interest_deleted: (id: number) => string;
  interest_enabled: (id: number) => string;
  interest_disabled: (id: number) => string;
  interest_list_empty: string;
  invalid_provider: (name: string, available: string[]) => string;
};

const messages: Record<string, MessageMap> = {
  en: {
    interest_created: (name: string) =>
      `Tracking interest "${name}" created. First search will run on the next scheduler cycle.`,
    interest_updated: (id: number) => `Tracking interest #${id} updated.`,
    interest_deleted: (id: number) => `Tracking interest #${id} deleted.`,
    interest_enabled: (id: number) => `Tracking interest #${id} enabled.`,
    interest_disabled: (id: number) => `Tracking interest #${id} disabled.`,
    interest_list_empty: 'No tracking interests configured yet.',
    invalid_provider: (name: string, available: string[]) =>
      `Tool provider "${name}" is not available. Available: ${available.join(', ')}`,
  },
  zh: {
    interest_created: (name: string) => `追踪项"${name}"已创建，下一个调度周期将执行首次搜索。`,
    interest_updated: (id: number) => `追踪项 #${id} 已更新。`,
    interest_deleted: (id: number) => `追踪项 #${id} 已删除。`,
    interest_enabled: (id: number) => `追踪项 #${id} 已启用。`,
    interest_disabled: (id: number) => `追踪项 #${id} 已禁用。`,
    interest_list_empty: '尚未配置任何追踪项。',
    invalid_provider: (name: string, available: string[]) =>
      `工具提供者"${name}"不可用。可用选项：${available.join('、')}`,
  },
};

export function msg(): MessageMap {
  return messages[getLanguage()] ?? messages.en;
}
