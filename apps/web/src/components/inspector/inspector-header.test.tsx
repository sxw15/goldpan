import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { InspectorHeader } from './inspector-header';

describe('<InspectorHeader>', () => {
  it('layer 1 (no previous): renders close button, no back button', () => {
    render(
      <InspectorHeader
        currentTitle="Entity 1"
        kind="entity"
        previousTitle={null}
        onBack={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /返回|←/ })).toBeNull();
  });

  it('layer 2 (previous set): renders back button with "← previousTitle"', () => {
    render(
      <InspectorHeader
        currentTitle="Entity 2"
        kind="entity"
        previousTitle="Entity 1"
        onBack={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /← Entity 1/ })).toBeInTheDocument();
  });

  it('layer 2 without previousTitle: falls back to generic back label', () => {
    render(
      <InspectorHeader
        currentTitle="Entity 2"
        kind="entity"
        previousTitle=""
        onBack={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /← 返回/ })).toBeInTheDocument();
  });

  it('calls onBack when back clicked', async () => {
    const onBack = vi.fn();
    render(
      <InspectorHeader
        currentTitle="x"
        kind="entity"
        previousTitle="y"
        onBack={onBack}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /← y/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when close clicked', async () => {
    const onClose = vi.fn();
    render(
      <InspectorHeader
        currentTitle="x"
        kind="entity"
        previousTitle={null}
        onBack={vi.fn()}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('displays kind badge', () => {
    render(
      <InspectorHeader
        currentTitle="x"
        kind="entity"
        previousTitle={null}
        onBack={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('实体')).toBeInTheDocument();
  });
});
