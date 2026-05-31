import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StateEmpty } from './state-empty';

describe('<StateEmpty>', () => {
  it('renders title', () => {
    render(<StateEmpty title="No items yet" />);
    expect(screen.getByText('No items yet')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<StateEmpty title="Empty" description="Try adding one" />);
    expect(screen.getByText('Try adding one')).toBeInTheDocument();
  });

  it('renders action slot', () => {
    render(<StateEmpty title="Empty" action={<button type="button">Add</button>} />);
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });
});
