import type { LlmProvidersResponse } from '@goldpan/web-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../../../messages/zh.json';
import { EnvMappingVisibilityProvider } from '../../env-mapping-visibility';
import type { LlmStepDef } from '../../llm-steps';
import { PipelineStepRow } from './pipeline-step-row';

const ALWAYS_ON_STEP: LlmStepDef = {
  id: 'extractor',
  category: 'pipeline',
  envKey: 'GOLDPAN_LLM_EXTRACTOR',
  timeoutEnvKey: 'GOLDPAN_LLM_EXTRACTOR_TIMEOUT',
  defaultProviderModel: 'anthropic:claude-sonnet-4-20250514',
};
const VERIFIER_STEP: LlmStepDef = {
  id: 'verifier',
  category: 'pipeline',
  envKey: 'GOLDPAN_LLM_VERIFIER',
  timeoutEnvKey: 'GOLDPAN_LLM_VERIFIER_TIMEOUT',
  defaultProviderModel: 'openai:gpt-4o-mini',
  conditional: {
    enabledEnvKey: 'GOLDPAN_LLM_VERIFIER_ENABLED',
    inlineToggle: true,
    restartOnEnable: false,
  },
};
const DIGEST_SUMMARY_STEP: LlmStepDef = {
  id: 'digest_summary',
  category: 'digest',
  envKey: 'GOLDPAN_LLM_DIGEST_SUMMARY',
  timeoutEnvKey: 'GOLDPAN_LLM_DIGEST_SUMMARY_TIMEOUT',
  defaultProviderModel: 'anthropic:claude-sonnet-4-20250514',
  conditional: {
    enabledEnvKey: 'GOLDPAN_DIGEST_ENABLED',
    inlineToggle: false,
    restartOnEnable: true,
  },
};

const PROVIDERS: LlmProvidersResponse = {
  builtin: [
    // models 由用户在 Provider 页编辑、来自 server `/llm-providers` 解析
    // `GOLDPAN_LLM_PROVIDER_<ID>_MODELS` env —— 这里直接给一份非空清单模拟「用户已录入」。
    {
      id: 'anthropic',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      apiKeyConfigured: true,
      models: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'],
      embeddingModels: [],
    },
    {
      id: 'openai',
      apiKeyEnv: 'OPENAI_API_KEY',
      apiKeyConfigured: false,
      models: ['gpt-4o', 'gpt-4o-mini'],
      embeddingModels: ['text-embedding-3-small'],
    },
    // ollama: apiKeyConfigured 现在跟随 GOLDPAN_OLLAMA_ENABLED；测试里固定 true 模拟"已开启"。
    {
      id: 'ollama',
      apiKeyEnv: '',
      apiKeyConfigured: true,
      models: ['llama3.2:8b'],
      embeddingModels: [],
    },
  ],
  custom: [
    // together.models 故意留空 → 切换到 together 时前端会进入「自定义」输入模式
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
  ],
};

function buildEnv(entries: Array<[string, string, 'env' | 'override' | 'default']>) {
  const m = new Map();
  for (const [k, v, source] of entries) {
    m.set(k, { key: k, configured: true, source, mask: v });
  }
  return m;
}

function renderRow(props: Partial<Parameters<typeof PipelineStepRow>[0]>) {
  const defaults = {
    step: ALWAYS_ON_STEP,
    env: buildEnv([['GOLDPAN_LLM_EXTRACTOR', 'anthropic:claude-sonnet-4-20250514', 'default']]),
    providers: PROVIDERS,
    commit: vi
      .fn()
      .mockResolvedValue({ kind: 'ok' as const, updatedItems: [], pendingRestartKeys: [] }),
    resetEnvKey: vi.fn(async () => true),
    inFlightKeys: new Set<string>(),
    // PipelineStepRow is now controlled — pendingProvider + setPendingProvider
    // live on GroupLLM (see llm.tsx). Tests can pass a non-null pendingProvider
    // to exercise "user picked provider but hasn't picked model" without
    // wiring an outer state machine; the no-op setPendingProvider is fine
    // because release-on-env-catch-up only fires when env mask catches up,
    // which test fixtures don't simulate.
    pendingProvider: null as string | null,
    setPendingProvider: vi.fn() as (v: string | null) => void,
  };
  const merged = { ...defaults, ...props };
  return {
    ...render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        {/* Default visible=true so existing assertions on origin badges still
         * resolve. Hidden-mode coverage lives in settings-shell.test. */}
        <EnvMappingVisibilityProvider visible={true}>
          <PipelineStepRow {...merged} />
        </EnvMappingVisibilityProvider>
      </NextIntlClientProvider>,
    ),
    commit: merged.commit,
    resetEnvKey: merged.resetEnvKey,
    setPendingProvider: merged.setPendingProvider,
  };
}

describe('PipelineStepRow · always-on step', () => {
  test('renders effective provider and model in two selects', () => {
    renderRow({});
    const providerSelect = screen.getByRole('combobox', {
      name: /extractor .*提供商/i,
    }) as HTMLSelectElement;
    expect(providerSelect.value).toBe('anthropic');
    // model 字段也是 select（anthropic 在 PROVIDERS 里有 models 清单）
    const modelSelect = screen.getByRole('combobox', {
      name: /extractor .*模型/i,
    }) as HTMLSelectElement;
    expect(modelSelect.value).toBe('claude-sonnet-4-20250514');
  });

  test('names provider select and model select for assistive tech', () => {
    renderRow({});
    expect(screen.getByRole('combobox', { name: /extractor .*提供商/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /extractor .*模型/i })).toBeInTheDocument();
  });

  test('default-source empty mask renders placeholder option (no client-side fallback)', () => {
    // 旧行为(已废弃,commit 4dec62c7+8ee3764c):空 mask 时退回 step.defaultProviderModel
    // 显示。新行为:空 mask -> placeholder option(value='' disabled),强制用户去
    // Provider 页主动选模型。理由见 pipeline-step-row.tsx `readEffective` 注释
    // —— hardcoded fallback 会让 UI 显示"已配置但 provider 没 key"的假象,空状态
    // 反而诚实。
    renderRow({
      env: buildEnv([['GOLDPAN_LLM_EXTRACTOR', '', 'default']]),
    });
    const providerSelect = screen.getByRole('combobox', {
      name: /extractor .*提供商/i,
    }) as HTMLSelectElement;
    expect(providerSelect.value).toBe('');
    const modelSelect = screen.getByRole('combobox', {
      name: /extractor .*模型/i,
    }) as HTMLSelectElement;
    expect(modelSelect.value).toBe('');
  });

  test('changing provider does NOT commit, but DOES propagate to setPendingProvider (controlled component contract)', () => {
    // Provider change used to fire commit({ key: 'together:' }) immediately,
    // but modelIdSchema rejects empty model — the round-trip surfaced as a
    // red toast before the user could even pick a model. Post-fix the
    // provider switch stays local; commit fires once when the user picks
    // the matching model (covered by the next test).
    //
    // After the lift-state refactor PipelineStepRow is controlled —
    // setPendingProvider is a prop, owned by GroupLLM. Asserting that the
    // setter is called with the picked provider locks down the controlled
    // contract so future refactors that break the prop wiring fail loudly
    // instead of silently no-op'ing.
    const { commit, setPendingProvider } = renderRow({});
    const providerSelect = screen.getByRole('combobox', { name: /extractor .*提供商/i });
    fireEvent.change(providerSelect, { target: { value: 'together' } });
    expect(commit).not.toHaveBeenCalled();
    expect(setPendingProvider).toHaveBeenCalledWith('together');
  });

  test('non-null pendingProvider prop drives effective.provider in selects (controlled component view)', () => {
    // Mirror of the test above on the read side: when GroupLLM has already
    // recorded a pending pick (e.g. user switched tabs and came back), the
    // row must reflect it as the visible provider value even though the
    // env mask still names the previous provider.
    renderRow({
      env: buildEnv([['GOLDPAN_LLM_EXTRACTOR', 'anthropic:claude-sonnet-4-20250514', 'default']]),
      pendingProvider: 'together',
    });
    const providerSelect = screen.getByRole('combobox', {
      name: /extractor .*提供商/i,
    }) as HTMLSelectElement;
    expect(providerSelect.value).toBe('together');
    const modelSelect = screen.getByRole('combobox', {
      name: /extractor .*模型/i,
    }) as HTMLSelectElement;
    // pendingProvider !== null forces effective.model to '' so the model
    // dropdown reads "select a model" placeholder.
    expect(modelSelect.value).toBe('');
  });

  test('provider with empty models renders disabled select with "no models" hint', () => {
    // 模拟用户已经把 provider 切到 together（auto-commit 后该值已落到 env mask）。
    // 历史版本通过 dirty store 模拟同一场景；auto-commit 后 dirty 永空，env mask
    // 直接反映用户最近一次提交，所以这里直接构造 mask='together:' 的 env entry。
    renderRow({ env: buildEnv([['GOLDPAN_LLM_EXTRACTOR', 'together:', 'override']]) });
    const modelSelect = screen.getByRole('combobox', {
      name: /extractor .*模型/i,
    }) as HTMLSelectElement;
    expect(modelSelect.disabled).toBe(true);
    expect(modelSelect.value).toBe('');
    expect(screen.getByText(/Provider 设置里录入 model/)).toBeInTheDocument();
  });

  test('selecting a model from the dropdown commits "<provider>:<model>"', () => {
    const { commit } = renderRow({});
    const modelSelect = screen.getByRole('combobox', { name: /extractor .*模型/i });
    fireEvent.change(modelSelect, { target: { value: 'claude-haiku-4-5-20251001' } });
    expect(commit).toHaveBeenCalledWith({
      GOLDPAN_LLM_EXTRACTOR: 'anthropic:claude-haiku-4-5-20251001',
    });
  });

  test('off-list legacy model renders as a fallback option so user can re-pick', () => {
    // legacy `claude-3-5-sonnet-not-in-list` 不在 PROVIDERS.anthropic.models 里，
    // 仍要可见 —— 通过 fallback option `value · ?` 兜底，禁止退回手动输入。
    renderRow({
      env: buildEnv([
        ['GOLDPAN_LLM_EXTRACTOR', 'anthropic:claude-3-5-sonnet-not-in-list', 'default'],
      ]),
    });
    const modelSelect = screen.getByRole('combobox', {
      name: /extractor .*模型/i,
    }) as HTMLSelectElement;
    expect(modelSelect.value).toBe('claude-3-5-sonnet-not-in-list');
    // 不应再有 textbox（自定义输入模式已彻底移除）
    expect(screen.queryByRole('textbox', { name: /extractor .*模型/i })).toBeNull();
  });

  test('unconfigured builtin (openai) is rendered as disabled option', () => {
    renderRow({});
    const openaiOption = screen.getByRole('option', { name: /openai/i }) as HTMLOptionElement;
    expect(openaiOption.disabled).toBe(true);
  });

  test('ollama option enabled state mirrors apiKeyConfigured (ollamaEnabled)', () => {
    // Fixture sets ollama.apiKeyConfigured: true → enabled; matches new
    // GOLDPAN_OLLAMA_ENABLED-driven semantics.
    renderRow({});
    const ollamaOption = screen.getByRole('option', { name: /ollama/i }) as HTMLOptionElement;
    expect(ollamaOption.disabled).toBe(false);
  });

  test('shows reset button when source === override; calls resetEnvKey on click', async () => {
    const { resetEnvKey } = renderRow({
      env: buildEnv([['GOLDPAN_LLM_EXTRACTOR', 'openai:gpt-4o', 'override']]),
    });
    const btn = screen.getByRole('button', { name: '重置' });
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 0));
    expect(resetEnvKey).toHaveBeenCalledWith('GOLDPAN_LLM_EXTRACTOR');
  });

  test('shows format-invalid hint when provider has no model selected', () => {
    // `together:` 模拟「provider 刚切换、model 未填」状态。together.models 空 →
    // 模型 select 被 disable，warn 同步出现。auto-commit 后这种 mid-edit 状态
    // 通过 env mask 直接表达（commit 已经把 partial value 写回服务器）。
    renderRow({ env: buildEnv([['GOLDPAN_LLM_EXTRACTOR', 'together:', 'override']]) });
    expect(screen.getByText('填写不完整')).toBeInTheDocument();
  });
});

describe('PipelineStepRow · conditional verifier (inline toggle)', () => {
  test('renders verifier toggle reflecting GOLDPAN_LLM_VERIFIER_ENABLED', () => {
    renderRow({
      step: VERIFIER_STEP,
      env: buildEnv([
        ['GOLDPAN_LLM_VERIFIER', 'openai:gpt-4o-mini', 'default'],
        ['GOLDPAN_LLM_VERIFIER_ENABLED', 'false', 'default'],
      ]),
    });
    const toggle = screen.getByRole('button', { name: /启用 verifier/ });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  test('clicking verifier toggle commits GOLDPAN_LLM_VERIFIER_ENABLED → "true"', () => {
    const { commit } = renderRow({
      step: VERIFIER_STEP,
      env: buildEnv([
        ['GOLDPAN_LLM_VERIFIER', 'openai:gpt-4o-mini', 'default'],
        ['GOLDPAN_LLM_VERIFIER_ENABLED', 'false', 'default'],
      ]),
    });
    fireEvent.click(screen.getByRole('button', { name: /启用 verifier/ }));
    expect(commit).toHaveBeenCalledWith({ GOLDPAN_LLM_VERIFIER_ENABLED: 'true' });
  });

  test('override-backed verifier toggle shows origin and can reset the enabled flag', async () => {
    const { resetEnvKey } = renderRow({
      step: VERIFIER_STEP,
      env: buildEnv([
        ['GOLDPAN_LLM_VERIFIER', 'openai:gpt-4o-mini', 'default'],
        ['GOLDPAN_LLM_VERIFIER_ENABLED', 'false', 'override'],
      ]),
    });
    expect(screen.getByText('[覆盖]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(resetEnvKey).toHaveBeenCalledWith('GOLDPAN_LLM_VERIFIER_ENABLED');
  });

  test('disabled verifier still allows model edit (pre-configure scenario)', () => {
    // openai 在 PROVIDERS 里有 models 清单，model 字段是 select 模式。
    // 当前 effective model = `gpt-4o-mini`（在列表里），所以 select 直接选择即可。
    const { commit } = renderRow({
      step: VERIFIER_STEP,
      env: buildEnv([
        ['GOLDPAN_LLM_VERIFIER', 'openai:gpt-4o-mini', 'default'],
        ['GOLDPAN_LLM_VERIFIER_ENABLED', 'false', 'default'],
      ]),
    });
    const modelSelect = screen.getByRole('combobox', { name: /verifier .*模型/i });
    fireEvent.change(modelSelect, { target: { value: 'gpt-4o' } });
    expect(commit).toHaveBeenCalledWith({ GOLDPAN_LLM_VERIFIER: 'openai:gpt-4o' });
  });
});

describe('PipelineStepRow · conditional digest (external toggle)', () => {
  test('shows restart-required disabled hint when DIGEST disabled', () => {
    renderRow({
      step: DIGEST_SUMMARY_STEP,
      env: buildEnv([
        ['GOLDPAN_LLM_DIGEST_SUMMARY', 'anthropic:claude-sonnet-4-20250514', 'default'],
        ['GOLDPAN_DIGEST_ENABLED', 'false', 'default'],
      ]),
    });
    expect(screen.getByText(/Digest 设置/)).toBeInTheDocument();
    expect(screen.getByText(/重启 server/)).toBeInTheDocument();
  });

  test('does NOT render an inline toggle for digest steps', () => {
    renderRow({
      step: DIGEST_SUMMARY_STEP,
      env: buildEnv([
        ['GOLDPAN_LLM_DIGEST_SUMMARY', 'anthropic:claude-sonnet-4-20250514', 'default'],
        ['GOLDPAN_DIGEST_ENABLED', 'false', 'default'],
      ]),
    });
    expect(screen.queryByRole('button', { name: /启用 digest/i })).toBeNull();
  });

  test('disabled hint disappears when DIGEST_ENABLED flips to true (auto-committed)', () => {
    renderRow({
      step: DIGEST_SUMMARY_STEP,
      env: buildEnv([
        ['GOLDPAN_LLM_DIGEST_SUMMARY', 'anthropic:claude-sonnet-4-20250514', 'default'],
        ['GOLDPAN_DIGEST_ENABLED', 'true', 'override'],
      ]),
    });
    expect(screen.queryByText(/Digest 设置/)).toBeNull();
  });
});

describe('PipelineStepRow · reasoning advanced section', () => {
  test('unconfigured row shows neutral "高级" summary (no badge surfacing thinking)', () => {
    // 默认不配置思考 → details summary 不应该提到任何 tier，保持低调
    // —— "思考不是必须打开的"。
    renderRow({});
    expect(screen.getByText('高级')).toBeInTheDocument();
    expect(screen.queryByText(/思考: /)).toBeNull();
  });

  test('configured override surfaces tier in summary (e.g. "高级 · 思考: Medium")', () => {
    renderRow({
      env: buildEnv([
        ['GOLDPAN_LLM_EXTRACTOR', 'anthropic:claude-sonnet-4-20250514', 'default'],
        [
          'GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS',
          JSON.stringify({ thinking: { type: 'enabled', budgetTokens: 4096 } }),
          'override',
        ],
      ]),
    });
    expect(screen.getByText(/高级 · 思考: Medium/)).toBeInTheDocument();
  });

  test('selecting a non-off tier commits the correct env key with provider-native JSON', () => {
    const { commit } = renderRow({});
    // details summary 默认折叠，但 select 仍渲染（DOM 里）—— testing-library 直接抓
    const select = screen.getByRole('combobox', { name: '思考模式档位' });
    fireEvent.change(select, { target: { value: 'high' } });
    expect(commit).toHaveBeenCalledWith({
      GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS: JSON.stringify({
        thinking: { type: 'enabled', budgetTokens: 16384 },
      }),
    });
  });

  test('selecting Off resets the env key (deletes override)', async () => {
    const { resetEnvKey } = renderRow({
      env: buildEnv([
        ['GOLDPAN_LLM_EXTRACTOR', 'anthropic:claude-sonnet-4-20250514', 'default'],
        [
          'GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS',
          JSON.stringify({ thinking: { type: 'enabled', budgetTokens: 1024 } }),
          'override',
        ],
      ]),
    });
    const select = screen.getByRole('combobox', { name: '思考模式档位' });
    fireEvent.change(select, { target: { value: 'off' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(resetEnvKey).toHaveBeenCalledWith('GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS');
  });

  test('switching to a non-reasoning provider (ollama) shows "unsupported" notice', () => {
    renderRow({
      env: buildEnv([['GOLDPAN_LLM_EXTRACTOR', 'ollama:llama3.2:8b', 'override']]),
    });
    expect(screen.getByText(/ollama 不支持思考模式/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '思考模式档位' })).toBeNull();
  });

  test('deepseek provider exposes the full 5-tier ladder (no longer binary)', () => {
    // 验证 联网证据揭露 DeepSeek 真实接口：reasoningEffort 独立字段，5 档全支持。
    // 选 high 时 commit 写入 thinking + reasoningEffort 双字段。
    const { commit } = renderRow({
      env: buildEnv([['GOLDPAN_LLM_EXTRACTOR', 'deepseek:deepseek-chat', 'override']]),
    });
    const select = screen.getByRole('combobox', { name: '思考模式档位' });
    fireEvent.change(select, { target: { value: 'high' } });
    expect(commit).toHaveBeenCalledWith({
      GOLDPAN_LLM_EXTRACTOR_DEEPSEEK_OPTIONS: JSON.stringify({
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
      }),
    });
  });

  test('out-of-ladder budget locks dropdown to "自定义" with reset escape hatch', () => {
    // 50000 sits above the max tier rung (32k) → unknown → UI swaps the
    // dropdown for a locked label + Reset button so a click doesn't overwrite
    // the hand-rolled value.
    renderRow({
      env: buildEnv([
        ['GOLDPAN_LLM_EXTRACTOR', 'anthropic:claude-sonnet-4-20250514', 'default'],
        [
          'GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS',
          JSON.stringify({ thinking: { type: 'enabled', budgetTokens: 50000 } }),
          'override',
        ],
      ]),
    });
    expect(screen.getByText('自定义（通过 env 配置）')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '思考模式档位' })).toBeNull();
    expect(screen.getByRole('button', { name: /重置为 Off/ })).toBeInTheDocument();
  });
});

describe('PipelineStepRow · per-step timeout pill', () => {
  test('shows no timeout pill when the step has no override', () => {
    renderRow({});
    expect(screen.queryByText(/超时\s+\d+s/)).toBeNull();
  });

  test('shows a read-only pill when the step has a saved override', () => {
    renderRow({
      env: buildEnv([
        ['GOLDPAN_LLM_EXTRACTOR', 'anthropic:claude-sonnet-4-20250514', 'default'],
        ['GOLDPAN_LLM_EXTRACTOR_TIMEOUT', '90', 'override'],
      ]),
    });
    expect(screen.getByText(/超时\s+90s/)).toBeInTheDocument();
  });

  test('shows the pill when the timeout key is an env-override', () => {
    // Pre-auto-commit this test exercised "user typed a new timeout but
    // hasn't saved yet (dirty)". With auto-commit there is no in-between
    // — typed-and-committed lands as an env override immediately, which
    // is the same source state we now assert against.
    renderRow({
      env: buildEnv([
        ['GOLDPAN_LLM_EXTRACTOR', 'anthropic:claude-sonnet-4-20250514', 'default'],
        ['GOLDPAN_LLM_EXTRACTOR_TIMEOUT', '120', 'override'],
      ]),
    });
    expect(screen.getByText(/超时\s+120s/)).toBeInTheDocument();
  });

  test('does NOT render a number input on the row (editing is in the panel)', () => {
    renderRow({
      env: buildEnv([
        ['GOLDPAN_LLM_EXTRACTOR', 'anthropic:claude-sonnet-4-20250514', 'default'],
        ['GOLDPAN_LLM_EXTRACTOR_TIMEOUT', '90', 'override'],
      ]),
    });
    expect(screen.queryByRole('spinbutton', { name: /extractor .*超时/i })).toBeNull();
  });
});
