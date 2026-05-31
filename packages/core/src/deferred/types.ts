import type { ILogObj, Logger } from 'tslog';
import type { DrizzleDB } from '../db/connection';
import type { ConversationRepository, KnowledgeRepository } from '../db/repositories/types';
import type { IntentPluginResult } from '../plugins/types';

/**
 * pending_resolution JSON shape。重复定义在 core 是因为 tracking plugin 是
 * external — core 不能 import 它的 types.ts。两边手工同步，TrackingDb 写入时
 * `satisfies` 这个 type 保证 shape 漂移立即报错。
 */
export interface PendingResolutionPayload {
  sourceId: number;
  placeholderName?: string;
  candidateEntityIds?: number[];
  conversationId: number;
  sessionRef?: {
    channelId: string;
    accountId: string;
    chatId: string;
    userId: string;
  };
}

export type DeferredResolutionStatus =
  | 'resolved'
  | 'pending_pipeline'
  | 'awaiting_clarify'
  | 'failed_no_entity'
  | 'failed_source_pipeline';

/**
 * 抽象 tracking plugin 给 core deferredResolver 的接口。tracking plugin 在
 * onPostInit 阶段把自己适配成此 port 注册到 deferredResolver。如果 tracking
 * plugin 没 load → core 跳过 tracking 分支（仅 note backfill）。
 */
export interface DeferredTrackingPort {
  /** 拉所有 pending_pipeline 行 keyed on sourceId */
  findPendingByPipelineSource(sourceId: number): Array<{
    id: number;
    pendingResolution: PendingResolutionPayload | null;
  }>;

  markResolved(
    id: number,
    input: {
      name: string;
      searchQueries: string[];
      linkedEntityIds: number[];
      expectedStatus: DeferredResolutionStatus;
    },
  ): boolean;

  markFailedResolution(
    id: number,
    input: {
      targetStatus: 'failed_no_entity' | 'failed_source_pipeline';
      expectedStatus: DeferredResolutionStatus;
    },
  ): boolean;

  markAwaitingClarify(
    id: number,
    input: { candidateEntityIds: number[]; expectedStatus: DeferredResolutionStatus },
  ): boolean;

  findAwaitingClarifyOlderThan(cutoffMs: number): Array<{
    id: number;
    pendingResolution: PendingResolutionPayload | null;
  }>;
}

/**
 * IM outbound push callback 注入；core 不直接依赖 im-runtime。bootstrap 把
 * IMRuntime.sendOutbound 适配成此签名。返回 Promise 因为 IM 发送是异步；
 * resolver fire-and-forget 调用。
 */
export type ImSendOutbound = (
  channelId: string,
  sessionRef: NonNullable<PendingResolutionPayload['sessionRef']>,
  result: IntentPluginResult,
) => Promise<void>;

export interface DeferredResolverDeps {
  db: DrizzleDB;
  knowledge: KnowledgeRepository;
  conversation: ConversationRepository;
  /** undefined when tracking plugin not loaded — resolver skips tracking branch */
  trackingPort?: DeferredTrackingPort;
  /** undefined when IM runtime not composed — resolver only writes to conversation */
  imSendOutbound?: ImSendOutbound;
  logger: Logger<ILogObj>;
}
