export type Period = 'daily' | 'weekly';

/**
 * 时间窗口锚定方式:
 * - calendar: 对齐本地零点。daily=昨天 00:00..23:59,weekly=过去 7 个完整日历日。
 *   适合"每日固定快照",上下班节奏看到的内容是相对稳定的日历切片。
 * - rolling: 以 snapshot 生成时刻(scheduler 触发或手动 regenerate)为锚点。
 *   daily=now-24h..now,weekly=now-7d..now。适合"始终是过去 N 小时",
 *   半夜手动 regenerate 与 cron 触发覆盖的范围会不同(锚点不同)。
 */
export type WindowMode = 'calendar' | 'rolling';

export const CHANNEL_SLOTS = [
  'tracking_findings',
  'captures',
  'thoughts',
  'new_entities',
  'stats',
  'ai_summary',
] as const;

export type ChannelSlot = (typeof CHANNEL_SLOTS)[number];

export interface DigestId {
  channel: string;
  date: string;
  presetId: number | null;
}

export interface ModuleHasMore {
  hasMore: boolean;
  hiddenCount: number;
}

export interface TrackingFindingsModule extends ModuleHasMore {
  type: 'tracking_findings';
  /**
   * `ruleId` mirrors `sources.tracking_rule_id`, which is nullable in the
   * DB — there is no CHECK constraint tying `origin='tracking'` to a
   * non-null rule, and legacy / manually inserted rows can have a NULL
   * here. Renderers must omit the "rule #X" fragment when null rather
   * than printing a magic sentinel like `rule #0`.
   */
  items: Array<{
    id: number;
    ruleId: number | null;
    title: string;
    url: string;
    createdAt: number;
  }>;
}
export interface CapturesModule extends ModuleHasMore {
  type: 'captures';
  items: Array<{ id: number; title: string; url: string; createdAt: number }>;
}
export interface ThoughtsModule extends ModuleHasMore {
  type: 'thoughts';
  items: Array<{ id: number; text: string; createdAt: number }>;
}
export interface NewEntitiesModule extends ModuleHasMore {
  type: 'new_entities';
  items: Array<{ id: number; name: string; description: string | null; createdAt: number }>;
}
export interface StatsModule {
  type: 'stats';
  captures: number;
  findings: number;
  thoughts: number;
  entities: number;
}

export type ModuleData =
  | TrackingFindingsModule
  | CapturesModule
  | ThoughtsModule
  | NewEntitiesModule
  | StatsModule;

export interface AiSummaryData {
  status: 'pending' | 'complete' | 'fallback';
  text: string;
}

export interface DataSnapshot {
  digestId: DigestId;
  period: Period;
  generatedAt: number;
  modules: Record<Exclude<ChannelSlot, 'ai_summary'>, ModuleData>;
  aiSummary: AiSummaryData;
}

export interface GenerateResult {
  snapshot: DataSnapshot;
  status: 'partial' | 'complete';
}

export interface DigestPresetRow {
  id: number;
  channel: string;
  name: string;
  period: Period;
  pushDay: number | null;
  /**
   * HH:MM (24h, local tz). 用作 IM `/subscribe <preset>` 默认推送时间;
   * subscription 自带 pushTime 仍可 override。scheduler 不直接读这个字段
   * (它看 subscription.pushTime),所以改 preset.pushTime 只对未来订阅生效。
   */
  pushTime: string;
  /** 时间窗口锚定方式 — 见 {@link WindowMode}。 */
  windowMode: WindowMode;
  slots: ChannelSlot[];
  skipEmpty: boolean;
  includeAiSummary: boolean;
  isDefault: boolean;
}

export interface DigestSubscriptionRow {
  id: number;
  channelId: string;
  accountId: string;
  chatId: string;
  userId: string;
  presetId: number;
  pushTime: string;
  paused: boolean;
  lastPushedAt: number | null;
}
