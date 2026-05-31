import type { LlmCallRepository } from '../../db/repositories/types';
import { errorMessage } from '../../errors';
import { t } from '../../i18n/index';
import { LANGUAGE_LABEL } from '../../i18n/labels';
import { compilePrompt, computePromptHash, loadPromptTemplate } from '../../prompts/loader';
import {
  type CallLlmFn,
  type PipelineContext,
  type TranslationItemKind,
  type TranslationItemMap,
  translatingSchema,
} from '../types';

export interface TranslatingDeps {
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
  logger?: { warn(msg: string, ...args: unknown[]): void };
}

/**
 * Optional pipeline step that translates pipeline-produced natural-language
 * outputs (fact/opinion content, entity description, relation description,
 * verifier rejection reason, comparator summary) into the configured
 * `GOLDPAN_LANGUAGE`. Original text stays untouched in DB; translations are
 * written into `*_translated` columns by the storing step.
 *
 * Failure is non-fatal: on any error the pipeline carries on with empty
 * translations, originals stand in for the translated copies, and a warning
 * is appended to `validationWarnings`.
 */
export async function executeTranslating(
  ctx: PipelineContext,
  deps: TranslatingDeps,
): Promise<PipelineContext> {
  if (!ctx.config.translation.translatePipelineOutput) {
    return { ...ctx, translations: {} };
  }

  const items = collectTranslatableItems(ctx);
  if (items.length === 0) {
    return { ...ctx, translations: {} };
  }

  const language = ctx.config.language;
  const targetLanguageLabel = LANGUAGE_LABEL[language];

  try {
    const systemTemplate = loadPromptTemplate('translator-system', language);
    const userTemplate = loadPromptTemplate('translator', language);
    const system = compilePrompt(systemTemplate, {});
    const prompt = compilePrompt(userTemplate, {
      targetLanguageLabel,
      items: items.map((it) => ({ id: it.id, kind: it.kind, text: it.text })),
    });
    const promptHash = computePromptHash(
      userTemplate,
      systemTemplate,
      language,
      `n=${items.length}`,
    );

    const output = await deps.callLlm({
      step: 'translator',
      schema: translatingSchema,
      system,
      prompt,
      promptHash,
      sourceId: ctx.source.id,
      llmCallRepo: deps.llmCallRepo,
      logPayloads: ctx.config.llmLogPayloads ?? false,
    });

    const translations: TranslationItemMap = {};
    const known = new Map(items.map((it) => [it.id, it]));
    const warnings = [...ctx.validationWarnings];

    for (const row of output.translations) {
      const trimmed = row.translated.trim();
      if (!trimmed) continue;
      // Drop ids the LLM hallucinated (not in the request) — defensive against drift.
      if (!known.has(row.id)) continue;
      translations[row.id] = trimmed;
    }

    for (const it of items) {
      if (!(it.id in translations)) {
        warnings.push(t('pipeline.translating.missing_translation', { id: it.id }));
      }
    }

    return { ...ctx, translations, validationWarnings: warnings };
  } catch (err) {
    deps.logger?.warn('Translator degraded — keeping originals', {
      taskId: ctx.task.id,
      sourceId: ctx.source.id,
      error: errorMessage(err),
    });
    return {
      ...ctx,
      translations: {},
      validationWarnings: [
        ...ctx.validationWarnings,
        t('pipeline.translating.degraded', { message: errorMessage(err) }),
      ],
    };
  }
}

interface TranslationRequestItem {
  id: string;
  kind: TranslationItemKind;
  text: string;
}

function collectTranslatableItems(ctx: PipelineContext): TranslationRequestItem[] {
  const items: TranslationRequestItem[] = [];
  const seen = new Set<string>();
  const push = (id: string, kind: TranslationItemKind, text: string | null | undefined) => {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return;
    if (seen.has(id)) return;
    seen.add(id);
    items.push({ id, kind, text: trimmed });
  };

  const rejectedKeys = new Set(ctx.verifierRejections.map((r) => r.pointKey));
  const valid = ctx.validationResult;

  for (const ej of valid?.validEntities ?? []) {
    for (const pj of ej.pointJudgments) {
      if (pj.judgment !== 'new') continue;
      if (rejectedKeys.has(pj.pointKey)) continue;
      const point = ctx.points.find((p) => p.pointKey === pj.pointKey);
      if (!point) continue;
      const kind: TranslationItemKind = point.type === 'fact' ? 'fact' : 'opinion';
      push(`p:${pj.pointKey}`, kind, point.content);
    }

    if (ej.entityKey.startsWith('draft:') && ej.description) {
      push(`ed:${ej.entityKey}`, 'entityDescription', ej.description);
    }

    if (ej.summary) {
      push(`s:${ej.entityKey}`, 'summary', ej.summary);
    }
  }

  for (const rel of valid?.validRelations ?? []) {
    const id = `r:${rel.sourceEntityKey}>${rel.targetEntityKey}:${rel.relationType}`;
    push(id, 'relationDescription', rel.description);
  }

  for (const rej of ctx.verifierRejections) {
    push(`vr:${rej.pointKey}`, 'rejectionReason', rej.reason);
  }

  return items;
}
