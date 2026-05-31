import type { NoteSubtype } from '../notes/types';

// Wait reason 枚举值（UI 端按 key 走 i18n 翻译，避免 LLM 输出语言与 UI locale 不一致）
export const WAIT_REASONS = [
  'incomplete_referent', // 出现指代信号但上下文找不到指代物
  'incomplete_command', // 半句不完整（"明天那个..."）
  'awaiting_url', // 看起来要后续发 URL
  'awaiting_clarification', // 其它需后续补充
] as const;
export type WaitReason = (typeof WAIT_REASONS)[number];

// Clarify question 枚举 —— LLM-facing 子集：classifier z.enum 用此限制 LLM 输出。
// P4: 内部还需要 `tracking_resolve_entity` 给 deferredResolver 直接构造，不允许
// LLM 输出（让 schema validation 拒掉幻觉），所以拆 LLM_ / 内部 两份。
export const LLM_CLARIFY_QUESTIONS = [
  'ambiguous_intent', // 笔记 vs 提交 vs 查询
  'unclear_target', // 不清楚操作对象（追踪哪个主体）
  'incomplete_action', // 操作意图不完整
] as const;
export type LlmClarifyQuestion = (typeof LLM_CLARIFY_QUESTIONS)[number];

export const CLARIFY_QUESTIONS = [
  ...LLM_CLARIFY_QUESTIONS,
  'tracking_resolve_entity', // P4: deferredResolver awaiting_clarify chip 用，LLM 不可输出
] as const;
export type ClarifyQuestion = (typeof CLARIFY_QUESTIONS)[number];

// Clarify option 的 intent key 白名单（不允许 LLM 自由文本，UI 端按 key i18n）
// 同上：LLM-facing 子集 + 内部 superset 两层。
export const LLM_CLARIFY_OPTION_KEYS = [
  'create_note',
  'submit_url',
  'query',
  'create_tracking',
  'submit_text',
  'record_thought',
] as const;
export type LlmClarifyOptionKey = (typeof LLM_CLARIFY_OPTION_KEYS)[number];

export const CLARIFY_OPTION_KEYS = [
  ...LLM_CLARIFY_OPTION_KEYS,
  'resolve_tracking_entity', // P4: tracking awaiting_clarify chip 用，UI 走 /tracking/rules/:id/resolve
] as const;
export type ClarifyOptionKey = (typeof CLARIFY_OPTION_KEYS)[number];

// Wait decision 的 fallback intent 白名单（仅无 deferred 依赖的 intent 可作 fallback）
export const FALLBACK_INTENTS = ['submit_url', 'query', 'create_note'] as const;
export type FallbackIntent = (typeof FALLBACK_INTENTS)[number];

// Note subtype（与 packages/core/src/notes/types.ts 中的 NoteSubtype 保持一致；
// 这里重声明而不是 import 是因为 intent 模块不应反向依赖 notes 模块。
// 一致性由本文件末尾的编译时 assert 守护）
export const INTENT_NOTE_SUBTYPES = ['memo', 'note'] as const;
export type IntentNoteSubtype = (typeof INTENT_NOTE_SUBTYPES)[number];

// 引用某条 conversation 历史消息（指代不到具体 source 的兜底）
export interface IntentRelatedTo {
  messageId: number;
  hintKey?: 'comment' | 'followup' | 'quotation' | 'correction' | 'other';
}

// 三档 decision 的 TS 表达（z.infer 出来等价但要 zod 才能消费；types.ts 给纯 TS 入口）
export interface IntentExecuteDecision {
  decision: 'execute';
  intent: string;
  noteSubtype?: IntentNoteSubtype;
  deferredEntityResolution?: boolean;
  linkedSourceId?: number | null;
  relatedTo?: IntentRelatedTo | null;
}

export interface IntentWaitDecision {
  decision: 'wait';
  intent: string;
  fallbackIntent: FallbackIntent;
  maxWaitMs: number;
  waitReason: WaitReason;
  linkedSourceId?: number | null;
  relatedTo?: IntentRelatedTo | null;
}

export interface IntentClarifyDecision {
  decision: 'clarify';
  clarifyQuestionKey: ClarifyQuestion;
  clarifyOptions: Array<{ intentKey: ClarifyOptionKey; payload?: string }>;
  linkedSourceId?: number | null;
  relatedTo?: IntentRelatedTo | null;
}

export type IntentDecision = IntentExecuteDecision | IntentWaitDecision | IntentClarifyDecision;

// 编译时 assert：IntentNoteSubtype 必须等于 NoteSubtype（双向 extends）。
// 改任一方未同步时 `true satisfies false` 报错（强制 P5 改 notes/subtype 时同步本文件）。
true satisfies IntentNoteSubtype extends NoteSubtype
  ? NoteSubtype extends IntentNoteSubtype
    ? true
    : false
  : false;
