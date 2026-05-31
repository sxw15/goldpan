import type { LlmCallRepository } from '../../db/repositories/types';
import { errorMessage } from '../../errors';
import { t } from '../../i18n/index';
import { compilePrompt, computePromptHash, loadPromptTemplate } from '../../prompts/loader';
import {
  type CallLlmFn,
  type PipelineContext,
  type VerifierRejection,
  verifierSchema,
} from '../types';

export interface VerifyingDeps {
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
  logger?: { warn(msg: string, ...args: unknown[]): void };
}

export async function executeVerifying(
  ctx: PipelineContext,
  deps: VerifyingDeps,
): Promise<PipelineContext> {
  if (!ctx.config.llm.verifierEnabled) {
    return { ...ctx, verifierRejections: [] };
  }

  const newPointKeys = new Set<string>();
  for (const ej of ctx.entityJudgments) {
    for (const pj of ej.pointJudgments) {
      if (pj.judgment === 'new') {
        newPointKeys.add(pj.pointKey);
      }
    }
  }

  if (newPointKeys.size === 0) {
    return { ...ctx, verifierRejections: [] };
  }

  const newPoints = ctx.points.filter((p) => newPointKeys.has(p.pointKey));

  // §7.2 verifying: ALL failures degrade to skip. Wrap everything (including
  // prompt loading/compilation) in the degradation try/catch so template errors
  // don't abort the entire pipeline.
  try {
    const rawTemplate = loadPromptTemplate('verifier', ctx.config.language);
    const systemTemplate = loadPromptTemplate('verifier-system', ctx.config.language);
    const system = compilePrompt(systemTemplate, {});
    const prompt = compilePrompt(rawTemplate, {
      knowledgePoints: newPoints.map((p) => ({
        pointKey: p.pointKey,
        type: p.type,
        content: p.content,
      })),
      content: ctx.content ?? '',
    });
    const promptHash = computePromptHash(rawTemplate, systemTemplate, ctx.config.language);

    const output = await deps.callLlm({
      step: 'verifier',
      schema: verifierSchema,
      system,
      prompt,
      promptHash,
      sourceId: ctx.source.id,
      llmCallRepo: deps.llmCallRepo,
      logPayloads: ctx.config.llmLogPayloads ?? false,
    });

    const warnings = [...ctx.validationWarnings];

    // Filter out hallucinated pointKeys not in the input set
    const filteredRejected = output.rejectedPointKeys.filter((r) => {
      if (!newPointKeys.has(r.pointKey)) {
        warnings.push(t('pipeline.verifying.non_target_key', { key: r.pointKey }));
        return false;
      }
      return true;
    });

    const filteredVerified = output.verifiedPointKeys.filter((key) => {
      if (!newPointKeys.has(key)) {
        warnings.push(t('pipeline.verifying.non_target_key', { key }));
        return false;
      }
      return true;
    });

    const rejectedKeySet = new Set(filteredRejected.map((r) => r.pointKey));

    // §7.2: mutual exclusivity — rejected wins, remove from verified set
    const reconciledVerified = filteredVerified.filter((key) => {
      if (rejectedKeySet.has(key)) {
        warnings.push(t('pipeline.verifying.conflict', { key }));
        return false;
      }
      return true;
    });

    // Detect omissions: keys in newPointKeys that appear in neither verified nor rejected
    const verifiedKeySet = new Set(reconciledVerified);
    for (const key of newPointKeys) {
      if (!verifiedKeySet.has(key) && !rejectedKeySet.has(key)) {
        warnings.push(t('pipeline.verifying.omission', { key }));
      }
    }

    const rejections: VerifierRejection[] = filteredRejected.map((r) => ({
      pointKey: r.pointKey,
      reason: r.reason,
    }));

    return {
      ...ctx,
      verifierRejections: rejections,
      validationWarnings: warnings,
    };
  } catch (err) {
    deps.logger?.warn('Verifier degraded to skip', {
      taskId: ctx.task.id,
      sourceId: ctx.source.id,
      error: errorMessage(err),
    });
    return {
      ...ctx,
      verifierRejections: [],
      validationWarnings: [
        ...ctx.validationWarnings,
        t('pipeline.verifying.degraded', {
          message: t('pipeline.verifying.degraded_generic'),
        }),
      ],
    };
  }
}
