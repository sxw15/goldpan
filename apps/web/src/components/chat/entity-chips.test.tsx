import type { CitedEntity } from '@goldpan/web-sdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EntityChips } from './entity-chips';

const ENTITIES: CitedEntity[] = [
  { id: 1, name: 'Claude 4.7', categoryPaths: ['AI / LLM'] },
  { id: 2, name: 'Anthropic', categoryPaths: ['AI / Company'] },
];

describe('<EntityChips>', () => {
  it('renders nothing when entities is empty', () => {
    const { container } = render(<EntityChips label="Related" entities={[]} onSelect={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders label + chips when entities non-empty', () => {
    render(<EntityChips label="Related" entities={ENTITIES} onSelect={vi.fn()} />);
    expect(screen.getByText('Related')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claude 4.7' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anthropic' })).toBeInTheDocument();
  });

  it('chip has title attribute with categoryPaths for hover tooltip', () => {
    render(<EntityChips label="Related" entities={ENTITIES} onSelect={vi.fn()} />);
    const chip = screen.getByRole('button', { name: 'Claude 4.7' });
    expect(chip).toHaveAttribute('title', 'AI / LLM');
  });

  it('chip click triggers onSelect with entity', async () => {
    const onSelect = vi.fn();
    render(<EntityChips label="Related" entities={ENTITIES} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Claude 4.7' }));
    expect(onSelect).toHaveBeenCalledWith(ENTITIES[0]);
  });
});
