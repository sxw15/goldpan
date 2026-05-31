// apps/server/src/routes/debug.ts
import { parseId, type RouteContext, respond, respondError } from './types.js';

/**
 * Handle /debug/* routes.
 * Requires debugApiEnabled to be true.
 */
export async function handleDebugRoutes(ctx: RouteContext): Promise<void> {
  const { req, res, segments, handle } = ctx;
  const { repos } = handle;

  if (!ctx.debugApiEnabled) {
    req.resume();
    respondError(res, 404, 'not_found', 'Not found');
    return;
  }

  // GET /debug/tasks/:taskId
  if (req.method === 'GET' && segments[0] === 'tasks' && segments.length === 2) {
    req.resume();
    const taskId = parseId(segments[1]);
    if (taskId === null) {
      respondError(res, 400, 'invalid_id', 'Invalid task ID');
      return;
    }

    try {
      const task = repos.task.getById(taskId);
      if (!task) {
        respondError(res, 404, 'not_found', 'Task not found');
        return;
      }

      const logs = repos.taskLog.getByTaskId(taskId);
      const llmCalls = repos.llmCall.getMetadataBySourceId(task.sourceId);
      const eventLogs = repos.eventLog.getBySourceId(task.sourceId);
      const submissionLogs = repos.submissionLog.getByTaskId(taskId);
      const source = repos.source.getById(task.sourceId);

      respond(res, 200, {
        task: {
          id: task.id,
          sourceId: task.sourceId,
          status: task.status,
          pipelineStep: task.pipelineStep,
          inputType: task.inputType,
          errorMessage: task.errorMessage,
          errorKind: task.errorKind,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        },
        source: source
          ? {
              id: source.id,
              kind: source.kind === 'external' ? ('external' as const) : ('user' as const),
              title: source.title ?? null,
              originalUrl: source.originalUrl,
              normalizedUrl: source.normalizedUrl,
              status: source.status,
              origin: source.origin,
              rawContentPreview: source.rawContent ? source.rawContent.slice(0, 200) : null,
            }
          : null,
        logs,
        llmCalls,
        eventLogs,
        submissionLogs,
      });
    } catch (err) {
      handle.logger.error(`GET /debug/tasks/${taskId} failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  // GET /debug/llm-calls/:callId
  if (req.method === 'GET' && segments[0] === 'llm-calls' && segments.length === 2) {
    req.resume();
    const callId = parseId(segments[1]);
    if (callId === null) {
      respondError(res, 400, 'invalid_id', 'Invalid call ID');
      return;
    }

    try {
      const call = repos.llmCall.getById(callId);
      if (!call) {
        respondError(res, 404, 'not_found', 'LLM call not found');
        return;
      }

      respond(res, 200, {
        requestBody: call.requestBody,
        responseBody: call.responseBody,
        requestSchema: call.requestSchema,
      });
    } catch (err) {
      handle.logger.error(`GET /debug/llm-calls/${callId} failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  req.resume();
  respondError(res, 404, 'not_found', 'Not found');
}
