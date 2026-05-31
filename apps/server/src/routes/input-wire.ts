import type { HandleInputResult, InputErrorCode } from '@goldpan/core/input';

const CLIENT_ERROR_CODE_MAP: Record<InputErrorCode, true> = {
  input_empty: true,
  text_too_long: true,
  query_too_long: true,
  input_too_long_for_intent: true,
  unknown_intent: true,
  intent_failed: true,
  plugin_error: true,
  submit_failed: true,
  query_failed: true,
};
const CLIENT_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(CLIENT_ERROR_CODE_MAP));

// Centralized so /submit, /input, and buffered release cannot drift on the
// accepted / duplicate / rejected HTTP and JSON contract.
export function submitStatusToHttp(status: 'accepted' | 'duplicate' | 'rejected'): number {
  switch (status) {
    case 'accepted':
      return 201;
    case 'duplicate':
      return 409;
    case 'rejected':
      return 400;
  }
}

export function serializeHandleInputResult(result: HandleInputResult): {
  statusCode: number;
  responseBody: Record<string, unknown>;
} {
  let statusCode = 200;
  let responseBody: Record<string, unknown> = {};

  switch (result.type) {
    case 'submit': {
      const sr = result.result;
      statusCode = submitStatusToHttp(sr.status);
      responseBody = {
        type: 'submit',
        status: sr.status,
        ...(sr.status === 'accepted' && {
          taskId: sr.taskId,
          warnings: sr.warnings,
          ...(sr.inputMode !== undefined && { inputMode: sr.inputMode }),
        }),
        ...(sr.status === 'duplicate' && {
          message: 'Duplicate URL',
          existingSourceId: sr.existingSourceId,
          existingTaskId: sr.existingTaskId,
          existingUrl: sr.existingUrl,
        }),
        ...(sr.status === 'rejected' && { code: sr.code, reason: sr.reason }),
      };
      break;
    }
    case 'query':
      responseBody = {
        type: 'query',
        query: result.query,
        answer: result.result.answer,
        confidence: result.result.confidence,
        citedEntityIds: result.result.citedEntityIds,
        citedPointIds: result.result.citedPointIds,
        citedEntities: result.citedEntities ?? [],
      };
      break;
    case 'content':
      responseBody = {
        type: 'content',
        text: result.text,
        ...(result.format && { format: result.format }),
        ...(result.title && { title: result.title }),
      };
      break;
    case 'action':
      responseBody = {
        type: 'action',
        message: result.message,
        ...(result.actionId && { actionId: result.actionId }),
      };
      break;
    case 'clarify':
      responseBody = {
        type: 'clarify',
        ...(result.question !== undefined && { question: result.question }),
        ...(result.options !== undefined && { options: result.options }),
        ...(result.questionKey !== undefined && { questionKey: result.questionKey }),
        ...(result.structuredOptions !== undefined && {
          structuredOptions: result.structuredOptions,
        }),
      };
      break;
    case 'wait':
      responseBody = {
        type: 'wait',
        bufferedMessageId: result.bufferedMessageId,
        expiresAt: result.expiresAt,
        fallbackIntent: result.fallbackIntent,
        maxWaitMs: result.maxWaitMs,
        waitReasonKey: result.waitReasonKey,
      };
      break;
    case 'note':
      responseBody = {
        type: 'note',
        note: {
          id: result.detail.id,
          content: result.detail.content,
          subtype: result.detail.subtype,
          tags: result.detail.tags,
          linkedEntities: result.detail.linkedEntities,
          linkedSources: result.detail.linkedSources,
          createdAt: result.detail.createdAt,
        },
      };
      break;
    case 'tracking_pending':
      responseBody = {
        type: 'tracking_pending',
        trackingRuleId: result.trackingRuleId,
        reasonKey: result.reasonKey,
      };
      break;
    case 'error':
      statusCode = CLIENT_ERROR_CODES.has(result.code) ? 400 : 500;
      responseBody = { type: 'error', code: result.code, message: 'Processing failed' };
      break;
  }

  return { statusCode, responseBody };
}
