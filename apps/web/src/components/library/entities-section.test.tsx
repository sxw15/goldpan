import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

import { useState } from 'react';
import { buildCategoryItems } from './category-rail';
import { EntitiesSection } from './entities-section';

const entities = [
  {
    id: 1,
    name: 'Claude',
    categoryPaths: ['tech/ai'],
    activePointCount: 10,
    createdAt: Date.parse('2026-04-22T00:00:00Z'),
  },
  {
    id: 2,
    name: 'Anthropic',
    categoryPaths: ['tech/ai/company'],
    activePointCount: 5,
    createdAt: Date.parse('2026-04-20T00:00:00Z'),
  },
  {
    id: 3,
    name: 'MCP',
    categoryPaths: ['tech/ai/protocol'],
    activePointCount: 3,
    createdAt: Date.parse('2026-04-21T00:00:00Z'),
  },
];

function Harness({
  initialCategory = '',
  result = { ok: entities } as Parameters<typeof EntitiesSection>[0]['result'],
  onOpenEntity = vi.fn(),
}: {
  initialCategory?: string;
  result?: Parameters<typeof EntitiesSection>[0]['result'];
  onOpenEntity?: (id: number) => void;
}) {
  const [category, setCategory] = useState(initialCategory);
  const items = 'ok' in result ? buildCategoryItems(result.ok) : [];
  return (
    <EntitiesSection
      result={result}
      onOpenEntity={onOpenEntity}
      category={category}
      onCategoryChange={setCategory}
      categoryItems={items}
    />
  );
}

function getEntityButtons() {
  return screen
    .getAllByRole('button')
    .filter((b) => /(Claude|Anthropic|MCP)/.test(b.textContent ?? ''))
    .filter((b) => b.className.includes('gp-entities-section__card'));
}

describe('EntitiesSection', () => {
  it('renders grid of entity buttons', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /Claude/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Anthropic/ })).toBeInTheDocument();
  });

  it('click entity card → onOpenEntity(id)', async () => {
    const onOpen = vi.fn();
    render(<Harness onOpenEntity={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: /Claude/ }));
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it('sort by recent (default) — newest first', () => {
    render(<Harness />);
    const buttons = getEntityButtons();
    expect(buttons[0].textContent).toMatch(/Claude/);
    expect(buttons[1].textContent).toMatch(/MCP/);
    expect(buttons[2].textContent).toMatch(/Anthropic/);
  });

  it('sort by name asc when user picks library.entities_sort_name_asc', async () => {
    render(<Harness />);
    const select = screen.getByRole('combobox', { name: /sort/i });
    await userEvent.selectOptions(select, 'name_asc');
    const buttons = getEntityButtons();
    expect(buttons[0].textContent).toMatch(/Anthropic/);
    expect(buttons[1].textContent).toMatch(/Claude/);
    expect(buttons[2].textContent).toMatch(/MCP/);
  });

  it('sort by activity desc', async () => {
    render(<Harness />);
    const select = screen.getByRole('combobox', { name: /sort/i });
    await userEvent.selectOptions(select, 'activity_desc');
    const buttons = getEntityButtons();
    expect(buttons[0].textContent).toMatch(/Claude/);
    expect(buttons[1].textContent).toMatch(/Anthropic/);
    expect(buttons[2].textContent).toMatch(/MCP/);
  });

  it('filter by category via mobile pill bar', async () => {
    render(<Harness />);
    // Pill labelled "company" (last segment of tech/ai/company).
    const pill = screen.getByRole('tab', { name: /^company/ });
    await userEvent.click(pill);
    expect(screen.getByRole('button', { name: /Anthropic/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Claude/ })).toBeNull();
  });

  it('empty state when result.ok is empty array', () => {
    render(<Harness result={{ ok: [] }} />);
    expect(screen.getByText(/library\.entities_empty_title/)).toBeInTheDocument();
  });

  it('empty state renders 3 suggestion cards that navigate to /?q=<prefill>', async () => {
    const push = vi.fn();
    // Re-mock useRouter for this test only — userEvent runs sync, so we
    // can assert push was called immediately after the click.
    const navMod = await import('next/navigation');
    vi.spyOn(navMod, 'useRouter').mockReturnValue({
      refresh: vi.fn(),
      replace: vi.fn(),
      push,
      // unused router methods — the harness only consumes `push`/`refresh`/`replace`.
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    } as unknown as ReturnType<typeof navMod.useRouter>);

    render(<Harness result={{ ok: [] }} />);
    // The three suggestion cards each surface a `*_title` translation
    // string — assert all three are present and clicking the URL card
    // pushes `/?q=https%3A%2F%2F` (the prefill is "https://").
    expect(screen.getByText(/empty_suggest_card_url_title/)).toBeInTheDocument();
    expect(screen.getByText(/empty_suggest_card_note_title/)).toBeInTheDocument();
    expect(screen.getByText(/empty_suggest_card_query_title/)).toBeInTheDocument();

    await userEvent.click(screen.getByText(/empty_suggest_card_url_title/));
    expect(push).toHaveBeenCalledWith(
      `/?q=${encodeURIComponent('library.empty_suggest_card_url_prefill')}`,
    );
  });

  it('error state when result.error', () => {
    render(<Harness result={{ error: 'boom' }} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
