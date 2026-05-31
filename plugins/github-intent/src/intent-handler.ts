import type { ServiceCallLlmFn } from '@goldpan/core/plugins';
import type { GithubService } from '@goldpan/plugin-github-collector';
import { z } from 'zod';
import type { Translator } from './i18n/loader.js';
import { compilePluginPrompt, computePluginPromptHash, loadPluginPrompt } from './prompt-loader.js';

const OWNER_REPO_RE =
  /(?:^|\s|@)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)(?=\s|$|[,;!?，。；！？])/;

const githubActionSchema = z.union([
  z.object({ owner: z.string(), repo: z.string() }),
  z.object({ error: z.string() }),
]);

export type IntentHandlerResult =
  | { type: 'action'; message: string }
  | { type: 'clarify'; question: string }
  | { type: 'content'; text: string; format?: 'markdown' | 'text' };

export async function handleRefreshGithub(
  input: string,
  service: GithubService,
  callLlm: ServiceCallLlmFn,
  t: Translator,
  signal?: AbortSignal,
): Promise<IntentHandlerResult> {
  // intent does NOT lowercase — buildNormalizedUrl in the service is the single
  // central lowercase point (spec F1).
  let owner: string;
  let repo: string;

  const match = input.match(OWNER_REPO_RE);
  if (match) {
    owner = match[1];
    repo = match[2];
  } else {
    const system = loadPluginPrompt('github_action_parser', true);
    const userTemplate = loadPluginPrompt('github_action_parser', false);
    const prompt = compilePluginPrompt(userTemplate, { input });
    const promptHash = computePluginPromptHash(system, prompt);
    const parsed = await callLlm({
      step: 'github_action_parser',
      schema: githubActionSchema,
      system,
      prompt,
      promptHash,
      signal,
    });
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }
    if ('error' in parsed) {
      return { type: 'clarify', question: t('github.refresh.parser_failed') };
    }
    owner = parsed.owner;
    repo = parsed.repo;
  }

  const result = await service.refreshRepo({ owner, repo });
  switch (result.status) {
    case 'started':
      return { type: 'action', message: t('github.refresh.started', { owner, repo }) };
    case 'in_progress':
      return { type: 'action', message: t('github.refresh.in_progress', { owner, repo }) };
    case 'too_recent':
      return {
        type: 'action',
        message: t('github.refresh.too_recent', {
          owner,
          repo,
          seconds: result.retryAfterSeconds,
        }),
      };
    case 'rate_limited':
      return {
        type: 'action',
        // ISO-8601 UTC: deterministic + locale/timezone-independent. A bare
        // toLocaleString() would render in the SERVER's locale+tz, which is
        // neither the user's GOLDPAN_LANGUAGE nor their timezone and varies by
        // deployment. (This arm is not reachable from the current sync refresh
        // path — GithubService never returns 'rate_limited' — but it's part of
        // the public RefreshResult contract, so keep it correct.)
        message: t('github.refresh.rate_limited', {
          owner,
          repo,
          resetsAt: new Date(result.resetsAt).toISOString(),
        }),
      };
    case 'not_found':
      return { type: 'action', message: t('github.refresh.not_found', { owner, repo }) };
    case 'archived':
      return {
        type: 'action',
        message: t('github.refresh.archived', { owner, repo }),
      };
  }
}
