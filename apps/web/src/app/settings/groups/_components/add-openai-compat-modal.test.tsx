import type { CommitEnvResult } from '@goldpan/web-sdk';
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import zh from '../../../../../messages/zh.json';
import { INITIAL_MOCK } from '../../settings-data';
import { AddOpenAICompatModal } from './add-openai-compat-modal';

const mockCommitEnv = vi.fn<(p: Record<string, string>) => Promise<CommitEnvResult>>();
vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({
    commitEnv: (p: Record<string, string>) => mockCommitEnv(p),
  }),
}));

const baseGroup = {
  env: new Map(),
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

beforeEach(() => {
  mockCommitEnv.mockReset();
  baseGroup.toast = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderModal(onClose = vi.fn()) {
  const utils = render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <AddOpenAICompatModal group={baseGroup} onClose={onClose} />
    </NextIntlClientProvider>,
  );
  return { ...utils, onClose };
}

describe('AddOpenAICompatModal', () => {
  test('rejects uppercase and dash ids, accepts lowercase underscore id', async () => {
    const { container } = renderModal();
    const idInput = screen.getByPlaceholderText('together') as HTMLInputElement;

    // Uppercase rejected
    fireEvent.change(idInput, { target: { value: 'TOGETHER' } });
    fireEvent.change(screen.getByPlaceholderText('https://api.together.xyz/v1'), {
      target: { value: 'https://api.together.xyz/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••'), { target: { value: 'sk-test' } });

    // Find and click save (uses confirm button rendered by Modal footer)
    const saveBtn = screen.getByRole('button', { name: '保存' });
    fireEvent.click(saveBtn);
    expect(await screen.findByText(/必须以字母开头.*仅允许小写字母/)).toBeInTheDocument();
    expect(mockCommitEnv).not.toHaveBeenCalled();

    // Lowercase dash is rejected because env keys cannot round-trip it back
    // into the original provider id.
    fireEvent.change(idInput, { target: { value: 'together-ai' } });
    fireEvent.click(saveBtn);
    expect(await screen.findByText(/必须以字母开头.*仅允许小写字母/)).toBeInTheDocument();
    expect(mockCommitEnv).not.toHaveBeenCalled();

    // Lowercase underscore accepted (id error clears after correction + resubmit)
    mockCommitEnv.mockResolvedValueOnce({ kind: 'ok', updatedItems: [], pendingRestartKeys: [] });
    fireEvent.change(idInput, { target: { value: 'together_ai' } });
    fireEvent.click(saveBtn);
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalled());
    // No id-format error should remain
    expect(container.querySelector('.gp-add-provider-row__error')).toBeNull();
  });

  test('apiKeyEnv is derived from id (no env-name field; still written on save)', async () => {
    mockCommitEnv.mockResolvedValueOnce({ kind: 'ok', updatedItems: [], pendingRestartKeys: [] });
    renderModal();
    expect(screen.queryByPlaceholderText('TOGETHER_API_KEY')).not.toBeInTheDocument();
    expect(screen.queryByText('API key 环境变量名')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('together'), { target: { value: 'groq_cloud' } });
    fireEvent.change(screen.getByPlaceholderText('https://api.together.xyz/v1'), {
      target: { value: 'https://api.example/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalledOnce());
    expect(mockCommitEnv.mock.calls[0]?.[0]).toMatchObject({
      GOLDPAN_LLM_PROVIDER_GROQ_CLOUD_API_KEY_ENV: 'GROQ_CLOUD_API_KEY',
      GROQ_CLOUD_API_KEY: 'sk-test',
    });
  });

  test('rejects duplicate id when existingIds contains it', async () => {
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <AddOpenAICompatModal
          group={baseGroup}
          onClose={vi.fn()}
          existingIds={new Set(['together'])}
        />
      </NextIntlClientProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText('together'), { target: { value: 'together' } });
    fireEvent.change(screen.getByPlaceholderText('https://api.together.xyz/v1'), {
      target: { value: 'https://api.together.xyz/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••'), { target: { value: 'sk' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/Provider id 已存在/)).toBeInTheDocument();
    expect(mockCommitEnv).not.toHaveBeenCalled();
  });

  test('on submit success, calls commitEnv with chat + embedding model env keys, toasts, and closes', async () => {
    mockCommitEnv.mockResolvedValueOnce({ kind: 'ok', updatedItems: [], pendingRestartKeys: [] });
    const { onClose } = renderModal();

    fireEvent.change(screen.getByPlaceholderText('together'), { target: { value: 'together' } });
    fireEvent.change(screen.getByPlaceholderText('https://api.together.xyz/v1'), {
      target: { value: 'https://api.together.xyz/v1' },
    });
    // apiKeyEnv auto-derived to TOGETHER_API_KEY
    fireEvent.change(screen.getByPlaceholderText('••••'), { target: { value: 'sk-secret-value' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalledOnce());

    const patch = mockCommitEnv.mock.calls[0]?.[0];
    // _MODELS / _EMBEDDING_MODELS 字段始终存在；用户没填时为空字符串
    // (commitEnv 接受 ''，等价于「无 model」，后端解析为 models: [] / embeddingModels: [])。
    expect(patch).toEqual({
      GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL: 'https://api.together.xyz/v1',
      GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV: 'TOGETHER_API_KEY',
      GOLDPAN_LLM_PROVIDER_TOGETHER_MODELS: '',
      GOLDPAN_LLM_PROVIDER_TOGETHER_EMBEDDING_MODELS: '',
      TOGETHER_API_KEY: 'sk-secret-value',
    });

    await waitFor(() => expect(baseGroup.toast).toHaveBeenCalled());
    const toastArg = baseGroup.toast.mock.calls[0]?.[0];
    expect(toastArg).toMatchObject({ kind: 'success' });
    expect(onClose).toHaveBeenCalled();
  });

  test('locks fields while save is in flight', async () => {
    mockCommitEnv.mockImplementationOnce(
      () =>
        new Promise<CommitEnvResult>(() => {
          /* keep saving */
        }),
    );
    renderModal();

    const idInput = screen.getByPlaceholderText('together') as HTMLInputElement;
    const baseUrlInput = screen.getByPlaceholderText(
      'https://api.together.xyz/v1',
    ) as HTMLInputElement;
    const apiKeyInput = screen.getByPlaceholderText('••••') as HTMLInputElement;
    const modelInput = screen.getByPlaceholderText(/添加 model id/) as HTMLInputElement;

    fireEvent.change(idInput, { target: { value: 'together' } });
    fireEvent.change(baseUrlInput, { target: { value: 'https://api.together.xyz/v1' } });
    fireEvent.change(apiKeyInput, { target: { value: 'sk-secret-value' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(idInput).toBeDisabled();
      expect(baseUrlInput).toBeDisabled();
      expect(apiKeyInput).toBeDisabled();
      expect(modelInput).toBeDisabled();
    });
  });

  test('row editor commits the trailing draft on save and splits chat / embedding by toggle', async () => {
    mockCommitEnv.mockResolvedValueOnce({ kind: 'ok', updatedItems: [], pendingRestartKeys: [] });
    renderModal();

    fireEvent.change(screen.getByPlaceholderText('together'), { target: { value: 'together' } });
    fireEvent.change(screen.getByPlaceholderText('https://api.together.xyz/v1'), {
      target: { value: 'https://api.together.xyz/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••'), { target: { value: 'sk' } });
    // Row editor: 输入 model id 后按 Enter 提交成行，再输下一个；最后一条不按
    // Enter 留作 trailing draft —— onSave 必须 flush() 把它也带上。
    const addInput = screen.getByPlaceholderText(/添加 model id/);
    fireEvent.change(addInput, { target: { value: 'llama-3.3-70b' } });
    fireEvent.keyDown(addInput, { key: 'Enter' });
    fireEvent.change(addInput, { target: { value: 'mixtral-8x7b' } });
    fireEvent.keyDown(addInput, { key: 'Enter' });
    // 第三条留作 trailing draft（没按 Enter）—— flush 必须把它带上。
    fireEvent.change(addInput, { target: { value: 'grok-2-latest' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalledOnce());

    const patch = mockCommitEnv.mock.calls[0]?.[0];
    expect(patch).toMatchObject({
      GOLDPAN_LLM_PROVIDER_TOGETHER_MODELS: 'llama-3.3-70b,mixtral-8x7b,grok-2-latest',
      GOLDPAN_LLM_PROVIDER_TOGETHER_EMBEDDING_MODELS: '',
    });
  });

  test('commits a focused-but-unblurred existing-row edit on save (no blur)', async () => {
    // Regression guard: footer buttons preventDefault their mousedown, so a real
    // Save click never blurs the focused row input → commitRowEdit never fires.
    // flush() must read the edit off the live DOM, else the OLD id is saved.
    mockCommitEnv.mockResolvedValueOnce({ kind: 'ok', updatedItems: [], pendingRestartKeys: [] });
    renderModal();

    fireEvent.change(screen.getByPlaceholderText('together'), { target: { value: 'together' } });
    fireEvent.change(screen.getByPlaceholderText('https://api.together.xyz/v1'), {
      target: { value: 'https://api.together.xyz/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••'), { target: { value: 'sk' } });

    // Promote a draft into a committed row.
    const addInput = screen.getByPlaceholderText(/添加 model id/);
    fireEvent.change(addInput, { target: { value: 'gpt-4o' } });
    fireEvent.keyDown(addInput, { key: 'Enter' });

    // Edit the existing row's id but do NOT blur it.
    const rowInput = await screen.findByRole('textbox', { name: 'gpt-4o' });
    fireEvent.change(rowInput, { target: { value: 'gpt-4o-mini' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalledOnce());
    const patch = mockCommitEnv.mock.calls[0]?.[0];
    expect(patch).toMatchObject({
      GOLDPAN_LLM_PROVIDER_TOGETHER_MODELS: 'gpt-4o-mini',
      GOLDPAN_LLM_PROVIDER_TOGETHER_EMBEDDING_MODELS: '',
    });
  });

  test('confirm button preventDefaults mousedown so a focused field is not blurred before the click', () => {
    // Contract guard for the Modal footer fix: if the preventDefault is dropped,
    // a press blurs the focused field first, the modal reflows, and the click
    // can miss the moved button entirely. jsdom has no layout so it can't
    // reproduce the miss — assert the mechanism (defaultPrevented) instead.
    renderModal();
    const saveBtn = screen.getByRole('button', { name: '保存' });
    const ev = createEvent.mouseDown(saveBtn);
    fireEvent(saveBtn, ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  test('embedding toggle moves a row from MODELS to EMBEDDING_MODELS on commit', async () => {
    mockCommitEnv.mockResolvedValueOnce({ kind: 'ok', updatedItems: [], pendingRestartKeys: [] });
    renderModal();

    fireEvent.change(screen.getByPlaceholderText('together'), { target: { value: 'together' } });
    fireEvent.change(screen.getByPlaceholderText('https://api.together.xyz/v1'), {
      target: { value: 'https://api.together.xyz/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••'), { target: { value: 'sk' } });

    // Add a model row, then toggle its embedding flag on
    const addInput = screen.getByPlaceholderText(/添加 model id/);
    fireEvent.change(addInput, { target: { value: 'bge-large' } });
    fireEvent.keyDown(addInput, { key: 'Enter' });
    const toggleBtn = await screen.findByRole('button', {
      name: /标记 bge-large 为 embedding/,
    });
    fireEvent.click(toggleBtn);

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mockCommitEnv).toHaveBeenCalledOnce());
    const patch = mockCommitEnv.mock.calls[0]?.[0];
    expect(patch).toMatchObject({
      GOLDPAN_LLM_PROVIDER_TOGETHER_MODELS: '',
      GOLDPAN_LLM_PROVIDER_TOGETHER_EMBEDDING_MODELS: 'bge-large',
    });
  });
});
