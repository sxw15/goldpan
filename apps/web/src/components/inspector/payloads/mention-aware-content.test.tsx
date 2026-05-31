import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MentionAwareContent } from './mention-aware-content';

describe('<MentionAwareContent>', () => {
  it('renders plain content unchanged when no mentions', () => {
    render(
      <MentionAwareContent
        content="just plain text"
        knownEntities={new Map()}
        onNavigateEntity={vi.fn()}
      />,
    );
    expect(screen.getByText('just plain text')).toBeInTheDocument();
  });

  it('renders mentions as buttons when entity is known', async () => {
    const onNavigate = vi.fn();
    render(
      <MentionAwareContent
        content="I read @Anthropic and @OpenAI today"
        knownEntities={
          new Map([
            ['anthropic', 1],
            ['openai', 2],
          ])
        }
        onNavigateEntity={onNavigate}
      />,
    );
    const a = screen.getByRole('button', { name: '@Anthropic' });
    const o = screen.getByRole('button', { name: '@OpenAI' });
    expect(a).toBeInTheDocument();
    expect(o).toBeInTheDocument();

    await userEvent.click(a);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'entity', id: 1 });

    await userEvent.click(o);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'entity', id: 2 });
  });

  it('renders bracketed mentions with punctuation as buttons', async () => {
    const onNavigate = vi.fn();
    render(
      <MentionAwareContent
        content="I used @[OpenAI, Inc.] today"
        knownEntities={new Map([['openai, inc.', 42]])}
        onNavigateEntity={onNavigate}
      />,
    );
    const button = screen.getByRole('button', { name: '@OpenAI, Inc.' });
    await userEvent.click(button);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'entity', id: 42 });
  });

  it('renders unresolved mentions as plain spans with tooltip', () => {
    render(
      <MentionAwareContent
        content="I read @UnknownCorp today"
        knownEntities={new Map()}
        onNavigateEntity={vi.fn()}
        unresolvedTooltip="No matching entity"
      />,
    );
    // unresolved render: plain text wrapped in span with title attr for tooltip
    const unresolved = screen.getByText('@UnknownCorp');
    expect(unresolved).toBeInTheDocument();
    expect(unresolved.closest('button')).toBeNull();
    expect(unresolved.getAttribute('title')).toBe('No matching entity');
  });

  it('case-insensitive match (lowercases lookup)', async () => {
    const onNavigate = vi.fn();
    render(
      <MentionAwareContent
        content="@ANTHROPIC vs @anthropic"
        knownEntities={new Map([['anthropic', 1]])}
        onNavigateEntity={onNavigate}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[0]);
    await userEvent.click(buttons[1]);
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(onNavigate).toHaveBeenNthCalledWith(1, { kind: 'entity', id: 1 });
    expect(onNavigate).toHaveBeenNthCalledWith(2, { kind: 'entity', id: 1 });
  });

  it('preserves whitespace and surrounding text', () => {
    render(
      <MentionAwareContent
        content="  leading and @A trailing  "
        knownEntities={new Map([['a', 9]])}
        onNavigateEntity={vi.fn()}
      />,
    );
    // The full content with surrounding text should be visible
    expect(screen.getByText(/leading and/u)).toBeInTheDocument();
    expect(screen.getByText(/trailing/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '@A' })).toBeInTheDocument();
  });
});
