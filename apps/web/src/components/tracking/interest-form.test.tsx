import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/zh.json';
import { InterestForm } from './interest-form';

function renderWithIntl(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="zh" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe('<InterestForm> new mode', () => {
  it('submits with name + searchQueries', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    renderWithIntl(<InterestForm mode="new" onSubmit={onSubmit} onCancel={onCancel} />);

    await userEvent.type(screen.getByLabelText(/名称/), 'AI News');
    const queriesInput = screen.getByLabelText(/搜索词/);
    await userEvent.type(queriesInput, 'AI{Enter}LLM,');
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'AI News',
        searchQueries: ['AI', 'LLM'],
      }),
    );
  });

  it('blocks submit when name empty', async () => {
    const onSubmit = vi.fn();
    renderWithIntl(<InterestForm mode="new" onSubmit={onSubmit} onCancel={vi.fn()} />);
    const queriesInput = screen.getByLabelText(/搜索词/);
    await userEvent.type(queriesInput, 'AI{Enter}');
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/名称不能为空/)).toBeInTheDocument();
  });

  it('blocks submit when no searchQueries', async () => {
    const onSubmit = vi.fn();
    renderWithIntl(<InterestForm mode="new" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'A');
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/至少需要一个搜索词/)).toBeInTheDocument();
  });

  it('chip delete removes from searchQueries', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(<InterestForm mode="new" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'X');
    await userEvent.type(screen.getByLabelText(/搜索词/), 'AI{Enter}LLM{Enter}');
    // Remove the 2nd chip (LLM). Chip ✕ buttons carry an i18n aria-label
    // (tracking.chip_remove_label) that includes the query text, so match by
    // the prefix rather than the raw glyph.
    const chipDeleteButtons = screen.getAllByRole('button', { name: /移除搜索词/ });
    await userEvent.click(chipDeleteButtons[1]);
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        searchQueries: ['AI'],
      }),
    );
  });

  it('cancel triggers onCancel', async () => {
    const onCancel = vi.fn();
    renderWithIntl(<InterestForm mode="new" onSubmit={vi.fn()} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: /^取消$/ }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('surfaces server error message in formError when onSubmit rejects', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('间隔太小，至少 10 分钟'));
    renderWithIntl(<InterestForm mode="new" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'X');
    await userEvent.type(screen.getByLabelText(/搜索词/), 'AI{Enter}');
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(await screen.findByText(/间隔太小/)).toBeInTheDocument();
  });

  it('multi-comma paste splits into multiple chips and keeps trailing empty input', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(<InterestForm mode="new" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'X');
    const queriesInput = screen.getByLabelText(/搜索词/);
    // `userEvent.type` fires char-by-char, so every comma triggers `onQueryChange`
    // with the running value ("A,", "A,B,", "A,B,C,"). The last form is what
    // pushes all three chips: after the 3rd comma, the previous input was
    // "A,B,", which already split A + B; the final keystroke ',' produces
    // "A,B,C,", so the branch splits "C" into a chip and keeps "" pending.
    await userEvent.type(queriesInput, 'A,B,C,');
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ searchQueries: ['A', 'B', 'C'] }),
    );
  });

  it('trims whitespace around entered chips', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(<InterestForm mode="new" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'X');
    await userEvent.type(screen.getByLabelText(/搜索词/), '  AI  {Enter}');
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ searchQueries: ['AI'] }));
  });

  it('deduplicates when the same query is entered twice', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(<InterestForm mode="new" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'X');
    await userEvent.type(screen.getByLabelText(/搜索词/), 'AI{Enter}AI{Enter}LLM{Enter}');
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ searchQueries: ['AI', 'LLM'] }),
    );
  });

  // The three tests below mirror `TrackingCrudService.validateSearchQueries`
  // on the client side so users see instant feedback. If the service rules
  // drift, these assertions will flag it (client and server must agree).
  it('blocks submit when a single query exceeds 100 chars', async () => {
    const onSubmit = vi.fn();
    renderWithIntl(<InterestForm mode="new" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'X');
    const tooLong = 'a'.repeat(101);
    // Use paste instead of type — typing 101 chars char-by-char is slow and
    // the Enter at the end commits the chip.
    const queriesInput = screen.getByLabelText(/搜索词/);
    await userEvent.click(queriesInput);
    await userEvent.paste(tooLong);
    await userEvent.type(queriesInput, '{Enter}');
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/单条搜索词不能超过 100 字符/)).toBeInTheDocument();
  });

  it('blocks submit when more than 20 queries are entered', async () => {
    const onSubmit = vi.fn();
    renderWithIntl(<InterestForm mode="new" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'X');
    const queriesInput = screen.getByLabelText(/搜索词/);
    // 21 short queries keeps joined length under 500 so the "too many" check
    // fires first (before the joined-length check).
    const payload = Array.from({ length: 21 }, (_, i) => `q${i}`).join(',');
    await userEvent.click(queriesInput);
    await userEvent.paste(`${payload},`);
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/最多 20 条/)).toBeInTheDocument();
  });

  it('blocks submit when joined queries exceed 500 chars (OR-concat cap)', async () => {
    const onSubmit = vi.fn();
    renderWithIntl(<InterestForm mode="new" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/名称/), 'X');
    const queriesInput = screen.getByLabelText(/搜索词/);
    // 6 × 99-char queries = 594 raw + 5 × 4 separators = 614 joined → exceeds
    // 500 cap (also stays under the 20-count cap and each query is ≤ 100).
    const parts = Array.from({ length: 6 }, (_, i) => `${'a'.repeat(98)}${i}`);
    await userEvent.click(queriesInput);
    await userEvent.paste(`${parts.join(',')},`);
    await userEvent.click(screen.getByRole('button', { name: /创建/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/合并后.+超过 500/)).toBeInTheDocument();
  });
});

describe('<InterestForm> edit mode', () => {
  const initial = {
    id: 1,
    name: 'Old',
    description: 'Desc',
    searchQueries: ['a'],
    toolProvider: null,
    intervalMinutes: 60,
    enabled: true,
    status: 'idle' as const,
    lastRunAt: null,
    nextRunAt: null,
    linkedEntityIds: [],
    createdAt: 0,
    updatedAt: 0,
  };

  it('prefills from initial; onSubmit sends patch', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(
      <InterestForm mode="edit" initial={initial} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    const nameInput = screen.getByLabelText(/名称/);
    expect(nameInput).toHaveValue('Old');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'New');
    await userEvent.click(screen.getByRole('button', { name: /^保存$/ }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: 'New' }));
  });

  it('reports dirty=true on name edit, false initially', async () => {
    const onDirtyChange = vi.fn();
    renderWithIntl(
      <InterestForm
        mode="edit"
        initial={initial}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );
    // initial render → dirty=false (all fields match initial)
    await vi.waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(false));
    onDirtyChange.mockClear();

    await userEvent.type(screen.getByLabelText(/名称/), 'X');
    await vi.waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
  });
});
