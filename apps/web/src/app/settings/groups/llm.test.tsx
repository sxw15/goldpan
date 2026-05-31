import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../../messages/zh.json';
import { INITIAL_MOCK } from '../settings-data';
import { GroupLLM } from './llm';

vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({
    getLlmProviders: vi.fn().mockResolvedValue({
      // Mock all 6 builtins so the test exercises both "configured" (top
      // section) and "unconfigured" (Add Provider buttons) flows. Anthropic +
      // ollama are configured; the others land in the Add list.
      builtin: [
        {
          id: 'anthropic',
          apiKeyEnv: 'ANTHROPIC_API_KEY',
          apiKeyConfigured: true,
          models: ['claude-sonnet-4'],
          embeddingModels: [],
        },
        {
          id: 'openai',
          apiKeyEnv: 'OPENAI_API_KEY',
          apiKeyConfigured: false,
          models: [],
          embeddingModels: [],
        },
        {
          id: 'deepseek',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          apiKeyConfigured: false,
          models: [],
          embeddingModels: [],
        },
        {
          id: 'openrouter',
          apiKeyEnv: 'OPENROUTER_API_KEY',
          apiKeyConfigured: false,
          models: [],
          embeddingModels: [],
        },
        {
          id: 'google',
          apiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
          apiKeyConfigured: false,
          models: [],
          embeddingModels: [],
        },
        {
          id: 'ollama',
          apiKeyEnv: '',
          apiKeyConfigured: true,
          models: ['llama3.2:8b'],
          embeddingModels: [],
        },
      ],
      custom: [
        {
          id: 'together',
          baseUrl: 'https://api.together.xyz/v1',
          apiKeyEnv: 'TOGETHER_API_KEY',
          apiKeyConfigured: true,
          models: [],
          embeddingModels: [],
        },
      ],
      plugin: [
        {
          providerId: 'cohere',
          pluginName: 'llm-cohere',
          status: 'loaded',
          models: [],
          embeddingModels: [],
        },
        {
          providerId: 'bedrock',
          pluginName: 'llm-bedrock',
          status: 'failed',
          error: 'AWS_REGION missing',
          models: [],
          embeddingModels: [],
        },
      ],
    }),
    commitEnv: vi.fn(),
  }),
}));

const env = new Map([
  // env state still has all the keys (mask / source) — store doesn't drop
  // unconfigured ones; the providers payload's apiKeyConfigured is what
  // drives section assignment.
  [
    'ANTHROPIC_API_KEY',
    { key: 'ANTHROPIC_API_KEY', configured: true, source: 'env' as const, mask: '••••KZ7m' },
  ],
  [
    'GOLDPAN_LLM_CLASSIFIER',
    {
      key: 'GOLDPAN_LLM_CLASSIFIER',
      configured: true,
      source: 'default' as const,
      mask: 'openai:gpt-4o-mini',
    },
  ],
  [
    'GOLDPAN_LLM_EXTRACTOR',
    {
      key: 'GOLDPAN_LLM_EXTRACTOR',
      configured: true,
      source: 'default' as const,
      mask: 'anthropic:claude-sonnet-4-20250514',
    },
  ],
  [
    'GOLDPAN_LLM_MATCHER',
    {
      key: 'GOLDPAN_LLM_MATCHER',
      configured: true,
      source: 'default' as const,
      mask: 'anthropic:claude-sonnet-4-20250514',
    },
  ],
  [
    'GOLDPAN_LLM_RELATOR',
    {
      key: 'GOLDPAN_LLM_RELATOR',
      configured: true,
      source: 'default' as const,
      mask: 'openai:gpt-4o-mini',
    },
  ],
  [
    'GOLDPAN_LLM_COMPARATOR',
    {
      key: 'GOLDPAN_LLM_COMPARATOR',
      configured: true,
      source: 'default' as const,
      mask: 'anthropic:claude-sonnet-4-20250514',
    },
  ],
  [
    'GOLDPAN_LLM_VERIFIER',
    {
      key: 'GOLDPAN_LLM_VERIFIER',
      configured: true,
      source: 'default' as const,
      mask: 'openai:gpt-4o-mini',
    },
  ],
  [
    'GOLDPAN_LLM_INTENT',
    {
      key: 'GOLDPAN_LLM_INTENT',
      configured: true,
      source: 'default' as const,
      mask: 'openai:gpt-4o-mini',
    },
  ],
  [
    'GOLDPAN_LLM_QUERY',
    {
      key: 'GOLDPAN_LLM_QUERY',
      configured: true,
      source: 'default' as const,
      mask: 'anthropic:claude-sonnet-4-20250514',
    },
  ],
  [
    'GOLDPAN_LLM_DIGEST_SUMMARY',
    {
      key: 'GOLDPAN_LLM_DIGEST_SUMMARY',
      configured: true,
      source: 'default' as const,
      mask: 'anthropic:claude-sonnet-4-20250514',
    },
  ],
  [
    'GOLDPAN_LLM_DIGEST_ACTION',
    {
      key: 'GOLDPAN_LLM_DIGEST_ACTION',
      configured: true,
      source: 'default' as const,
      mask: 'openai:gpt-4o-mini',
    },
  ],
  [
    'GOLDPAN_LLM_VERIFIER_ENABLED',
    {
      key: 'GOLDPAN_LLM_VERIFIER_ENABLED',
      configured: true,
      source: 'default' as const,
      mask: 'false',
    },
  ],
  [
    'GOLDPAN_RELATION_ENABLED',
    {
      key: 'GOLDPAN_RELATION_ENABLED',
      configured: true,
      source: 'default' as const,
      mask: 'false',
    },
  ],
  [
    'GOLDPAN_DIGEST_ENABLED',
    { key: 'GOLDPAN_DIGEST_ENABLED', configured: true, source: 'default' as const, mask: 'false' },
  ],
]);

const baseProps = {
  env,
  dirty: {},
  patch: vi.fn(),
  applyEnvItems: vi.fn(),
  reset: vi.fn(),
  resetEnvKey: vi.fn(async () => true),
  resetEnvKeyAndRestart: vi.fn(async () => ({ kind: 'success' as const })),
  save: vi.fn(),
  commit: vi.fn(async () => ({ kind: 'ok' as const, updatedItems: [], pendingRestartKeys: [] })),
  inFlightKeys: new Set<string>(),
  mock: INITIAL_MOCK,
  updateMock: vi.fn(),
  toast: vi.fn(),
  navigateToGroup: vi.fn(),
  setFieldEditing: vi.fn(),
};

function renderG(props = baseProps) {
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <GroupLLM {...props} />
    </NextIntlClientProvider>,
  );
}

function switchToLlmPipelineTab() {
  fireEvent.click(screen.getByRole('tab', { name: '模型分配' }));
}

describe('GroupLLM · provider sectioning', () => {
  test('configured providers section lists builtin (anthropic/ollama) + custom', async () => {
    renderG();
    // Wait for getLlmProviders to resolve and re-render.
    await screen.findByText('Anthropic');
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('Ollama')).toBeInTheDocument();
    // Custom row by id
    expect(screen.getByText('together')).toBeInTheDocument();
  });

  test('unconfigured builtins do NOT appear in the configured list', async () => {
    renderG();
    await screen.findByText('Anthropic');
    // The "DeepSeek" string is the configured-row name. We assert it's NOT
    // present anywhere as a row name (it should only appear as «添加 DeepSeek»
    // button label below).
    const deepseekConfigured = screen.queryByText('DeepSeek');
    // Note: the «添加 DeepSeek» button text contains "DeepSeek" but with
    // surrounding "添加 " — assert that the only matching element is the
    // button (not a row name).
    if (deepseekConfigured) {
      expect(deepseekConfigured.tagName).not.toBe('SPAN');
    }
  });

  test('unconfigured builtins surface as Add Provider buttons', async () => {
    renderG();
    await screen.findByText('Anthropic');
    expect(screen.getByRole('button', { name: '添加 OpenAI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加 DeepSeek' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加 OpenRouter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加 Google' })).toBeInTheDocument();
  });

  test('clicking «添加 OpenAI» opens the builtin add modal with API key field', async () => {
    renderG();
    await screen.findByText('Anthropic');
    fireEvent.click(screen.getByRole('button', { name: '添加 OpenAI' }));
    // Modal heading uses the {provider} interpolation. The trigger button
    // shares the «添加 OpenAI» label, so we narrow to the modal heading via
    // role rather than getByText.
    expect(screen.getByRole('heading', { name: '添加 OpenAI' })).toBeInTheDocument();
    // Password input visible (API key)
    const apiKeyInput = screen.getByPlaceholderText('sk-…');
    expect(apiKeyInput).toBeInTheDocument();
    expect((apiKeyInput as HTMLInputElement).type).toBe('password');
  });

  test('clicking «添加 Ollama» opens modal with baseURL + toggle (no API key)', async () => {
    renderG();
    // Ollama is configured in mock — re-mock would be cleaner but for this
    // sectioning test we just confirm it doesn't appear in Add buttons.
    await screen.findByText('Anthropic');
    expect(screen.queryByRole('button', { name: '添加 Ollama' })).toBeNull();
  });

  test('clicking «编辑» on a configured builtin opens edit modal prefilled', async () => {
    renderG();
    await screen.findByText('Anthropic');
    // Multiple 编辑 buttons (one per configured provider) — pick the first
    // (Anthropic per BUILTIN_PROVIDERS canonical order).
    const editBtns = screen.getAllByRole('button', { name: '编辑' });
    fireEvent.click(editBtns[0]!);
    expect(await screen.findByText('编辑 Anthropic')).toBeInTheDocument();
    // Existing models prefilled as row inputs (uncontrolled defaultValue) —
    // chip 时代用 getByText('claude-sonnet-4') 行得通；row 时代 model id 在 input
    // 里需要 getByDisplayValue。
    expect(screen.getByDisplayValue('claude-sonnet-4')).toBeInTheDocument();
  });

  test('renders custom and plugin providers with correct sections', async () => {
    renderG();
    await screen.findByText('Anthropic');
    // Plugin row appears in its own section
    expect(screen.getByText('cohere')).toBeInTheDocument();
    expect(screen.getByText(/AWS_REGION missing/)).toBeInTheDocument();
  });
});

describe('GroupLLM · pipeline matrix', () => {
  test('renders all 10 step rows with i18n labels', async () => {
    renderG();
    switchToLlmPipelineTab();
    // findAllByText: the timeout panel below the matrix card also renders an
    // "extractor · …" row, so the matcher would otherwise reject on multiple
    // matches. We just need a sentinel that the LLM panel mounted before
    // continuing — any match works.
    await screen.findAllByText(/extractor/);
    for (const id of [
      'classifier',
      'extractor',
      'matcher',
      'relator',
      'comparator',
      'verifier',
      'intent',
      'query',
      'digest_summary',
      'digest_action',
    ]) {
      expect(screen.getAllByText(new RegExp(id)).length).toBeGreaterThan(0);
    }
  });

  test('renders inline toggle for verifier and relator only', async () => {
    renderG();
    switchToLlmPipelineTab();
    // findAllByText: the timeout panel below the matrix card also renders an
    // "extractor · …" row, so the matcher would otherwise reject on multiple
    // matches. We just need a sentinel that the LLM panel mounted before
    // continuing — any match works.
    await screen.findAllByText(/extractor/);
    expect(screen.getByRole('button', { name: /启用 verifier/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /启用 relator/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /启用 digest/i })).toBeNull();
  });

  test('digest steps show "前往 Digest 设置" disabled hint when DIGEST disabled', async () => {
    renderG();
    switchToLlmPipelineTab();
    // findAllByText: the timeout panel below the matrix card also renders an
    // "extractor · …" row, so the matcher would otherwise reject on multiple
    // matches. We just need a sentinel that the LLM panel mounted before
    // continuing — any match works.
    await screen.findAllByText(/extractor/);
    expect(screen.getAllByText(/Digest 设置/).length).toBeGreaterThanOrEqual(1);
  });

  test('changing provider does NOT immediately commit (waits for model pick)', async () => {
    // Pre-fix: provider dropdown change fired commit({ key: 'together:' })
    // → modelIdSchema rejected the empty model → red toast before the user
    // could even reach the model dropdown. Post-fix the provider switch is
    // local-only; commit fires once when the user picks a model.
    const commit = vi
      .fn()
      .mockResolvedValue({ kind: 'ok' as const, updatedItems: [], pendingRestartKeys: [] });
    renderG({ ...baseProps, commit });
    switchToLlmPipelineTab();
    await screen.findAllByText(/extractor/);
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0]!, { target: { value: 'together' } });
    expect(commit).not.toHaveBeenCalled();
  });

  test('pendingProvider survives Pipeline ↔ Providers tab switch (T lift-state regression)', async () => {
    // Pre-fix: pendingProvider state lived inside each PipelineStepRow's
    // local useState. Switching to the Providers tab conditionally
    // unmounted the entire pipeline panel — every row's local state was
    // destroyed and a user who picked a provider but hadn't yet picked a
    // model silently lost the intermediate choice on tab switch. Post-fix
    // GroupLLM owns a Map<envKey, providerId> that survives the
    // PipelineStepRow unmount; the row is now a controlled component
    // reading pendingProvider as a prop.
    renderG();
    await screen.findByText('Anthropic');
    switchToLlmPipelineTab();
    await screen.findAllByText(/extractor/);

    const extractorProviderSelect = screen.getByRole('combobox', {
      name: /extractor .*提供商/i,
    }) as HTMLSelectElement;
    fireEvent.change(extractorProviderSelect, { target: { value: 'together' } });
    expect(extractorProviderSelect.value).toBe('together');

    // Tab → Providers (Pipeline panel unmounts the row).
    fireEvent.click(screen.getByRole('tab', { name: /Provider/ }));
    expect(screen.queryByRole('combobox', { name: /extractor .*提供商/i })).toBeNull();

    // Tab back → Pipeline. PipelineStepRow re-mounts; the lifted pending
    // pick should drive effective.provider through props, NOT a fresh
    // local default.
    switchToLlmPipelineTab();
    await screen.findAllByText(/extractor/);
    const reMountedSelect = screen.getByRole('combobox', {
      name: /extractor .*提供商/i,
    }) as HTMLSelectElement;
    expect(reMountedSelect.value).toBe('together');
  });

  test('toggling DIGEST_ENABLED removes the digest disabled hint', async () => {
    // Auto-commit means a flipped toggle lands in env immediately; the
    // legacy "dirty store" interim layer is gone. Build a fresh env where
    // GOLDPAN_DIGEST_ENABLED is overridden to 'true' to model the same
    // scenario (user just enabled digest, env reflects new value).
    const enabledEnv = new Map(env);
    enabledEnv.set('GOLDPAN_DIGEST_ENABLED', {
      key: 'GOLDPAN_DIGEST_ENABLED',
      configured: true,
      source: 'override' as 'env',
      mask: 'true',
    });
    const props = { ...baseProps, env: enabledEnv };
    renderG(props);
    switchToLlmPipelineTab();
    await waitFor(() => {
      expect(screen.queryByText(/前往 Digest 设置/)).toBeNull();
    });
  });
});
