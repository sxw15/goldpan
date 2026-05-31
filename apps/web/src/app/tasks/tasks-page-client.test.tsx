import type { Task, TaskStatusCounts } from '@goldpan/web-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@/components/confirm-provider';
import zhMessages from '../../../messages/zh.json';
import { TasksPageClient } from './tasks-page-client';

const ZERO_COUNTS: TaskStatusCounts = { pending: 0, processing: 0, done: 0, error: 0 };

function countsFromTasks(tasks: Task[]): TaskStatusCounts {
  const c: TaskStatusCounts = { ...ZERO_COUNTS };
  for (const task of tasks) c[task.status] += 1;
  return c;
}

const replaceMock = vi.fn();
const searchParamsMock = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => searchParamsMock,
}));

const getTasksMock = vi.fn();
const retryTaskMock = vi.fn();
const deleteTaskMock = vi.fn();

vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({
    getTasks: getTasksMock,
    retryTask: retryTaskMock,
    deleteTask: deleteTaskMock,
  }),
}));

function makeTask(id: number, status: Task['status'], overrides: Partial<Task> = {}): Task {
  return {
    id,
    sourceId: id * 100,
    status,
    createdAt: new Date(2026, 3, 28, 12, 0, id).getTime(),
    pipelineStep: null,
    inputType: 'url',
    result: null,
    errorKind: null,
    durationS: null,
    llmCount: 0,
    retryCount: 0,
    source: {
      originalUrl: `https://example.com/${id}`,
      normalizedUrl: null,
      status: 'confirmed',
    },
    ...overrides,
  } as Task;
}

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="zh" messages={zhMessages}>
      <ConfirmProvider>{ui}</ConfirmProvider>
    </NextIntlClientProvider>,
  );
}

describe('TasksPageClient', () => {
  beforeEach(() => {
    replaceMock.mockClear();
    getTasksMock.mockClear();
    retryTaskMock.mockClear();
    deleteTaskMock.mockClear();
    searchParamsMock.delete('status');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders all initial tasks', () => {
    const tasks = [
      makeTask(1, 'done'),
      makeTask(2, 'error'),
      makeTask(3, 'processing'),
      makeTask(4, 'pending'),
    ];
    renderWithIntl(
      <TasksPageClient
        initialTasks={tasks}
        initialCounts={countsFromTasks(tasks)}
        initialError={null}
        limit={100}
      />,
    );
    for (const id of [1, 2, 3, 4]) {
      expect(screen.getByText(`https://example.com/${id}`)).toBeTruthy();
    }
  });

  it('shows status counts in filter tabs', () => {
    const tasks = [
      makeTask(1, 'done'),
      makeTask(2, 'error'),
      makeTask(3, 'error'),
      makeTask(4, 'processing'),
    ];
    renderWithIntl(
      <TasksPageClient
        initialTasks={tasks}
        initialCounts={countsFromTasks(tasks)}
        initialError={null}
        limit={100}
      />,
    );
    const errorTab = screen.getByRole('tab', { name: /出错/ });
    expect(errorTab.textContent).toContain('2');
    const allTab = screen.getByRole('tab', { name: /全部/ });
    expect(allTab.textContent).toContain('4');
  });

  it('clicking filter tab calls router.replace with status query', () => {
    const tasks = [makeTask(1, 'done')];
    renderWithIntl(
      <TasksPageClient
        initialTasks={tasks}
        initialCounts={countsFromTasks(tasks)}
        initialError={null}
        limit={100}
      />,
    );
    const errorTab = screen.getByRole('tab', { name: /出错/ });
    fireEvent.click(errorTab);
    expect(replaceMock).toHaveBeenCalled();
    expect(replaceMock.mock.calls[0][0]).toContain('status=error');
  });

  it('shows empty state with home link when no tasks', () => {
    renderWithIntl(
      <TasksPageClient
        initialTasks={[]}
        initialCounts={ZERO_COUNTS}
        initialError={null}
        limit={100}
      />,
    );
    expect(screen.getByText(/暂无任务/)).toBeTruthy();
    const homeLink = screen.getByText('回主页').closest('a');
    expect(homeLink?.getAttribute('href')).toBe('/');
  });

  it('shows error state with retry button', () => {
    renderWithIntl(
      <TasksPageClient
        initialTasks={[]}
        initialCounts={ZERO_COUNTS}
        initialError="boom"
        limit={100}
      />,
    );
    expect(screen.getByText(/加载任务失败/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('clicking retry on an error task calls retryTask then refetches', async () => {
    retryTaskMock.mockResolvedValue(undefined);
    getTasksMock.mockResolvedValue({ data: [], total: 0, counts: ZERO_COUNTS });
    const tasks = [makeTask(7, 'error')];
    renderWithIntl(
      <TasksPageClient
        initialTasks={tasks}
        initialCounts={countsFromTasks(tasks)}
        initialError={null}
        limit={100}
      />,
    );
    const retryBtn = screen.getByRole('button', { name: '重试任务 7' });
    fireEvent.click(retryBtn);
    await waitFor(() => expect(retryTaskMock).toHaveBeenCalledWith(7));
    await waitFor(() => expect(getTasksMock).toHaveBeenCalled());
  });

  it('clicking delete on a done task confirms then deletes', async () => {
    deleteTaskMock.mockResolvedValue(undefined);
    getTasksMock.mockResolvedValue({ data: [], total: 0, counts: ZERO_COUNTS });
    const tasks = [makeTask(8, 'done')];
    renderWithIntl(
      <TasksPageClient
        initialTasks={tasks}
        initialCounts={countsFromTasks(tasks)}
        initialError={null}
        limit={100}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除任务 8' }));
    // ConfirmModal renders — confirm via the modal's primary action.
    const confirmBtn = await screen.findByRole('button', { name: '删除' });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(deleteTaskMock).toHaveBeenCalledWith(8));
  });

  it('aborts delete when user cancels confirm', async () => {
    const tasks = [makeTask(9, 'done')];
    renderWithIntl(
      <TasksPageClient
        initialTasks={tasks}
        initialCounts={countsFromTasks(tasks)}
        initialError={null}
        limit={100}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除任务 9' }));
    const cancelBtn = await screen.findByRole('button', { name: '取消' });
    fireEvent.click(cancelBtn);
    expect(deleteTaskMock).not.toHaveBeenCalled();
  });

  it('shows truncation hint when initial count >= limit', () => {
    const tasks = Array.from({ length: 100 }, (_, i) => makeTask(i + 1, 'done'));
    // 服务端总 count 大于 returned tasks length 时显示提示。
    const counts: TaskStatusCounts = { ...ZERO_COUNTS, done: 200 };
    renderWithIntl(
      <TasksPageClient
        initialTasks={tasks}
        initialCounts={counts}
        initialError={null}
        limit={100}
      />,
    );
    expect(screen.getByText(/显示最近 100 条任务/)).toBeTruthy();
  });
});
