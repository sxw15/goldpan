import type { ServiceCallLlmFn } from '@goldpan/core/plugins';
import { z } from 'zod';
import { msg } from './messages.js';
import { compilePluginPrompt, computePluginPromptHash, loadPluginPrompt } from './prompt-loader.js';
import type { TrackingService, TrackingServiceError } from './types.js';

const trackingActionSchema = z.object({
  action: z.enum(['create', 'update', 'delete', 'enable', 'disable', 'list', 'clarify']),
  name: z.string().optional(),
  searchQueries: z.array(z.string()).optional(),
  interestId: z.number().optional(),
  intervalMinutes: z.number().optional(),
  toolProvider: z.string().optional(),
  question: z.string().optional(),
});

type TrackingAction = z.infer<typeof trackingActionSchema>;

export interface IntentHandlerResult {
  type: 'action' | 'content' | 'clarify';
  message?: string;
  text?: string;
  format?: 'text' | 'markdown';
  question?: string;
  options?: string[];
}

/**
 * Optional knobs for `handleManageTracking`. `forceAction` lets the P2
 * `create_tracking` path-B fallback reuse this LLM-driven entity extraction
 * flow without risk of the LLM picking a destructive action (delete/disable)
 * — when set, the LLM-classified action is overwritten before dispatch.
 *
 * Used only by `create-tracking-handler.ts` (path B). Keep this single-knob
 * shape rather than expanding the positional args — additional flags would
 * compound the call-site readability cost.
 */
export interface ManageTrackingOptions {
  /** Force the dispatched action regardless of LLM classification. */
  forceAction?: 'create';
}

export async function handleManageTracking(
  input: string,
  service: TrackingService,
  callLlm: ServiceCallLlmFn,
  signal?: AbortSignal,
  options?: ManageTrackingOptions,
): Promise<IntentHandlerResult> {
  // 1. Load prompts
  const systemTemplate = loadPluginPrompt('tracking_action_parser', true);
  const userTemplate = loadPluginPrompt('tracking_action_parser', false);

  // 2. Build template vars — get existing interests for context
  const interests = service.getInterests();
  const existingInterests = interests.map((i) => ({
    id: i.id,
    name: i.name,
    searchQueries: i.searchQueries.join(', '),
    enabled: i.enabled,
  }));

  const system = systemTemplate; // system prompt has no variables
  const prompt = compilePluginPrompt(userTemplate, { input, existingInterests });
  const promptHash = computePluginPromptHash(system, prompt);

  // 3. Call LLM
  const action = await callLlm({
    step: 'tracking_action_parser',
    schema: trackingActionSchema,
    system,
    prompt,
    promptHash,
    signal,
  });

  // 4. Bail out if cancelled between LLM response and side-effecting dispatch
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }

  // 5. Force action override (path-B fallback from create_tracking handler).
  //    The LLM might classify a "track Anthropic" utterance as `list` /
  //    `delete` when the prompt context confuses it; for create_tracking we
  //    know the user explicitly asked to *create*, so we pin the action and
  //    let the LLM's extracted name/searchQueries flow through.
  const finalAction =
    options?.forceAction !== undefined ? { ...action, action: options.forceAction } : action;

  // 6. Dispatch action
  return dispatchAction(finalAction, service);
}

function dispatchAction(action: TrackingAction, service: TrackingService): IntentHandlerResult {
  try {
    switch (action.action) {
      case 'create': {
        if (!action.name || !action.searchQueries?.length) {
          return {
            type: 'clarify',
            question: 'Please provide a name and search queries for the interest.',
          };
        }
        const interest = service.createInterest({
          name: action.name,
          searchQueries: action.searchQueries,
          toolProvider: action.toolProvider,
          intervalMinutes: action.intervalMinutes,
        });
        return { type: 'action', message: msg().interest_created(interest.name) };
      }
      case 'update': {
        if (!action.interestId) {
          return {
            type: 'clarify',
            question: 'Which interest do you want to update? Please provide the interest number.',
          };
        }
        service.updateInterest(action.interestId, {
          name: action.name,
          searchQueries: action.searchQueries,
          toolProvider: action.toolProvider,
          intervalMinutes: action.intervalMinutes,
        });
        return { type: 'action', message: msg().interest_updated(action.interestId) };
      }
      case 'delete': {
        if (!action.interestId) {
          return {
            type: 'clarify',
            question: 'Which interest do you want to delete? Please provide the interest number.',
          };
        }
        service.deleteInterest(action.interestId);
        return { type: 'action', message: msg().interest_deleted(action.interestId) };
      }
      case 'enable': {
        if (!action.interestId) {
          return { type: 'clarify', question: 'Which interest do you want to enable?' };
        }
        service.enableInterest(action.interestId);
        return { type: 'action', message: msg().interest_enabled(action.interestId) };
      }
      case 'disable': {
        if (!action.interestId) {
          return { type: 'clarify', question: 'Which interest do you want to disable?' };
        }
        service.disableInterest(action.interestId);
        return { type: 'action', message: msg().interest_disabled(action.interestId) };
      }
      case 'list': {
        return formatInterestList(service);
      }
      case 'clarify': {
        return { type: 'clarify', question: action.question ?? 'Could you clarify your request?' };
      }
      default:
        return {
          type: 'clarify',
          question: 'I could not understand your request. Please try again.',
        };
    }
  } catch (error) {
    if (isTrackingServiceError(error)) {
      return { type: 'action', message: error.message };
    }
    throw error;
  }
}

function isTrackingServiceError(error: unknown): error is TrackingServiceError {
  return error instanceof Error && error.name === 'TrackingServiceError';
}

function formatInterestList(service: TrackingService): IntentHandlerResult {
  const interests = service.getInterests();
  if (interests.length === 0) {
    return { type: 'content', text: msg().interest_list_empty, format: 'text' };
  }

  const lines = [
    '| # | Name | Search Queries | Interval | Status |',
    '|---|------|----------------|----------|--------|',
  ];
  for (const i of interests) {
    const status = i.enabled ? '✅ Active' : '⏸ Disabled';
    lines.push(
      `| ${i.id} | ${i.name} | ${i.searchQueries.join(', ')} | ${i.intervalMinutes}m | ${status} |`,
    );
  }
  return { type: 'content', text: lines.join('\n'), format: 'markdown' };
}

export async function handleCheckTracking(service: TrackingService): Promise<IntentHandlerResult> {
  const interests = service.getInterests();
  if (interests.length === 0) {
    return { type: 'content', text: msg().interest_list_empty, format: 'text' };
  }

  const lines: string[] = ['## Tracking Status\n'];
  lines.push('| # | Name | Search Queries | Last Run | Next Run | Status |');
  lines.push('|---|------|----------------|----------|----------|--------|');

  for (const i of interests) {
    const status = i.enabled
      ? i.status === 'executing'
        ? '🔄 Running'
        : '✅ Active'
      : '⏸ Disabled';
    const lastRun = i.lastRunAt ?? 'Never';
    const nextRun = i.nextRunAt ?? '—';
    lines.push(
      `| ${i.id} | ${i.name} | ${i.searchQueries.join(', ')} | ${lastRun} | ${nextRun} | ${status} |`,
    );
  }

  return { type: 'content', text: lines.join('\n'), format: 'markdown' };
}
