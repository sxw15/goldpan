import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StateError } from './state-error';

describe('<StateError>', () => {
  it('renders string error message', () => {
    render(<StateError error="Network down" />);
    expect(screen.getByText('Network down')).toBeInTheDocument();
  });

  it('renders Error instance message', () => {
    render(<StateError error={new Error('Boom')} />);
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  it('calls onRetry when retry button clicked', async () => {
    const onRetry = vi.fn();
    render(<StateError error="x" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('omits retry button when onRetry not provided', () => {
    render(<StateError error="x" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
