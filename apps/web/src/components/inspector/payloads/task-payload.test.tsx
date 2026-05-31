import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, params?: Record<string, unknown>) => {
    if (!params) return `${ns}.${key}`;
    const entries = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${ns}.${key}(${entries})`;
  },
}));

const mockGetTask = vi.fn();

vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({
    getTask: mockGetTask,
  }),
}));

import { TaskPayload } from './task-payload';

const baseBase = {
  taskId: 't1',
  sourceId: 99,
  createdAt: Date.parse('2026-04-01T10:00:00.000Z'),
  sourceStatus: null,
  logs: [],
};

describe('<TaskPayload>', () => {
  beforeEach(() => {
    mockGetTask.mockReset();
  });

  afterEach(() => cleanup());

  it('shows loading initially', () => {
    mockGetTask.mockReturnValue(new Promise(() => {}));
    render(<TaskPayload id={1} onTitleReady={vi.fn()} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows error when fetch rejects', async () => {
    mockGetTask.mockRejectedValue(new Error('boom'));
    render(<TaskPayload id={1} onTitleReady={vi.fn()} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('renders pending status with sourceUrl', async () => {
    mockGetTask.mockResolvedValue({
      ...baseBase,
      status: 'pending',
      sourceUrl: 'https://a.test',
    });
    render(<TaskPayload id={1} onTitleReady={vi.fn()} />);
    expect(await screen.findByText(/task_payload\.status_pending/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://a.test' })).toBeInTheDocument();
  });

  it('renders processing status with pipelineStep', async () => {
    mockGetTask.mockResolvedValue({
      ...baseBase,
      status: 'processing',
      sourceUrl: null,
      pipelineStep: 'extract',
    });
    render(<TaskPayload id={1} onTitleReady={vi.fn()} />);
    expect(await screen.findByText(/task_payload\.status_processing/)).toBeInTheDocument();
    expect(screen.getByText(/extract/)).toBeInTheDocument();
  });

  it('renders error with error.kind + message first line only', async () => {
    mockGetTask.mockResolvedValue({
      ...baseBase,
      status: 'error',
      sourceUrl: null,
      error: {
        step: 'extract',
        kind: 'plugin_error',
        message: 'first line\nsecond line',
        retryable: false,
      },
    });
    render(<TaskPayload id={1} onTitleReady={vi.fn()} />);
    expect(await screen.findByText('plugin_error')).toBeInTheDocument();
    expect(screen.getByText('first line')).toBeInTheDocument();
    expect(screen.queryByText(/second line/)).toBeNull();
  });

  it('fullpage link points to /tasks/:id', async () => {
    mockGetTask.mockResolvedValue({
      ...baseBase,
      status: 'done',
      sourceUrl: null,
      result: {},
    });
    render(<TaskPayload id={5} onTitleReady={vi.fn()} />);
    const link = await screen.findByRole('link', { name: /task_payload\.fullpage_link/ });
    expect(link).toHaveAttribute('href', '/tasks/5');
  });

  it('sourceUrl has rel="noopener noreferrer" and target="_blank"', async () => {
    mockGetTask.mockResolvedValue({
      ...baseBase,
      status: 'pending',
      sourceUrl: 'https://a.test',
    });
    render(<TaskPayload id={1} onTitleReady={vi.fn()} />);
    const link = await screen.findByRole('link', { name: 'https://a.test' });
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('calls onTitleReady with the i18n title-fallback key + id param after fetch resolves', async () => {
    mockGetTask.mockResolvedValue({
      ...baseBase,
      status: 'pending',
      sourceUrl: null,
    });
    const onTitle = vi.fn();
    render(<TaskPayload id={42} onTitleReady={onTitle} />);
    await screen.findByText(/task_payload\.status_pending/);
    expect(onTitle).toHaveBeenCalledWith('task_payload.title_fallback(id=42)');
  });

  it('processing without pipelineStep does not render step line', async () => {
    mockGetTask.mockResolvedValue({
      ...baseBase,
      status: 'processing',
      sourceUrl: null,
      pipelineStep: null,
    });
    render(<TaskPayload id={1} onTitleReady={vi.fn()} />);
    await screen.findByText(/task_payload\.status_processing/);
    expect(screen.queryByText(/task_payload\.pipeline_step_label/)).toBeNull();
  });
});
