import type { JsonObject, SourceRepository } from '../../db/repositories/types';
import { errorMessage, type PipelineErrorKind } from '../../errors';
import { t } from '../../i18n/index';
import { runWithCollectDiagnostics } from '../../plugins/collect-diagnostics';
import { CollectorError, type CollectorErrorCode } from '../../plugins/errors';
import type { CollectorResult } from '../../plugins/types';
import { type PipelineContext, PipelineError } from '../types';

/**
 * Map a collector's semantic error code to a pipeline errorKind so failures
 * carry an accurate kind (drives the UI label + retryability) instead of a
 * blanket `unknown`. Codes without a dedicated kind fall back to `unknown` —
 * the error message still surfaces the detail.
 */
const COLLECTOR_CODE_TO_ERROR_KIND: Partial<Record<CollectorErrorCode, PipelineErrorKind>> = {
  NOT_FOUND: 'not_found',
  RATE_LIMIT: 'rate_limit',
  TIMEOUT: 'timeout',
};

function collectorErrorKind(err: unknown): PipelineErrorKind {
  return err instanceof CollectorError
    ? (COLLECTOR_CODE_TO_ERROR_KIND[err.code] ?? 'unknown')
    : 'unknown';
}

export interface CollectingDeps {
  sourceRepo: SourceRepository;
  pluginRegistry: {
    getCollector(url: string): Promise<{ collect: () => Promise<CollectorResult> } | undefined>;
  };
}

export async function executeCollecting(
  ctx: PipelineContext,
  deps: CollectingDeps,
): Promise<PipelineContext> {
  // Skip collecting for non-URL inputs — content comes from source.rawContent
  if (ctx.inputType !== 'url') {
    const content = (ctx.source.rawContent ?? '').trim();
    if (content.length < ctx.config.minContentLength) {
      throw new PipelineError(
        t('pipeline.collecting.content_too_short'),
        'content_validation',
        'content_length',
      );
    }
    if (content.length > ctx.config.maxTextInputLength) {
      throw new PipelineError(
        t('pipeline.collecting.input_too_long', {
          length: content.length,
          limit: ctx.config.maxTextInputLength,
        }),
        'content_validation',
        'content_length',
      );
    }
    return {
      ...ctx,
      content,
    };
  }

  // Use originalUrl for actual HTTP fetch (normalizedUrl may have http→https, www removal
  // that breaks reachability). normalizedUrl is for dedup only.
  const url = ctx.source.originalUrl ?? ctx.source.normalizedUrl;
  if (!url) {
    throw new PipelineError(t('pipeline.collecting.url_missing'), 'collecting', 'unknown');
  }

  // Call collector via PluginRegistry
  const collector = await deps.pluginRegistry.getCollector(url);
  if (!collector) {
    throw new PipelineError(
      t('pipeline.collecting.no_collector', { url }),
      'collecting',
      'unknown',
    );
  }
  const collectingDiagnostics: string[] = [];
  let result: CollectorResult;
  try {
    result = await runWithCollectDiagnostics(
      (line) => collectingDiagnostics.push(line),
      () => collector.collect(),
    );
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(
      t('pipeline.collecting.collection_failed', {
        message: errorMessage(err),
      }),
      'collecting',
      collectorErrorKind(err),
      err,
    );
  }

  const trimmedContent = result.content.trim();

  // Content length validation (wrapped to ensure errors surface as PipelineError)
  try {
    if (trimmedContent.length < ctx.config.minContentLength) {
      throw new PipelineError(
        t('pipeline.collecting.content_too_short'),
        'content_validation',
        'content_length',
      );
    }

    if (trimmedContent.length > ctx.config.maxContentLength) {
      throw new PipelineError(
        t('pipeline.collecting.content_too_long', {
          length: trimmedContent.length,
          limit: ctx.config.maxContentLength,
        }),
        'content_validation',
        'content_length',
      );
    }
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(
      t('pipeline.collecting.validation_failed', {
        message: errorMessage(err),
      }),
      'content_validation',
      'unknown',
      err,
    );
  }

  // Update source with collected content
  deps.sourceRepo.updateAfterCollecting(ctx.source.id, {
    title: result.title ?? undefined,
    rawContent: result.content,
    collectorMetadata: result.metadata as JsonObject,
  });

  const collectorPluginName =
    typeof result.metadata?.collectorPlugin === 'string' ? result.metadata.collectorPlugin : null;

  const collectorBrowserEngine =
    typeof result.metadata?.collector_browserEngine === 'string'
      ? result.metadata.collector_browserEngine
      : null;
  const collectorBrowserEngineLabel =
    typeof result.metadata?.collector_browserEngineLabel === 'string'
      ? result.metadata.collector_browserEngineLabel
      : null;

  const rawUpdateMode = (result.metadata as JsonObject | null | undefined)?.collector_update_mode;
  const updateMode: 'initial' | 'incremental' | null =
    rawUpdateMode === 'initial' || rawUpdateMode === 'incremental' ? rawUpdateMode : null;

  return {
    ...ctx,
    content: trimmedContent,
    collectorPluginName,
    collectorBrowserEngine,
    collectorBrowserEngineLabel,
    collectingDiagnostics: collectingDiagnostics.length > 0 ? collectingDiagnostics : undefined,
    collectorMetadata: (result.metadata as JsonObject | null) ?? null,
    updateMode,
    source: {
      ...ctx.source,
      rawContent: result.content,
      title: result.title ?? ctx.source.title,
    },
  };
}
