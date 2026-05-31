/**
 * Library page (server component) — `generateMetadata` branches + the
 * 4 Promise.all error handlers + the confirmed_empty graceful degradation.
 *
 * The page itself is a server component that composes a client `<LibraryShell>`
 * with the SSR-fetched envelopes. ReactDOM in jsdom cannot render async server
 * components, so we stub LibraryShell to a plain marker div — we only assert
 * the props the page passes through. For `generateMetadata` we exercise the
 * branches directly (it returns a Metadata object, no render needed).
 *
 * NEXT_REDIRECT semantics — Next 16's `redirect()` throws an `Error` with a
 * `digest` string prefixed `NEXT_REDIRECT;...`. `unstable_rethrow` (wrapped
 * by our `rethrowNextErrors`) re-throws any error whose digest starts with
 * one of Next's framework prefixes; we mock it as a pass-through that throws
 * iff the input matches that shape, so the test exercises the real wiring
 * (page's `.then(_, err)` handlers must call rethrowNextErrors BEFORE
 * building the failure envelope).
 */
import type { EntityDetail, NoteDetail, SourceViewDetail } from '@goldpan/web-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getEntity: vi.fn(),
    getSourceView: vi.fn(),
    getNote: vi.fn(),
    getEntities: vi.fn(),
    listNotes: vi.fn(),
    listSources: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({
  createServerClient: vi.fn(async () => ({
    getEntity: mocks.getEntity,
    getSourceView: mocks.getSourceView,
    getNote: mocks.getNote,
    getEntities: mocks.getEntities,
    listNotes: mocks.listNotes,
    listSources: mocks.listSources,
  })),
  // Pass-through that mirrors `unstable_rethrow`'s shape: throws iff the
  // error has a `digest` string starting with NEXT_*. Anything else is a
  // no-op so business errors still build degraded envelopes.
  rethrowNextErrors: vi.fn((err: unknown) => {
    if (err instanceof Error && typeof err.digest === 'string' && err.digest.startsWith('NEXT_')) {
      throw err;
    }
  }),
}));

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn(async () => undefined) }));

vi.mock('next-intl/server', () => ({
  // Echoes back `namespace.key(json-of-params)` so assertions can match the
  // exact translator call without loading actual locale files.
  getTranslations: vi.fn(async (ns: string) => (key: string, params?: Record<string, unknown>) => {
    if (params) return `${ns}.${key}(${JSON.stringify(params)})`;
    return `${ns}.${key}`;
  }),
}));

// Stub LibraryShell so the server component result is a plain element whose
// props we can introspect — bypasses the async-component / jsdom render issue.
// The page returns a React element (it does NOT render it); we reach into
// `tree.props` directly to inspect what would have been passed downstream.
vi.mock('@/components/library/library-shell', () => ({
  LibraryShell: () => null,
}));

declare global {
  interface Error {
    digest?: string;
  }
}

/** Build a NEXT_REDIRECT-shaped error, as `redirect()` would throw. */
function buildRedirectError(to: string): Error {
  const err = new Error('NEXT_REDIRECT');
  // Next stores `digest = NEXT_REDIRECT;<replaceOrPush>;<path>;<statusCode>;`.
  // unstable_rethrow only checks the prefix, so the exact tail doesn't matter.
  err.digest = `NEXT_REDIRECT;replace;${to};307;`;
  return err;
}

const sampleEntities = { data: [{ id: 1, name: 'Foo' }] };
const sampleNotes = { data: [], nextCursor: null } as { data: NoteDetail[]; nextCursor: null };
const sampleSources = {
  data: [],
  counts: { processing: 0, confirmed: 0, confirmed_empty: 0, failed: 0, discarded: 0 },
};

function arm(overrides: Partial<typeof mocks> = {}) {
  for (const key of Object.keys(mocks) as Array<keyof typeof mocks>) {
    mocks[key].mockReset();
  }
  mocks.getEntities.mockResolvedValue(sampleEntities);
  // Default: active notes ok, archived ok, sources ok, confirmed_empty ok.
  mocks.listNotes.mockResolvedValue(sampleNotes);
  mocks.listSources.mockResolvedValue(sampleSources);
  for (const [key, fn] of Object.entries(overrides)) {
    (mocks as Record<string, ReturnType<typeof vi.fn>>)[key] = fn;
  }
}

describe('LibraryPage.generateMetadata', () => {
  beforeEach(() => {
    for (const key of Object.keys(mocks) as Array<keyof typeof mocks>) {
      mocks[key].mockReset();
    }
  });

  it('returns plain page title when focus is absent', async () => {
    const mod = await import('./page');
    const meta = await mod.generateMetadata({
      searchParams: Promise.resolve({}),
    });
    expect(meta.title).toBe('metadata.page_library');
    expect(mocks.getEntity).not.toHaveBeenCalled();
    expect(mocks.getNote).not.toHaveBeenCalled();
    expect(mocks.getSourceView).not.toHaveBeenCalled();
  });

  it('kind=entity uses client.getEntity', async () => {
    arm();
    mocks.getEntity.mockResolvedValue({
      entity: { id: 42, name: 'Anthropic', description: null },
    } as unknown as EntityDetail);
    const mod = await import('./page');
    const meta = await mod.generateMetadata({
      searchParams: Promise.resolve({ focus: '42', kind: 'entity' }),
    });
    expect(mocks.getEntity).toHaveBeenCalledWith(42);
    expect(meta.title).toContain('Anthropic');
  });

  it('kind=note uses client.getNote and truncates long content', async () => {
    arm();
    mocks.getNote.mockResolvedValue({
      id: 7,
      content: 'a'.repeat(120),
    } as unknown as NoteDetail);
    const mod = await import('./page');
    const meta = await mod.generateMetadata({
      searchParams: Promise.resolve({ focus: '7', kind: 'note' }),
    });
    expect(mocks.getNote).toHaveBeenCalledWith(7);
    expect(meta.title).toContain('…');
  });

  it('kind=source uses client.getSourceView', async () => {
    arm();
    mocks.getSourceView.mockResolvedValue({
      source: { id: 99, title: 'Source Title', originalUrl: null },
    } as unknown as SourceViewDetail);
    const mod = await import('./page');
    const meta = await mod.generateMetadata({
      searchParams: Promise.resolve({ focus: '99', kind: 'source' }),
    });
    expect(mocks.getSourceView).toHaveBeenCalledWith(99);
    expect(meta.title).toContain('Source Title');
  });

  it('falls back to plain title on non-redirect errors and logs to console.error', async () => {
    arm();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getEntity.mockRejectedValue(new Error('boom'));
    const mod = await import('./page');
    const meta = await mod.generateMetadata({
      searchParams: Promise.resolve({ focus: '5', kind: 'entity' }),
    });
    expect(meta.title).toBe('metadata.page_library');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rethrows NEXT_REDIRECT errors so the user gets sent to /login', async () => {
    arm();
    mocks.getEntity.mockRejectedValue(buildRedirectError('/login'));
    const mod = await import('./page');
    await expect(
      mod.generateMetadata({
        searchParams: Promise.resolve({ focus: '5', kind: 'entity' }),
      }),
    ).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT;/) });
  });
});

describe('LibraryPage default — NEXT_REDIRECT pass-through per Promise.all handler', () => {
  // F-PAGE-METADATA-NO-TEST / F-PAGE-EMPTY-NO-TEST: each of the four
  // `.then(_, err)` rejection branches must rethrow NEXT_REDIRECT errors
  // BEFORE building the failure envelope — otherwise a transient auth-loss
  // turns into a silent "load failed" tile and the user never gets redirected
  // to /login. We mock each individual fetch as rejecting with a redirect-
  // shaped error in turn and assert the page itself throws (not falls back to
  // an `{error}` envelope).

  it('entities fetch rejecting with NEXT_REDIRECT propagates to caller', async () => {
    arm();
    mocks.getEntities.mockRejectedValueOnce(buildRedirectError('/login'));
    const mod = await import('./page');
    await expect(mod.default({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT;/),
    });
  });

  it('active notes fetch rejecting with NEXT_REDIRECT propagates', async () => {
    arm();
    // First listNotes call (active, archived=false) rejects with redirect;
    // second call (archived=true) resolves normally so we don't muddy the
    // failure isolation assertion.
    mocks.listNotes
      .mockRejectedValueOnce(buildRedirectError('/login'))
      .mockResolvedValueOnce(sampleNotes);
    const mod = await import('./page');
    await expect(mod.default({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT;/),
    });
  });

  it('archived notes fetch rejecting with NEXT_REDIRECT propagates', async () => {
    arm();
    // Active resolves, archived rejects with redirect.
    mocks.listNotes
      .mockResolvedValueOnce(sampleNotes)
      .mockRejectedValueOnce(buildRedirectError('/login'));
    const mod = await import('./page');
    await expect(mod.default({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT;/),
    });
  });

  it('confirmed sources fetch rejecting with NEXT_REDIRECT propagates', async () => {
    arm();
    // First listSources call (confirmed) rejects, second (confirmed_empty)
    // would resolve normally — but Promise.all sees the rejection first.
    mocks.listSources
      .mockRejectedValueOnce(buildRedirectError('/login'))
      .mockResolvedValueOnce(sampleSources);
    const mod = await import('./page');
    await expect(mod.default({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT;/),
    });
  });

  it('confirmed_empty sources fetch rejecting with NEXT_REDIRECT propagates', async () => {
    arm();
    mocks.listSources
      .mockResolvedValueOnce(sampleSources)
      .mockRejectedValueOnce(buildRedirectError('/login'));
    const mod = await import('./page');
    await expect(mod.default({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT;/),
    });
  });
});

describe('LibraryPage default — graceful degradation', () => {
  it('confirmed_empty failure: page still renders with confirmed sources + emits confirmedEmptyFailed', async () => {
    arm();
    // confirmed succeeds, confirmed_empty fails with a regular error (not
    // NEXT_REDIRECT) — page should degrade silently rather than throw.
    const baseSources = {
      data: [{ id: 11, kind: 'external', status: 'confirmed' }],
      counts: { processing: 0, confirmed: 1, confirmed_empty: 0, failed: 0, discarded: 0 },
    };
    mocks.listSources
      .mockResolvedValueOnce(baseSources)
      .mockRejectedValueOnce(new Error('confirmed_empty fetch boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mod = await import('./page');
    const tree = await mod.default({ searchParams: Promise.resolve({}) });

    // Page returns a React element; the page function itself doesn't render
    // child components (React would do that during commit). Reach into the
    // element's `.props` directly to inspect what gets passed downstream.
    const props = (tree as unknown as { props: Record<string, unknown> }).props;
    // Main confirmed list still rendered (sourcesResult.ok contains the
    // confirmed row + the empty list collapsed to []).
    expect(props.sourcesResult).toMatchObject({
      ok: expect.arrayContaining([baseSources.data[0]]),
    });
    // confirmedEmptyFailed signal is true so SourcesSection can render the
    // inline degraded notice.
    expect(props.confirmedEmptyFailed).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('archived notes failure: page still renders with active notes + passes archived error', async () => {
    arm();
    const activeNotes = {
      data: [
        {
          id: 1,
          content: 'active',
          subtype: 'memo' as const,
          tags: [],
          linkedEntities: [],
          linkedSources: [],
          pinned: false,
          archived: false,
          sourceMessageId: null,
          conversationId: null,
          contentTranslated: null,
          language: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      nextCursor: null,
    };
    mocks.listNotes
      .mockResolvedValueOnce(activeNotes)
      .mockRejectedValueOnce(new Error('archived fetch boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mod = await import('./page');
    const tree = await mod.default({ searchParams: Promise.resolve({}) });

    const props = (tree as unknown as { props: Record<string, unknown> }).props;
    expect(props.notesResult).toMatchObject({ ok: activeNotes.data });
    expect(props.archivedNotes).toEqual([]);
    expect(props.archivedNotesError).toBe('library.section_load_failed_archived_notes');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('confirmed sources failure: sourcesResult becomes {error}, page does NOT throw', async () => {
    arm();
    mocks.listSources
      .mockRejectedValueOnce(new Error('confirmed fetch boom'))
      .mockResolvedValueOnce(sampleSources);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mod = await import('./page');
    const tree = await mod.default({ searchParams: Promise.resolve({}) });

    const props = (tree as unknown as { props: Record<string, unknown> }).props;
    expect(props.sourcesResult).toMatchObject({ error: expect.any(String) });
    // When the main fetch fails entirely there is no separate confirmedEmpty
    // signal to render — we go through the error branch.
    expect(props.confirmedEmptyFailed).toBe(false);
    spy.mockRestore();
  });
});
