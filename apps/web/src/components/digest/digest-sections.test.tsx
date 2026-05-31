import type { DigestRenderPreset } from '@goldpan/web-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import enMessages from '../../../messages/en.json';
import { DigestHero } from './digest-hero';
import { DigestSections } from './digest-sections';
import { TrackingFindingsSection } from './tracking-findings-section';

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const baseSnapshot = {
  digestId: { channel: 'web', date: '2026-04-25', presetId: null },
  period: 'daily' as const,
  generatedAt: 0,
  aiSummary: { status: 'complete' as const, text: 'Hello world summary.' },
  modules: {
    tracking_findings: {
      type: 'tracking_findings' as const,
      items: [{ id: 1, ruleId: null, title: 'Finding A', url: 'http://x', createdAt: Date.now() }],
      hasMore: false,
      hiddenCount: 0,
    },
    captures: { type: 'captures' as const, items: [], hasMore: false, hiddenCount: 0 },
    thoughts: { type: 'thoughts' as const, items: [], hasMore: false, hiddenCount: 0 },
    new_entities: {
      type: 'new_entities' as const,
      items: [{ id: 7, name: 'Claude 4.7', description: null, createdAt: Date.now() }],
      hasMore: false,
      hiddenCount: 0,
    },
    stats: { type: 'stats' as const, captures: 3, findings: 5, thoughts: 2, entities: 7 },
  },
};

describe('DigestSections (orchestrator)', () => {
  it('preset=null renders hero + 5 default slots (tracking/entities/thoughts/captures/stats) in share', () => {
    wrap(<DigestSections snapshot={baseSnapshot} preset={null} pageContext="share" />);
    expect(screen.getByText('Hello world summary.')).toBeInTheDocument(); // Hero
    expect(screen.getByText('Finding A')).toBeInTheDocument();
    expect(screen.getByText('Claude 4.7')).toBeInTheDocument();
    // stats 默认 slot 也渲染
    expect(screen.getByText('Captures')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument(); // findings 数字
  });

  it('share context renders tracking item as <a target="_blank" rel="noopener noreferrer">', () => {
    wrap(<DigestSections snapshot={baseSnapshot} preset={null} pageContext="share" />);
    const finding = screen.getByText('Finding A').closest('span');
    expect(finding).toHaveClass('gp-digest-section__item-title');
    const wrapper = finding?.closest('a');
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute('href', 'http://x');
    expect(wrapper).toHaveAttribute('target', '_blank');
    expect(wrapper).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('main context with onOpenSource renders <button> for items', () => {
    const onOpenSource = vi.fn();
    const onOpenEntity = vi.fn();
    wrap(
      <DigestSections
        snapshot={baseSnapshot}
        preset={null}
        pageContext="main"
        connectionsSinceMs={Date.now() - 7 * 86400 * 1000}
        onOpenSource={onOpenSource}
        onOpenEntity={onOpenEntity}
      />,
    );
    const button = screen.getByRole('button', { name: /Finding A/ });
    fireEvent.click(button);
    expect(onOpenSource).toHaveBeenCalledWith(1);
  });

  it('preset.slots controls section render order', () => {
    // captures 排在 new_entities 之前 → DOM 顺序应反映这一点
    const preset: DigestRenderPreset = {
      slots: ['captures', 'new_entities'],
      skipEmpty: false,
      includeAiSummary: false,
      period: 'weekly',
    };
    const snapshot = {
      ...baseSnapshot,
      modules: {
        ...baseSnapshot.modules,
        captures: {
          type: 'captures' as const,
          items: [{ id: 9, title: 'Capture One', url: 'http://c', createdAt: 0 }],
          hasMore: false,
          hiddenCount: 0,
        },
      },
    };
    const { container } = wrap(
      <DigestSections snapshot={snapshot} preset={preset} pageContext="share" />,
    );
    const sections = Array.from(container.querySelectorAll('.gp-digest-section'));
    expect(sections).toHaveLength(2);
    expect(sections[0].className).toContain('gp-digest-section--captures');
    expect(sections[1].className).toContain('gp-digest-section--entities');
  });

  it('preset.includeAiSummary=false hides the Hero', () => {
    const preset: DigestRenderPreset = {
      slots: ['tracking_findings'],
      skipEmpty: false,
      includeAiSummary: false,
      period: 'weekly',
    };
    wrap(<DigestSections snapshot={baseSnapshot} preset={preset} pageContext="share" />);
    expect(screen.queryByText('Hello world summary.')).not.toBeInTheDocument();
    expect(screen.getByText('Finding A')).toBeInTheDocument();
  });

  it('preset.skipEmpty=true skips a section whose items are empty', () => {
    const preset: DigestRenderPreset = {
      // captures 为空,thoughts 为空 — 两者都应跳过;只渲染 tracking + entities
      slots: ['tracking_findings', 'captures', 'thoughts', 'new_entities'],
      skipEmpty: true,
      includeAiSummary: false,
      period: 'weekly',
    };
    const { container } = wrap(
      <DigestSections snapshot={baseSnapshot} preset={preset} pageContext="share" />,
    );
    expect(container.querySelector('.gp-digest-section--captures')).toBeNull();
    expect(container.querySelector('.gp-digest-section--thoughts')).toBeNull();
    expect(container.querySelector('.gp-digest-section--tracking')).not.toBeNull();
    expect(container.querySelector('.gp-digest-section--entities')).not.toBeNull();
  });

  it('ai_summary slot is collapsed into the Hero (no inline section render)', () => {
    const preset: DigestRenderPreset = {
      slots: ['ai_summary', 'tracking_findings'],
      skipEmpty: false,
      includeAiSummary: true,
      period: 'weekly',
    };
    const { container } = wrap(
      <DigestSections snapshot={baseSnapshot} preset={preset} pageContext="share" />,
    );
    const summaryMatches = container.textContent?.match(/Hello world summary\./g) ?? [];
    expect(summaryMatches.length).toBe(1);
  });

  it('ai_summary slot stays hidden when includeAiSummary=false (no Hero + no inline)', () => {
    // slots 含 ai_summary 但 includeAiSummary=false → 整个 AI summary 不应出现。
    const preset: DigestRenderPreset = {
      slots: ['ai_summary', 'tracking_findings'],
      skipEmpty: false,
      includeAiSummary: false,
      period: 'weekly',
    };
    const { container } = wrap(
      <DigestSections snapshot={baseSnapshot} preset={preset} pageContext="share" />,
    );
    expect(container.textContent).not.toContain('Hello world summary.');
    // tracking 仍渲染
    expect(container.querySelector('.gp-digest-section--tracking')).not.toBeNull();
  });

  it('preset.skipEmpty=true hides stats slot when all 4 counts are 0', () => {
    const preset: DigestRenderPreset = {
      slots: ['stats'],
      skipEmpty: true,
      includeAiSummary: false,
      period: 'weekly',
    };
    const snapshot = {
      ...baseSnapshot,
      modules: {
        ...baseSnapshot.modules,
        stats: {
          type: 'stats' as const,
          captures: 0,
          findings: 0,
          thoughts: 0,
          entities: 0,
        },
      },
    };
    const { container } = wrap(
      <DigestSections snapshot={snapshot} preset={preset} pageContext="share" />,
    );
    expect(container.querySelector('.gp-digest-section--stats')).toBeNull();
  });

  it('preset.skipEmpty=true keeps stats slot when at least one count is non-zero', () => {
    const preset: DigestRenderPreset = {
      slots: ['stats'],
      skipEmpty: true,
      includeAiSummary: false,
      period: 'weekly',
    };
    const snapshot = {
      ...baseSnapshot,
      modules: {
        ...baseSnapshot.modules,
        stats: {
          type: 'stats' as const,
          captures: 0,
          findings: 1,
          thoughts: 0,
          entities: 0,
        },
      },
    };
    const { container } = wrap(
      <DigestSections snapshot={snapshot} preset={preset} pageContext="share" />,
    );
    expect(container.querySelector('.gp-digest-section--stats')).not.toBeNull();
  });

  it('share context renders captures item as <a target="_blank" rel="noopener noreferrer">', () => {
    const snapshot = {
      ...baseSnapshot,
      modules: {
        ...baseSnapshot.modules,
        captures: {
          type: 'captures' as const,
          items: [{ id: 9, title: 'Capture One', url: 'http://capture.example/c', createdAt: 0 }],
          hasMore: false,
          hiddenCount: 0,
        },
      },
    };
    wrap(<DigestSections snapshot={snapshot} preset={null} pageContext="share" />);
    const wrapper = screen.getByText('Capture One').closest('a');
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute('href', 'http://capture.example/c');
    expect(wrapper).toHaveAttribute('target', '_blank');
    expect(wrapper).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

describe('DigestHero', () => {
  it('returns null when text is empty', () => {
    const { container } = wrap(<DigestHero text="" status="complete" />);
    expect(container.firstChild).toBeNull();
  });
  it('shows fallback hint when status is fallback', () => {
    wrap(<DigestHero text="x" status="fallback" />);
    expect(screen.getByText(/fallback/i)).toBeInTheDocument();
  });
});

describe('TrackingFindingsSection', () => {
  it('renders StateEmpty when items empty', () => {
    wrap(<TrackingFindingsSection items={[]} hasMore={false} hiddenCount={0} period="weekly" />);
    expect(screen.getByText(/No tracking findings this week/i)).toBeInTheDocument();
  });
  it('renders +N more footer when hasMore', () => {
    wrap(
      <TrackingFindingsSection
        items={[{ id: 1, ruleId: null, title: 'x', url: '', createdAt: 0 }]}
        hasMore={true}
        hiddenCount={5}
        onOpenSource={() => {}}
        period="weekly"
      />,
    );
    expect(screen.getByText('+5 more')).toBeInTheDocument();
  });
});
