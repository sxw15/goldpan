import type { NoteDetail } from '@goldpan/web-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { TzProvider } from '@/components/tz-provider';
import messages from '../../../messages/zh.json';
import { NoteCard } from './note-card';

const baseNote: NoteDetail = {
  id: 7,
  content: '今天读到 Claude Code 的 hooks 设计',
  contentTranslated: null,
  language: 'zh',
  subtype: 'note',
  pinned: false,
  archived: false,
  sourceMessageId: null,
  conversationId: null,
  tags: ['claude', 'hooks'],
  linkedEntities: [{ id: 1, name: 'Claude Code' }],
  linkedSources: [],
  dueAt: null,
  remindedAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function setup(note: NoteDetail = baseNote, onOpen: (...args: unknown[]) => void = vi.fn()) {
  return render(
    <NextIntlClientProvider locale="zh" messages={messages} timeZone="UTC">
      <TzProvider tz="UTC">
        <NoteCard note={note} onOpen={onOpen} />
      </TzProvider>
    </NextIntlClientProvider>,
  );
}

describe('NoteCard', () => {
  it('renders subtype chip + content preview + tags + entities', () => {
    setup();
    expect(screen.getByText(/claude code 的 hooks 设计/i)).toBeInTheDocument();
    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });

  it('truncates content > 80 chars with ellipsis', () => {
    setup({ ...baseNote, content: 'A'.repeat(200) });
    expect(screen.getByText(/A{80}…/)).toBeInTheDocument();
  });

  it('calls onOpen when card clicked', () => {
    const onOpen = vi.fn();
    setup(baseNote, onOpen);
    screen.getByRole('button').click();
    expect(onOpen).toHaveBeenCalledWith({ kind: 'note', id: 7 });
  });

  it('opens via Enter key', () => {
    const onOpen = vi.fn();
    setup(baseNote, onOpen);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith({ kind: 'note', id: 7 });
  });

  it('opens via Space key', () => {
    const onOpen = vi.fn();
    setup(baseNote, onOpen);
    fireEvent.keyDown(screen.getByRole('button'), { key: ' ' });
    expect(onOpen).toHaveBeenCalledWith({ kind: 'note', id: 7 });
  });

  it('has aria-label with note id and preview', () => {
    setup();
    const card = screen.getByRole('button');
    // zh: "笔记 #{id}：{preview}" — preview slice(0, 30) of baseNote.content
    expect(card).toHaveAttribute('aria-label', '笔记 #7：今天读到 Claude Code 的 hooks 设计');
  });

  it('caps tags to 3 and surfaces +N more chip', () => {
    setup({
      ...baseNote,
      tags: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
    expect(screen.getByText('c')).toBeInTheDocument();
    expect(screen.queryByText('d')).not.toBeInTheDocument();
    expect(screen.queryByText('e')).not.toBeInTheDocument();
    expect(screen.getByText('+ 2')).toBeInTheDocument();
  });

  it('caps entities to 3 and surfaces +N more chip', () => {
    setup({
      ...baseNote,
      tags: [],
      linkedEntities: [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
        { id: 3, name: 'C' },
        { id: 4, name: 'D' },
        { id: 5, name: 'E' },
      ],
    });
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByText('C')).toBeInTheDocument();
    expect(screen.queryByText('D')).not.toBeInTheDocument();
    expect(screen.queryByText('E')).not.toBeInTheDocument();
    expect(screen.getByText('+ 2')).toBeInTheDocument();
  });
});
