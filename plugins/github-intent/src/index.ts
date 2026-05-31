import type {
  IntentDeclaration,
  IntentExecutionContext,
  IntentPlugin,
  IntentPluginResult,
  PluginContext,
  ServiceCallLlmFn,
  ServiceCapabilities,
} from '@goldpan/core/plugins';
import type { GithubService } from '@goldpan/plugin-github-collector';
import { createTranslator, type SupportedLanguage } from './i18n/loader.js';
import { handleRefreshGithub, type IntentHandlerResult } from './intent-handler.js';
import { loadPluginPrompt } from './prompt-loader.js';

const intents: IntentDeclaration[] = [
  {
    name: 'refresh_github',
    description:
      'Re-analyze a known GitHub repository for new commits, releases, and README changes',
    descriptions: {
      zh: '对已分析过的 GitHub 仓库做增量分析（新的 commits / releases / README 变更）',
    },
    examples: [
      '刷新 facebook/react',
      'refresh facebook/react',
      '看看 facebook/react 最近的进展',
      '重新分析 vercel/next.js',
      'reanalyze vercel/next.js',
      '更新一下 vuejs/core 的状态',
    ],
    classificationHints: [
      'If the user mentions a specific GitHub `owner/repo` (or "github.com/owner/repo") and wants to see what is NEW (commits/releases/README), choose `refresh_github`. This is for ONE-SHOT incremental analysis of an already-known repo.',
      'If the user wants to set up RECURRING/AUTOMATIC monitoring of a topic via keyword search, choose `manage_tracking` instead.',
    ],
    resultTypes: ['action', 'clarify', 'content'],
    priority: 0,
  },
];

let service: GithubService | undefined;
let callLlmFn: ServiceCallLlmFn | undefined;

function toPluginResult(result: IntentHandlerResult): IntentPluginResult {
  switch (result.type) {
    case 'action':
      return { type: 'action', message: result.message };
    case 'content':
      return { type: 'content', text: result.text, format: result.format };
    case 'clarify':
      return { type: 'clarify', question: result.question };
  }
}

export const goldpanPlugin: IntentPlugin = {
  name: 'github-intent',
  version: '0.1.0',
  type: 'intent',
  description: 'Refresh known GitHub repositories on demand',
  descriptions: { zh: '按需刷新已知的 GitHub 仓库' },
  requiredCapabilities: ['pluginRegistry', 'callLlm'],
  intents,

  async initialize(_ctx: PluginContext, capabilities?: Partial<ServiceCapabilities>) {
    const pluginRegistry = capabilities?.pluginRegistry;
    const callLlm = capabilities?.callLlm;
    if (!pluginRegistry || !callLlm) {
      throw new Error('github-intent requires pluginRegistry + callLlm capabilities');
    }
    const svc = pluginRegistry.getService<GithubService>('github');
    if (!svc) {
      throw new Error(
        'GithubService not registered. Ensure @goldpan/plugin-github-collector is installed and loaded before @goldpan/plugin-github-intent.',
      );
    }
    service = svc;
    callLlmFn = callLlm;
    loadPluginPrompt('github_action_parser', true);
    loadPluginPrompt('github_action_parser', false);
  },

  async destroy() {
    service = undefined;
    callLlmFn = undefined;
  },

  async execute(
    intent: string,
    input: string,
    context: IntentExecutionContext,
    signal?: AbortSignal,
  ): Promise<IntentPluginResult> {
    if (!service || !callLlmFn) throw new Error('github-intent plugin not initialized');
    if (intent !== 'refresh_github') {
      throw new Error(`Unknown github-intent intent: ${intent}`);
    }
    const t = createTranslator(context.language as SupportedLanguage);
    const result = await handleRefreshGithub(input, service, callLlmFn, t, signal);
    return toPluginResult(result);
  },
};
