import type { EntityDetail, NoteDetail } from '@goldpan/web-sdk';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchState } from '@/hooks/use-fetch-on-id-change';
import { EntityPayload } from './entity-payload';
import type { PayloadAction, PayloadCapabilitySet } from './types';

// Capability set matching what LibraryShell declares in production — CTA
// "追踪此主题" requires trackFromEntity to avoid dead clicks in shells
// whose dispatcher does not handle it (e.g. TrackingShell).
const TRACK_CAPS: PayloadCapabilitySet = new Set<PayloadAction['type']>([
  'discardSource',
  'trackFromEntity',
]);

// Mock SDK client module used by entity-payload
vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: vi.fn(),
}));

// GithubRepoCard depends on a server action (next/cache) that cannot be
// resolved in the vitest jsdom environment. Stub it to a sentinel element
// so tests only care about presence.
vi.mock('../../github-repo-card', () => ({
  GithubRepoCard: ({ owner, repo }: { owner: string; repo: string }) => (
    <div data-testid="github-repo-card">
      {owner}/{repo}
    </div>
  ),
}));

// Task 9: 关联笔记 hook 在 EntityPayloadBody 里调用。默认返回空 list（不渲染 section），
// 单条 test 通过 `linkedNotesStateOverride` 注入非空数据来验证 section 渲染。
// 走 module-scope mock + 可变 ref 是因为 vi.mock 提升到模块顶部，闭包变量
// 必须先声明再被工厂引用 —— 用 ref 对象规避 hoist 陷阱。
// P5 Fix Batch 5 (I10): 额外加 retryRef 让 error UI 的"重试"按钮断言能拿到
// 真正被点的 mock fn —— 与 state 同一对象上避免再开第二个 vi.mock。
const linkedNotesStateRef: { current: FetchState<NoteDetail[]> } = {
  current: { status: 'ready', data: [] },
};
const linkedNotesRetryRef: { current: ReturnType<typeof vi.fn> } = {
  current: vi.fn(),
};
vi.mock('@/hooks/use-entity-linked-notes', () => ({
  useEntityLinkedNotes: () => ({
    state: linkedNotesStateRef.current,
    retry: linkedNotesRetryRef.current,
  }),
}));

import { getBrowserApiClient } from '@/lib/api-client-browser';

const messages = {
  common: {
    retry: '重试',
  },
  state: {
    loading_default: '加载中...',
    error_title: '出错了',
    retry: '重试',
    empty_default: '暂无内容',
  },
  inspector: {
    back_fallback: '返回',
    close: '关闭',
    kind_entity: '实体',
    empty_entity_title: '暂无内容',
  },
  entity_detail: {
    facts_title: '事实（{count}）',
    opinions_title: '观点（{count}）',
    sources_title: '来源（{count}）',
    aliases: '别名',
    keywords: '关键词',
    relationships_title: '关联实体（{count}）',
    linked_notes_title: '关联笔记（{count}）',
    linked_notes_load_failed: '关联笔记加载失败',
    track_cta: '追踪此主题',
  },
  // NoteCard 在 linked-notes section 里渲染时会读 library namespace（subtype chip）。
  // PR #57 subagent F: NoteCard 从 <article> 改成 <div role="button">，accessible
  // name 由 aria-label = library.note_card_aria(id, preview) 提供 —— 必须在
  // fixture 里补这个 key 否则 getByRole('button', { name: /click me/ }) 拿不到
  // 节点。模板必须包含 {preview} 让"按 preview 查 button"的断言能匹配。
  library: {
    notes_subtype_memo: '备忘',
    notes_subtype_note: '笔记',
    notes_more_suffix: '+ {count}',
    note_card_aria: '笔记 #{id}：{preview}',
  },
  source: {
    status: {
      processing: '处理中',
      confirmed: '已确认',
      confirmed_empty: '已确认（空）',
      failed: '失败',
      discarded: '已丢弃',
    },
  },
};

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="zh" messages={messages}>
      {ui}
    </NextIntlClientProvider>
  );
}

const mockDetail: EntityDetail = {
  entity: {
    id: 42,
    name: 'Claude 4.7',
    description: 'LLM from Anthropic',
    descriptionTranslated: null,
    aliases: [],
    keywords: [],
    categoryPaths: ['AI / LLM'],
  },
  points: [
    {
      id: 1,
      content: 'Fact A',
      contentTranslated: null,
      type: 'fact',
      status: 'active',
      createdAt: Date.parse('2026-04-23'),
    },
    {
      id: 2,
      content: 'Opinion B',
      contentTranslated: null,
      type: 'opinion',
      status: 'active',
      createdAt: Date.parse('2026-04-23'),
    },
  ],
  sources: [],
  relations: [
    {
      id: 10,
      sourceEntityId: 42,
      targetEntityId: 99,
      sourceEntityName: 'Claude 4.7',
      targetEntityName: 'Anthropic',
      relationType: 'made_by',
      description: 'developed by',
      descriptionTranslated: null,
    },
  ],
  githubRepo: null,
};

const emptyDetail: EntityDetail = {
  entity: {
    id: 77,
    name: 'Lonely Entity',
    description: null,
    descriptionTranslated: null,
    aliases: [],
    keywords: [],
    categoryPaths: [],
  },
  points: [],
  sources: [],
  relations: [],
  githubRepo: null,
};

describe('<EntityPayload>', () => {
  let getEntityMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getEntityMock = vi.fn();
    (getBrowserApiClient as ReturnType<typeof vi.fn>).mockReturnValue({
      getEntity: getEntityMock,
    });
    // Reset the linked-notes mock to "empty" default between tests so a non-empty
    // override in one test cannot bleed into the next.
    linkedNotesStateRef.current = { status: 'ready', data: [] };
    linkedNotesRetryRef.current = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    getEntityMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(wrap(<EntityPayload id={42} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  // Plan §5.6: entity.name 归 InspectorHeader，payload 内不重复渲染。
  // 因此 "已加载" 断言改为 description（payload 实际渲染的内容）。
  it('renders entity description + fact once loaded', async () => {
    getEntityMock.mockResolvedValue(mockDetail);
    render(wrap(<EntityPayload id={42} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await waitFor(() => expect(screen.getByText('LLM from Anthropic')).toBeInTheDocument());
    expect(screen.getByText('Fact A')).toBeInTheDocument();
  });

  it('calls onTitleReady with entity name after fetch', async () => {
    getEntityMock.mockResolvedValue(mockDetail);
    const onTitleReady = vi.fn();
    render(wrap(<EntityPayload id={42} onTitleReady={onTitleReady} onNavigateEntity={vi.fn()} />));
    await waitFor(() => expect(onTitleReady).toHaveBeenCalledWith('Claude 4.7'));
  });

  it('renders StateError on fetch failure + retry triggers refetch', async () => {
    getEntityMock.mockRejectedValueOnce(new Error('Network down'));
    render(wrap(<EntityPayload id={42} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await waitFor(() => expect(screen.getByText('Network down')).toBeInTheDocument());

    getEntityMock.mockResolvedValue(mockDetail);
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    // 同上：用 description 断言加载完成，避免与 header 标题耦合。
    await waitFor(() => expect(screen.getByText('LLM from Anthropic')).toBeInTheDocument());
  });

  it('relation chip click triggers onNavigateEntity with other-side id', async () => {
    getEntityMock.mockResolvedValue(mockDetail);
    const onNavigate = vi.fn();
    render(wrap(<EntityPayload id={42} onTitleReady={vi.fn()} onNavigateEntity={onNavigate} />));
    await waitFor(() => expect(screen.getByText('LLM from Anthropic')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Anthropic/ }));
    // Since sourceEntityId=42 === id, other side = targetEntityId=99
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'entity', id: 99 });
  });

  it('renders StateEmpty when entity has no category / description / facts / relations', async () => {
    getEntityMock.mockResolvedValue(emptyDetail);
    render(wrap(<EntityPayload id={77} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await waitFor(() => expect(screen.getByText('暂无内容')).toBeInTheDocument());
    // Body sections should not appear
    expect(screen.queryByText(/事实/)).toBeNull();
    expect(screen.queryByText(/关联实体/)).toBeNull();
  });

  // --- S2 Full detail 扩展 ---

  const fullDetail: EntityDetail = {
    entity: {
      id: 1,
      name: 'Claude 4.7',
      description: 'Anthropic large language model',
      descriptionTranslated: null,
      aliases: ['Claude Opus 4.7', 'Opus'],
      keywords: ['llm', 'anthropic'],
      categoryPaths: ['tech/ai'],
    },
    points: [
      {
        id: 101,
        content: 'Fact A',
        contentTranslated: null,
        type: 'fact',
        status: 'active',
        createdAt: Date.parse('2026-04-20T10:00:00.000Z'),
      },
      {
        id: 102,
        content: 'Fact B',
        contentTranslated: null,
        type: 'fact',
        status: 'active',
        createdAt: Date.parse('2026-04-21T10:00:00.000Z'),
      },
      {
        id: 201,
        content: 'Opinion A',
        contentTranslated: null,
        type: 'opinion',
        status: 'active',
        createdAt: Date.parse('2026-04-20T10:00:00.000Z'),
      },
    ],
    sources: [
      { id: 301, originalUrl: 'https://a.example', status: 'confirmed' },
      { id: 302, originalUrl: 'https://b.example', status: 'discarded' },
    ],
    relations: [
      {
        id: 401,
        sourceEntityId: 1,
        targetEntityId: 9,
        sourceEntityName: 'Claude 4.7',
        targetEntityName: 'Anthropic',
        relationType: 'created_by',
        description: '',
        descriptionTranslated: null,
      },
      {
        id: 402,
        sourceEntityId: 1,
        targetEntityId: 10,
        sourceEntityName: 'Claude 4.7',
        targetEntityName: 'MCP',
        relationType: 'related_to',
        description: '',
        descriptionTranslated: null,
      },
      {
        id: 403,
        sourceEntityId: 1,
        targetEntityId: 11,
        sourceEntityName: 'Claude 4.7',
        targetEntityName: 'Constitutional AI',
        relationType: 'related_to',
        description: '',
        descriptionTranslated: null,
      },
      {
        id: 404,
        sourceEntityId: 1,
        targetEntityId: 12,
        sourceEntityName: 'Claude 4.7',
        targetEntityName: 'Projects',
        relationType: 'related_to',
        description: '',
        descriptionTranslated: null,
      },
    ],
    githubRepo: null,
  };

  it('does NOT render entity.name as <h2> (InspectorHeader owns title)', async () => {
    getEntityMock.mockResolvedValue(fullDetail);
    render(wrap(<EntityPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await screen.findByText('Anthropic large language model');
    expect(screen.queryByRole('heading', { level: 2, name: 'Claude 4.7' })).toBeNull();
  });

  it('renders aliases chips when present, hides section when empty', async () => {
    getEntityMock.mockResolvedValue(fullDetail);
    render(wrap(<EntityPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    expect(await screen.findByText('Claude Opus 4.7')).toBeInTheDocument();
    expect(screen.getByText('Opus')).toBeInTheDocument();

    cleanup();
    getEntityMock.mockResolvedValue({
      ...fullDetail,
      entity: { ...fullDetail.entity, aliases: [] },
    });
    render(wrap(<EntityPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await screen.findByText('Anthropic large language model');
    expect(screen.queryByText('Claude Opus 4.7')).toBeNull();
  });

  it('renders keywords chips when present', async () => {
    getEntityMock.mockResolvedValue(fullDetail);
    render(wrap(<EntityPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    expect(await screen.findByText('llm')).toBeInTheDocument();
    expect(screen.getByText('anthropic')).toBeInTheDocument();
  });

  it('renders full facts with date suffix (not sliced to 5)', async () => {
    getEntityMock.mockResolvedValue({
      ...fullDetail,
      points: Array.from({ length: 8 }, (_, i) => ({
        id: 100 + i,
        content: `Fact ${i}`,
        type: 'fact' as const,
        status: 'active' as const,
        createdAt: Date.parse(`2026-04-${String(20 + i).padStart(2, '0')}T10:00:00.000Z`),
      })),
    });
    render(wrap(<EntityPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await screen.findByText('Fact 0');
    // 全 8 条都应渲染，不 slice 到 5
    expect(screen.getByText('Fact 7')).toBeInTheDocument();
    // 日期后缀
    expect(screen.getByText(/2026-04-27/)).toBeInTheDocument();
  });

  it('renders opinions section separately from facts', async () => {
    getEntityMock.mockResolvedValue(fullDetail);
    render(wrap(<EntityPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    expect(await screen.findByText('Opinion A')).toBeInTheDocument();
    // opinions 独立 section 与 facts 不混
    const opinion = screen.getByText('Opinion A');
    expect(opinion.closest('.gp-entity-payload__opinions')).not.toBeNull();
  });

  it('renders full relations (not sliced to 3), no +N more counter', async () => {
    getEntityMock.mockResolvedValue(fullDetail);
    render(wrap(<EntityPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await screen.findByText('Anthropic');
    // 4 条 relation 全渲染
    expect(screen.getByRole('button', { name: 'Anthropic' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MCP' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Constitutional AI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Projects' })).toBeInTheDocument();
    // __more-count 不存在
    expect(document.querySelector('.gp-entity-payload__more-count')).toBeNull();
  });

  it('renders sources with external links + status badge class', async () => {
    getEntityMock.mockResolvedValue(fullDetail);
    render(wrap(<EntityPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    const link = await screen.findByRole('link', { name: /a\.example/ });
    expect(link).toHaveAttribute('href', 'https://a.example');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    // EntityPayload 复用通用 chip class（与 SourcesSection / SourcePayload 同一套 BEM）
    expect(document.querySelector('.gp-source-status-chip--confirmed')).not.toBeNull();
    expect(document.querySelector('.gp-source-status-chip--discarded')).not.toBeNull();
  });

  it('renders GithubRepoCard only when detail.githubRepo present', async () => {
    // Absent
    getEntityMock.mockResolvedValue(fullDetail);
    render(wrap(<EntityPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await screen.findByText('Anthropic large language model');
    expect(document.querySelector('.gp-entity-payload__github')).toBeNull();

    cleanup();
    getEntityMock.mockResolvedValue({
      ...fullDetail,
      githubRepo: {
        owner: 'anthropics',
        repo: 'claude-code',
        normalizedUrl: 'https://github.com/anthropics/claude-code',
        archived: false,
        lastRefreshedAt: Date.parse('2026-04-20T10:00:00.000Z'),
      },
    });
    render(wrap(<EntityPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await screen.findByText('Anthropic large language model');
    expect(document.querySelector('.gp-entity-payload__github')).not.toBeNull();
  });

  it('hasAnyContent includes sources-only / githubRepo-only / aliases-only cases', async () => {
    // aliases-only: categoryPaths / description / facts / opinions / relations / sources / githubRepo 全空，只 aliases 有值
    getEntityMock.mockResolvedValue({
      entity: {
        ...fullDetail.entity,
        description: null,
        categoryPaths: [],
        aliases: ['alpha-only'],
        keywords: [],
      },
      points: [],
      sources: [],
      relations: [],
      githubRepo: null,
    });
    render(wrap(<EntityPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    expect(await screen.findByText('alpha-only')).toBeInTheDocument();
    // StateEmpty 不应渲染
    expect(screen.queryByText(/entity_empty/i)).toBeNull();

    cleanup();
    // sources-only
    getEntityMock.mockResolvedValue({
      entity: {
        ...fullDetail.entity,
        description: null,
        categoryPaths: [],
        aliases: [],
        keywords: [],
      },
      points: [],
      sources: [{ id: 999, originalUrl: 'https://only.example', status: 'confirmed' }],
      relations: [],
      githubRepo: null,
    });
    render(wrap(<EntityPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    expect(await screen.findByRole('link', { name: /only\.example/ })).toBeInTheDocument();
  });

  it('does NOT render view_all link (removed in S2)', async () => {
    getEntityMock.mockResolvedValue(fullDetail);
    render(wrap(<EntityPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await screen.findByText('Anthropic large language model');
    expect(screen.queryByText(/查看全部/)).toBeNull();
    expect(document.querySelector('.gp-entity-payload__more')).toBeNull();
  });

  // --- T9: "追踪此主题" CTA ---

  it('renders track CTA when onAction provided and capability includes trackFromEntity', async () => {
    getEntityMock.mockResolvedValue(mockDetail);
    render(
      wrap(
        <EntityPayload
          id={42}
          onTitleReady={vi.fn()}
          onNavigateEntity={vi.fn()}
          onAction={vi.fn()}
          capabilities={TRACK_CAPS}
        />,
      ),
    );
    expect(await screen.findByRole('button', { name: /追踪此主题/ })).toBeInTheDocument();
  });

  it('track CTA click dispatches trackFromEntity with entity id+name', async () => {
    getEntityMock.mockResolvedValue(mockDetail);
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      wrap(
        <EntityPayload
          id={42}
          onTitleReady={vi.fn()}
          onNavigateEntity={vi.fn()}
          onAction={onAction}
          capabilities={TRACK_CAPS}
        />,
      ),
    );
    const btn = await screen.findByRole('button', { name: /追踪此主题/ });
    await userEvent.click(btn);
    expect(onAction).toHaveBeenCalledWith({
      type: 'trackFromEntity',
      entityId: 42,
      entityName: 'Claude 4.7',
    });
  });

  it('track CTA not rendered when onAction missing', async () => {
    getEntityMock.mockResolvedValue(mockDetail);
    render(wrap(<EntityPayload id={42} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await screen.findByText('LLM from Anthropic');
    expect(screen.queryByRole('button', { name: /追踪此主题/ })).toBeNull();
  });

  // R2 regression: even with onAction present, a shell whose capability set
  // does NOT include trackFromEntity (e.g. TrackingShell, whose dispatcher
  // has no case for it) must not render the CTA — clicking would be a dead
  // click because the generic onAction silently falls through.
  it('track CTA not rendered when capability omits trackFromEntity', async () => {
    getEntityMock.mockResolvedValue(mockDetail);
    const capsWithoutTrack: PayloadCapabilitySet = new Set<PayloadAction['type']>([
      'updateInterest',
      'deleteInterest',
      'setInterestEnabled',
    ]);
    render(
      wrap(
        <EntityPayload
          id={42}
          onTitleReady={vi.fn()}
          onNavigateEntity={vi.fn()}
          onAction={vi.fn()}
          capabilities={capsWithoutTrack}
        />,
      ),
    );
    await screen.findByText('LLM from Anthropic');
    expect(screen.queryByRole('button', { name: /追踪此主题/ })).toBeNull();
  });

  // Review round 4 B-Fe-2: CTA must be visible even when entity has no content
  // (hasAnyContent=false) — the empty-entity case is *most* likely to need
  // tracking (e.g. freshly created shell entity). StateEmpty coexists with CTA.
  it('track CTA visible when entity has no content (hasAnyContent=false)', async () => {
    getEntityMock.mockResolvedValue(emptyDetail);
    render(
      wrap(
        <EntityPayload
          id={77}
          onTitleReady={vi.fn()}
          onNavigateEntity={vi.fn()}
          onAction={vi.fn()}
          capabilities={TRACK_CAPS}
        />,
      ),
    );
    expect(await screen.findByRole('button', { name: /追踪此主题/ })).toBeInTheDocument();
    // StateEmpty should still render alongside the CTA (empty_entity_title text)
    expect(screen.getByText('暂无内容')).toBeInTheDocument();
  });

  // Review round 4 B-Fe-4: onAction rejection surfaces inline (no window.alert).
  it('track CTA error surfaces inline via role="alert"', async () => {
    getEntityMock.mockResolvedValue(mockDetail);
    const onAction = vi.fn().mockRejectedValue(new Error('duplicate name'));
    render(
      wrap(
        <EntityPayload
          id={42}
          onTitleReady={vi.fn()}
          onNavigateEntity={vi.fn()}
          onAction={onAction}
          capabilities={TRACK_CAPS}
        />,
      ),
    );
    const btn = await screen.findByRole('button', { name: /追踪此主题/ });
    await userEvent.click(btn);
    expect(await screen.findByText('duplicate name')).toBeInTheDocument();
  });

  // C11 regression: double-click on the Track CTA while the first request is
  // in flight must not dispatch the action twice. Without the pending guard
  // LibraryShell's createInterest would fire twice and navigate to whichever
  // response resolved last, leaving two interests in the database.
  it('double-click on track CTA while in flight dispatches only once', async () => {
    getEntityMock.mockResolvedValue(mockDetail);
    let resolveAction: () => void = () => undefined;
    const onAction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAction = resolve;
        }),
    );
    render(
      wrap(
        <EntityPayload
          id={42}
          onTitleReady={vi.fn()}
          onNavigateEntity={vi.fn()}
          onAction={onAction}
          capabilities={TRACK_CAPS}
        />,
      ),
    );
    const btn = await screen.findByRole('button', { name: /追踪此主题/ });
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    resolveAction();
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  });

  // --- T9: 关联笔记 section ---

  it('renders linked notes section + first note content when notes exist for this entity', async () => {
    linkedNotesStateRef.current = {
      status: 'ready',
      data: [
        {
          id: 501,
          content: 'note about this entity',
          contentTranslated: null,
          language: 'zh',
          subtype: 'note',
          pinned: false,
          archived: false,
          sourceMessageId: null,
          conversationId: null,
          tags: [],
          linkedEntities: [],
          linkedSources: [],
          dueAt: null,
          remindedAt: null,
          createdAt: Date.parse('2026-04-22T10:00:00.000Z'),
          updatedAt: Date.parse('2026-04-22T10:00:00.000Z'),
        },
      ],
    };
    getEntityMock.mockResolvedValue(mockDetail);
    render(wrap(<EntityPayload id={42} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await waitFor(() => expect(screen.getByText('LLM from Anthropic')).toBeInTheDocument());
    expect(screen.getByText(/关联笔记/)).toBeInTheDocument();
    expect(screen.getByText('note about this entity')).toBeInTheDocument();
  });

  it('does NOT render linked notes section when entity has no linked notes', async () => {
    // default linkedNotesStateRef = empty (set in beforeEach)
    getEntityMock.mockResolvedValue(mockDetail);
    render(wrap(<EntityPayload id={42} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await waitFor(() => expect(screen.getByText('LLM from Anthropic')).toBeInTheDocument());
    expect(screen.queryByText(/关联笔记/)).toBeNull();
  });

  it('clicking a linked note card triggers onNavigateEntity with kind=note', async () => {
    linkedNotesStateRef.current = {
      status: 'ready',
      data: [
        {
          id: 777,
          content: 'click me',
          contentTranslated: null,
          language: 'zh',
          subtype: 'memo',
          pinned: false,
          archived: false,
          sourceMessageId: null,
          conversationId: null,
          tags: [],
          linkedEntities: [],
          linkedSources: [],
          dueAt: null,
          remindedAt: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };
    getEntityMock.mockResolvedValue(mockDetail);
    const onNavigate = vi.fn();
    render(wrap(<EntityPayload id={42} onTitleReady={vi.fn()} onNavigateEntity={onNavigate} />));
    await waitFor(() => expect(screen.getByText('click me')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /click me/ }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'note', id: 777 });
  });

  // P5 Fix Batch 5 (I4): sparse entity (没有 description / facts / opinions /
  // relations / sources / githubRepo / aliases / keywords / categoryPaths) 但
  // 有 linkedNotes —— hasAnyContent 必须把 linkedNotes.length > 0 也算进来，
  // 否则用户只通过 note 关联实体的场景会被 StateEmpty 屏蔽，note section
  // 永不出现。
  it('I4: sparse entity with only linked notes does NOT render StateEmpty', async () => {
    linkedNotesStateRef.current = {
      status: 'ready',
      data: [
        {
          id: 5001,
          content: 'note-only entity body',
          contentTranslated: null,
          language: 'zh',
          subtype: 'note',
          pinned: false,
          archived: false,
          sourceMessageId: null,
          conversationId: null,
          tags: [],
          linkedEntities: [],
          linkedSources: [],
          dueAt: null,
          remindedAt: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };
    getEntityMock.mockResolvedValue(emptyDetail);
    render(wrap(<EntityPayload id={77} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await waitFor(() => expect(screen.getByText('note-only entity body')).toBeInTheDocument());
    // linkedNotes 应渲染 section + note 内容
    expect(screen.getByText(/关联笔记/)).toBeInTheDocument();
    // StateEmpty title (empty_entity_title='暂无内容') 不应渲染
    expect(screen.queryByText('暂无内容')).toBeNull();
  });

  // P5 Fix Batch 5 (I10): linkedNotesState=error 时渲染 inline error + retry
  // 按钮，与"ready 空"区分（之前两种状态都被静默折叠成不渲染）。
  it('I10: renders inline error + retry button when linkedNotes fetch fails', async () => {
    linkedNotesStateRef.current = {
      status: 'error',
      error: new Error('network down'),
    };
    getEntityMock.mockResolvedValue(mockDetail);
    render(wrap(<EntityPayload id={42} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    await waitFor(() => expect(screen.getByText('LLM from Anthropic')).toBeInTheDocument());
    expect(screen.getByText('关联笔记加载失败')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: '重试' });
    expect(retryBtn).toBeInTheDocument();
    await userEvent.click(retryBtn);
    expect(linkedNotesRetryRef.current).toHaveBeenCalledTimes(1);
  });

  // P5 Fix Batch 7 thread #7: sparse entity (无 description / facts / sources
  // / 等所有 hasAnyContent 信号) + linkedNotes 加载失败时，hasAnyContent 必须
  // 把非 'ready' 状态算进来，否则 StateEmpty 提前短路 → I10 的 inline error
  // UI 永远不渲染，用户看不到错误也无法重试。
  it('thread #7: sparse entity + linkedNotes error falls through to Body so inline error UI renders', async () => {
    linkedNotesStateRef.current = {
      status: 'error',
      error: new Error('linked notes load failed'),
    };
    getEntityMock.mockResolvedValue(emptyDetail);
    render(wrap(<EntityPayload id={77} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />));
    // Body 渲染 → I10 的 inline error 文本应出现
    await waitFor(() => expect(screen.getByText('关联笔记加载失败')).toBeInTheDocument());
    // StateEmpty title (empty_entity_title='暂无内容') 不应渲染 —— hasAnyContent
    // 因 linkedNotesState !== 'ready' 而成立 → Body 而非 StateEmpty 分支。
    expect(screen.queryByText('暂无内容')).toBeNull();
    // 同样断言：retry 按钮存在并可被点击
    const retryBtn = screen.getByRole('button', { name: '重试' });
    expect(retryBtn).toBeInTheDocument();
  });
});
