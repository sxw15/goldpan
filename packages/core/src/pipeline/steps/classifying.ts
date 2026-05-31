import type {
  CategoryRepository,
  LlmCallRepository,
  TaskRepository,
} from '../../db/repositories/types';
import { errorMessage } from '../../errors';
import { t } from '../../i18n/index';
import { compilePrompt, computePromptHash, loadPromptTemplate } from '../../prompts/loader';
import {
  type CallLlmFn,
  type PipelineContext,
  PipelineError,
  type TextClassification,
  textClassificationSchema,
  type UrlClassification,
  urlClassificationSchema,
} from '../types';

export interface ClassifyingDeps {
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
  categoryRepo: CategoryRepository;
  taskRepo: TaskRepository;
}

export async function executeClassifying(
  ctx: PipelineContext,
  deps: ClassifyingDeps,
): Promise<PipelineContext> {
  if (!ctx.content) {
    throw new PipelineError(t('pipeline.classifying.no_content'), 'classifying', 'unknown');
  }

  const isUrl = ctx.inputType === 'url';
  const schema = isUrl ? urlClassificationSchema : textClassificationSchema;

  // Load category tree for prompt injection
  const categories = deps.categoryRepo.getAll();
  const categoryTree =
    categories.length > 0
      ? categories.map((c) => c.path).join('\n')
      : '(Empty tree — please create initial structure following classification guidelines)';

  // Build prompts using Phase 2 prompt template utilities
  const language = ctx.config.language;
  const rawTemplate = loadPromptTemplate('classifier', language);
  const systemTemplate = loadPromptTemplate('classifier-system', language);
  const system = compilePrompt(systemTemplate, { isUrl });
  let prompt: string;
  try {
    prompt = compilePrompt(rawTemplate, {
      categoryTree,
      content: ctx.content ?? '',
      hasTree: categories.length > 0,
      isUrl,
    });
  } catch (err) {
    throw new PipelineError(
      t('pipeline.classifying.compilation_failed', {
        message: errorMessage(err),
      }),
      'classifier',
      'unknown',
      err,
    );
  }
  const promptHash = computePromptHash(
    rawTemplate,
    systemTemplate,
    language,
    isUrl ? 'url' : 'text',
  );

  let output: UrlClassification | TextClassification;
  try {
    output = await deps.callLlm({
      step: 'classifier',
      schema,
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
      t('pipeline.classifying.failed', {
        message: errorMessage(err),
      }),
      'classifier',
      'unknown',
      err,
    );
  }

  // Determine inputType. An explicit `opinion` was set by submit (the
  // `record_thought` intent locks the type at submission time) and must
  // survive classification — otherwise the LLM's text/opinion verdict can
  // demote a user-marked thought back to `text` and skip the opinion-only
  // extraction path. Other `ctx.inputType` values (null on plain text
  // submits, or a stale value cleared by retry) still let the classifier
  // drive the verdict.
  let resolvedInputType = ctx.inputType;
  if (!isUrl && 'inputType' in output && ctx.inputType !== 'opinion') {
    resolvedInputType = (output as TextClassification).inputType;
    deps.taskRepo.updateInputType(ctx.task.id, resolvedInputType);
  }

  return {
    ...ctx,
    inputType: resolvedInputType,
    classification: {
      categoryPath: output.categoryPath,
      keywords: output.keywords,
    },
  };
}
