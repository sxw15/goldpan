import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StateLoading } from './state-loading';

describe('<StateLoading>', () => {
  it('renders default label when no label prop', () => {
    render(<StateLoading />);
    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  it('renders custom label when provided', () => {
    render(<StateLoading label="Fetching entity..." />);
    expect(screen.getByText('Fetching entity...')).toBeInTheDocument();
  });
});
