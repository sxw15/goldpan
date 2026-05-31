import type { ZodRawShape } from 'zod';
import type { DrizzleDB } from '../db/connection';
import { SqliteRuntimeConfigOverrideRepository } from '../db/repositories/runtime-config';
import type { ConfigPatch, WizardCommitResult } from './store-types';
import { validateStaged } from './validate-staged';

export interface WizardCommitOptions {
  bootEnv: Readonly<NodeJS.ProcessEnv>;
  pluginEnvKeys?: ReadonlyArray<string>;
  pluginEnvSchemas?: ReadonlyArray<ZodRawShape>;
  knownLlmProviderIds?: ReadonlyArray<string>;
}

/**
 * Wizard-time commit.
 *
 * 共享 ConfigStore 的 validation pipeline (走 `validateStaged` helper),但:
 *  - **不**更新 process.env (wizard 阶段没有运行中的 pipeline / registry 关心这个)
 *  - **不**构造 snapshot (wizard caller 写完立即 restart,根本不读;且 strict
 *    loadConfig 在 wizard 阶段配置不全时必抛 — 强行造 snapshot 会把整个 commit
 *    流程拖崩,即使所有验证都过了)
 *
 * **SSRF 校验由 wizard route 层执行(Task 16)**,与 settings route 对称,不在
 * 这里调 — 见 validate-staged.ts 顶部注释的安全约束。
 */
export async function commitWizardOverrides(
  db: DrizzleDB,
  patch: ConfigPatch,
  options: WizardCommitOptions,
): Promise<WizardCommitResult> {
  const { bootEnv, pluginEnvKeys, pluginEnvSchemas, knownLlmProviderIds } = options;
  const repo = new SqliteRuntimeConfigOverrideRepository(db);
  const currentOverrides = repo.list();

  const result = validateStaged({
    patch,
    bootEnv,
    currentOverrides,
    pluginEnvKeys,
    pluginEnvSchemas,
    knownLlmProviderIds,
  });
  if (!result.ok) return { kind: 'errors', errors: result.errors };

  repo.applyPatch(patch);
  return { kind: 'ok' };
}
