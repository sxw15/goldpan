import type { LlmCallRepository } from '../../db/repositories/types';
import { errorMessage } from '../../errors';
import { t } from '../../i18n/index';
import { compilePrompt, computePromptHash, loadPromptTemplate } from '../../prompts/loader';
import { normalizeTags } from '../../utils/tag-normalize';
import {
  type CallLlmFn,
  extractingSchema,
  type IndexedPoint,
  type PipelineContext,
  PipelineError,
} from '../types';

export interface ExtractingDeps {
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
}

export async function executeExtracting(
  ctx: PipelineContext,
  deps: ExtractingDeps,
): Promise<PipelineContext> {
  if (!ctx.content) {
    throw new PipelineError(t('pipeline.extracting.no_content'), 'extracting', 'unknown');
  }

  const isOpinion = ctx.inputType === 'opinion';
  const isIncrementalUpdate = ctx.updateMode === 'incremental';
  const language = ctx.config.language;
  const systemTemplate = loadPromptTemplate('extractor-system', language);
  const system = compilePrompt(systemTemplate, { isOpinion });

  const rawTemplate = loadPromptTemplate('extractor', language);
  let prompt: string;
  try {
    prompt = compilePrompt(rawTemplate, {
      content: ctx.content ?? '',
      isOpinion,
      isIncrementalUpdate,
    });
  } catch (err) {
    throw new PipelineError(
      t('pipeline.extracting.compilation_failed', {
        message: errorMessage(err),
      }),
      'extractor',
      'unknown',
      err,
    );
  }
  const promptHash = computePromptHash(
    rawTemplate,
    systemTemplate,
    language,
    isOpinion ? 'opinion' : 'other',
    isIncrementalUpdate ? 'inc' : 'full',
  );

  let output: {
    points: Array<{ content: string; type: 'fact' | 'opinion'; tags?: string[] }>;
  };
  try {
    output = await deps.callLlm({
      step: 'extractor',
      schema: extractingSchema,
      system,
      prompt,
      promptHash,
      sourceId: ctx.source.id,
      llmCallRepo: deps.llmCallRepo,
      logPayloads: ctx.config.llmLogPayloads ?? false,
    });
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(
      t('pipeline.extracting.failed', {
        message: errorMessage(err),
      }),
      'extractor',
      'unknown',
      err,
    );
  }

  const points: IndexedPoint[] = output.points.map((p, i) => {
    // Only opinion points carry tags downstream — fact points stay tag-free
    // even if the LLM drifted and produced some, so storing.ts doesn't
    // accidentally write them. Canonicalization (trim / dedupe / case-fold)
    // is shared with the tags repo via `normalizeTags`.
    const tags = p.type === 'opinion' ? normalizeTags(p.tags) : [];
    return {
      pointKey: `kp:${i}`,
      content: p.content,
      type: p.type,
      ...(tags.length > 0 ? { tags } : {}),
    };
  });

  return { ...ctx, points };
}
