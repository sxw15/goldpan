import { GoldpanApiError } from './errors';
import type {
  CancelBufferedResult,
  CategoryTree,
  CommitEnvResult,
  ConversationDetail,
  ConversationListParams,
  ConversationSummary,
  CreateInterestInput,
  CreateNoteInput,
  DebugTaskDetail,
  DigestConnection,
  DigestConnectionsParams,
  DigestDataSnapshot,
  DigestPreset,
  DigestShareResponse,
  DigestSnapshotResponse,
  Entity,
  EntityDetail,
  EntityListParams,
  EntityNameLookupResult,
  EnvStateResponse,
  GithubRefreshResult,
  GithubRepoState,
  GoldpanClientOptions,
  HealthStatus,
  ImActionResult,
  ImSettingsManifest,
  InputParams,
  InputResult,
  Interest,
  InterestDetail,
  InterestExecutionDetail,
  InterestExecutionListParams,
  InterestExecutionListResult,
  InterestListItem,
  ListNotesParams,
  ListNotesResult,
  LlmCallDetail,
  LlmProvidersResponse,
  LoginResult,
  MarkNoteRemindedOptions,
  MarkNoteRemindedResult,
  NoteDetail,
  PaginatedList,
  PluginActionResult,
  PluginSettingsContributionsResponse,
  PluginsSnapshot,
  PromoteNoteResult,
  QueryResult,
  ReleaseBufferedResult,
  ResolveTrackingResult,
  SearchToolStatus,
  ServerRestartResult,
  SourceDetail,
  SourceListParams,
  SourceListResponse,
  SourceViewDetail,
  SourceViewListParams,
  SourceViewListResult,
  SubmitResult,
  SystemStatus,
  TaskDetail,
  TaskListParams,
  TaskListResponse,
  TranslateNoteResult,
  UpdateInterestInput,
  UpdateNoteInput,
} from './types';

type QueryParamPrimitive = string | number | boolean;
type QueryParams = Record<string, QueryParamPrimitive | readonly QueryParamPrimitive[] | undefined>;

// P2 新增 wait / note / tracking_pending；server 端 main.ts switch (result.type)
// 已序列化这三类响应（200/OK），客户端 filter 必须放行，否则会被错误地
// 当作未知响应 throw 成 GoldpanApiError。
const INPUT_RESULT_TYPES = new Set([
  'submit',
  'query',
  'content',
  'action',
  'clarify',
  'wait',
  'note',
  'tracking_pending',
]);
const SUBMIT_RESULT_STATUSES = new Set(['accepted', 'duplicate', 'rejected']);

export class GoldpanClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly credentials: 'include' | 'omit' | 'same-origin' | undefined;
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly retryNetworkErrors: { attempts: number; baseDelayMs: number } | undefined;

  constructor(options: GoldpanClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.credentials = options.credentials;
    this.onUnauthorized = options.onUnauthorized;
    this.retryNetworkErrors = options.retryNetworkErrors
      ? {
          attempts: Math.max(1, options.retryNetworkErrors.attempts),
          baseDelayMs: options.retryNetworkErrors.baseDelayMs ?? 200,
        }
      : undefined;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private buildUrl(path: string, params?: QueryParams): string {
    let url = `${this.baseUrl}${path}`;
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          if (Array.isArray(value)) {
            for (const item of value) searchParams.append(key, String(item));
          } else {
            searchParams.set(key, String(value));
          }
        }
      }
      const query = searchParams.toString();
      if (query) url += `?${query}`;
    }
    return url;
  }

  private async fetchRaw(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    params?: QueryParams,
    fetchOptions?: RequestInit,
  ): Promise<Response> {
    const url = this.buildUrl(path, params);
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    const init: RequestInit = {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
      credentials: this.credentials,
      ...(fetchOptions ?? {}),
    };
    if (!this.retryNetworkErrors) return fetch(url, init);
    // Retry only on network failures (TypeError thrown by fetch). HTTP
    // statuses come back as a Response — those are the caller's domain to
    // interpret and we never retry them. Caller-supplied AbortSignal is
    // honoured: if it fires we surface the abort immediately, no retry.
    const { attempts, baseDelayMs } = this.retryNetworkErrors;
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await fetch(url, init);
      } catch (err) {
        lastErr = err;
        if (signal?.aborted) throw err;
        if (attempt === attempts - 1) break;
        await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  /** Parse JSON body defensively — returns `null` on empty / unparseable so
   * callers can still surface a sensible GoldpanApiError based on status. */
  private async parseBody(response: Response): Promise<Record<string, unknown> | null> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** fetchRaw + 401-side-effect + parseBody. Used by every method that wants
   * the standard auth-aware response handling but needs custom success
   * discrimination (input/submit/deleteDigestPreset) or shape (request). */
  private async fetchAndParse(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    params?: QueryParams,
    fetchOptions?: RequestInit,
  ): Promise<{ response: Response; data: Record<string, unknown> | null }> {
    const response = await this.fetchRaw(method, path, body, signal, params, fetchOptions);
    if (response.status === 401) {
      this.onUnauthorized?.();
    }
    const data = await this.parseBody(response);
    return { response, data };
  }

  private buildApiError(
    response: Response,
    data: Record<string, unknown> | null,
    fallbackMessage: string,
  ): GoldpanApiError {
    return new GoldpanApiError(
      (data?.message as string | undefined) ?? fallbackMessage,
      (data?.code as string | undefined) ?? 'unknown',
      response.status,
      data,
    );
  }

  // ---------------------------------------------------------------------------
  // Public: generic typed request
  // ---------------------------------------------------------------------------

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    params?: QueryParams,
    options?: { fetchOptions?: RequestInit },
  ): Promise<T> {
    const { response, data } = await this.fetchAndParse(
      method,
      path,
      body,
      signal,
      params,
      options?.fetchOptions,
    );

    if (response.status === 204) return undefined as T;
    if (!response.ok) throw this.buildApiError(response, data, 'Request failed');

    return data as T;
  }

  /** Unwraps server `{ data: T }` envelopes — the convention used by the
   * tracking routes. */
  private async requestUnwrap<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    params?: QueryParams,
  ): Promise<T> {
    const res = await this.request<{ data: T }>(method, path, body, signal, params);
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  /**
   * Log in with a password. A 401 from `/auth/login` means "invalid password",
   * which is a business response — not an expired session. We therefore do
   * NOT route this call through `fetchAndParse()` (which fires
   * `onUnauthorized`); otherwise a failed login would wrongly clear any
   * existing session or loop the app back to the login screen it is on.
   */
  async login(password: string): Promise<LoginResult> {
    const response = await this.fetchRaw('POST', '/auth/login', { password });
    if (response.status === 204) return {} as LoginResult;
    const data = await this.parseBody(response);
    if (!response.ok) throw this.buildApiError(response, data, 'Request failed');
    return data as LoginResult;
  }

  async logout(): Promise<void> {
    await this.request<unknown>('POST', '/auth/logout');
  }

  async getStatus(): Promise<SystemStatus> {
    return this.request<SystemStatus>('GET', '/auth/status');
  }

  // ---------------------------------------------------------------------------
  // Input / Submit / Query
  // ---------------------------------------------------------------------------

  async input(req: InputParams, signal?: AbortSignal): Promise<InputResult> {
    const { response, data } = await this.fetchAndParse('POST', '/input', req, signal);

    // The server uses HTTP 201 / 409 / 400 for submit-shaped results
    // (accepted / duplicate / rejected); discriminate by payload `type` rather
    // than `response.ok`. Only an unrecognized shape raises.
    if (INPUT_RESULT_TYPES.has(data?.type as string)) {
      return data as unknown as InputResult;
    }
    throw this.buildApiError(response, data, 'Input processing failed');
  }

  async submit(text: string): Promise<SubmitResult> {
    const { response, data } = await this.fetchAndParse('POST', '/submit', { input: text });
    if (SUBMIT_RESULT_STATUSES.has(data?.status as string)) {
      return data as unknown as SubmitResult;
    }
    throw this.buildApiError(response, data, 'Submit failed');
  }

  async query(text: string, signal?: AbortSignal): Promise<QueryResult> {
    return this.request<QueryResult>('POST', '/query', { query: text }, signal);
  }

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------

  async getActiveConversationId(channelId: string): Promise<{ id: number | null }> {
    return this.request<{ id: number | null }>(
      'GET',
      '/conversations/active',
      undefined,
      undefined,
      { channelId },
    );
  }

  async listConversations(
    params: ConversationListParams,
  ): Promise<{ items: ConversationSummary[]; total: number }> {
    return this.request<{ items: ConversationSummary[]; total: number }>(
      'GET',
      '/conversations',
      undefined,
      undefined,
      {
        channelId: params.channelId,
        limit: params.limit,
        offset: params.offset,
        includeActive: params.includeActive,
      },
    );
  }

  async getConversation(id: number): Promise<ConversationDetail> {
    return this.request<ConversationDetail>('GET', `/conversations/${id}`);
  }

  async createNewConversation(channelId: string, sessionKey?: string): Promise<{ id: number }> {
    return this.request<{ id: number }>('POST', '/conversations/new', {
      channelId,
      ...(sessionKey !== undefined && { sessionKey }),
    });
  }

  async unarchiveConversation(id: number): Promise<{ id: number }> {
    return this.request<{ id: number }>('POST', `/conversations/${id}/unarchive`);
  }

  async deleteConversation(id: number): Promise<void> {
    await this.request<unknown>('DELETE', `/conversations/${id}`);
  }

  // ---------------------------------------------------------------------------
  // P3 Buffer mechanism — release / cancel a buffered message
  // ---------------------------------------------------------------------------
  //
  // Server 端用 CAS（compare-and-swap）保证 release/cancel/倒计时归零三者互斥：
  // 第一个赢家把 buffered message 标记为 finalized，后续调用返回 200 + executed
  // (或 cancelled) = false + reason='already_finalized'。所以这两个 method 不
  // 抛错处理"已 finalize"的情况，由 caller 看 executed/cancelled 决定 UI。

  /**
   * 立即释放一条 buffered message（用户点"立即执行"或倒计时归零时调）。
   * 服务端会取消 buffer 倒计时并立刻 finalize 原 intent。
   */
  async releaseBufferedMessage(
    messageId: number,
    signal?: AbortSignal,
  ): Promise<ReleaseBufferedResult> {
    return this.request<ReleaseBufferedResult>(
      'POST',
      `/conversations/buffered/${messageId}/release`,
      undefined,
      signal,
    );
  }

  /**
   * 取消一条 buffered message（用户点"取消"）。
   * 服务端会取消 buffer 倒计时并把 message 标记为 cancelled，不会执行原 intent。
   */
  async cancelBufferedMessage(
    messageId: number,
    signal?: AbortSignal,
  ): Promise<CancelBufferedResult> {
    return this.request<CancelBufferedResult>(
      'POST',
      `/conversations/buffered/${messageId}/cancel`,
      undefined,
      signal,
    );
  }

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------

  async getTasks(params?: TaskListParams, signal?: AbortSignal): Promise<TaskListResponse> {
    return this.request<TaskListResponse>('GET', '/tasks', undefined, signal, {
      limit: params?.limit,
      // Comma-join assumes status enum values never contain `,` — true for
      // the current `TaskStatus` union; revisit if it ever changes.
      status: params?.status?.length ? params.status.join(',') : undefined,
    });
  }

  async getTask(taskId: number, signal?: AbortSignal): Promise<TaskDetail> {
    return this.request<TaskDetail>('GET', `/tasks/${taskId}`, undefined, signal);
  }

  async retryTask(taskId: number): Promise<void> {
    await this.request<unknown>('POST', `/tasks/${taskId}/retry`);
  }

  async deleteTask(taskId: number): Promise<void> {
    await this.request<unknown>('DELETE', `/tasks/${taskId}`);
  }

  async clearTaskLogs(taskId: number): Promise<void> {
    await this.request<unknown>('DELETE', `/tasks/${taskId}/logs`);
  }

  // ---------------------------------------------------------------------------
  // Knowledge
  // ---------------------------------------------------------------------------

  async getCategories(): Promise<CategoryTree> {
    return this.request<CategoryTree>('GET', '/categories');
  }

  async getEntities(params?: EntityListParams): Promise<PaginatedList<Entity>> {
    return this.request<PaginatedList<Entity>>('GET', '/entities', undefined, undefined, {
      category: params?.category,
    });
  }

  async getEntity(entityId: number, signal?: AbortSignal): Promise<EntityDetail> {
    return this.request<EntityDetail>('GET', `/entities/${entityId}`, undefined, signal);
  }

  /**
   * Batch-lookup entities by name (case-insensitive). Returns a map of
   * lowercased-name → entity id. Empty input short-circuits without HTTP.
   * Used by P7.3 mention parsing in NotePayload.
   */
  async lookupEntitiesByName(
    names: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, number>> {
    const deduped = Array.from(new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean)));
    if (deduped.length === 0) return {};
    const result = await this.request<EntityNameLookupResult>(
      'GET',
      '/entities',
      undefined,
      signal,
      { name: deduped },
    );
    return result.data;
  }

  async listSources(params?: SourceListParams): Promise<SourceListResponse> {
    // Comma-join assumes status enum values never contain `,` — true for the
    // current `SourceStatus` union; revisit if it ever changes.
    const status = Array.isArray(params?.status)
      ? params?.status.join(',')
      : (params?.status as string | undefined);
    return this.request<SourceListResponse>('GET', '/sources', undefined, undefined, {
      status,
      origin: params?.origin,
      limit: params?.limit,
    });
  }

  async getSource(sourceId: number, signal?: AbortSignal): Promise<SourceDetail> {
    return this.request<SourceDetail>('GET', `/sources/${sourceId}`, undefined, signal);
  }

  async discardSource(sourceId: number): Promise<void> {
    await this.request<unknown>('POST', `/sources/${sourceId}/discard`);
  }

  // ---------------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------------

  async listSourceView(params?: SourceViewListParams): Promise<SourceViewListResult> {
    return this.request<SourceViewListResult>('GET', '/notes', undefined, undefined, {
      category: params?.category,
    });
  }

  async getSourceView(sourceId: number, signal?: AbortSignal): Promise<SourceViewDetail> {
    return this.request<SourceViewDetail>('GET', `/notes/${sourceId}`, undefined, signal);
  }

  // User-note CRUD (P1 added; P6 dropped User prefix once SourceView rename freed Note*).

  async createNote(input: CreateNoteInput, signal?: AbortSignal): Promise<NoteDetail> {
    return this.request<NoteDetail>('POST', '/user-notes', input, signal);
  }

  async listNotes(params?: ListNotesParams, signal?: AbortSignal): Promise<ListNotesResult> {
    return this.request<ListNotesResult>('GET', '/user-notes', undefined, signal, {
      subtype: Array.isArray(params?.subtype) ? params.subtype.join(',') : params?.subtype,
      tag: params?.tag,
      entityId: params?.entityId?.toString(),
      sourceId: params?.sourceId?.toString(),
      pinned: params?.pinned !== undefined ? String(params.pinned) : undefined,
      archived: params?.archived !== undefined ? String(params.archived) : undefined,
      search: params?.search,
      limit: params?.limit?.toString(),
      cursor: params?.cursor?.toString(),
      dueBefore: params?.dueBefore !== undefined ? String(params.dueBefore) : undefined,
      // Server treats `hasReminder=false` as undefined (asymmetric — only `true` filters).
      // SDK still serializes both, but documented contract is "only pass true".
      hasReminder: params?.hasReminder === true ? 'true' : undefined,
    });
  }

  async getNote(id: number, signal?: AbortSignal): Promise<NoteDetail> {
    return this.request<NoteDetail>('GET', `/user-notes/${id}`, undefined, signal);
  }

  async updateNote(id: number, patch: UpdateNoteInput, signal?: AbortSignal): Promise<NoteDetail> {
    return this.request<NoteDetail>('PATCH', `/user-notes/${id}`, patch, signal);
  }

  async deleteNote(id: number): Promise<void> {
    await this.request<unknown>('DELETE', `/user-notes/${id}`);
  }

  /**
   * Promote a user-note to a full source: re-submits its content through the
   * pipeline and links the result via note_sources(relation='derived_from').
   * Returns { taskId, sourceId } — caller typically navigates to /tasks/:id.
   */
  async promoteNote(noteId: number, signal?: AbortSignal): Promise<PromoteNoteResult> {
    return this.request<PromoteNoteResult>(
      'POST',
      `/user-notes/${noteId}/promote`,
      undefined,
      signal,
    );
  }

  /**
   * Translate a user-note's content into the server's configured language
   * (`config.language` / GOLDPAN_LANGUAGE). Reuses the pipeline translator
   * step under the hood; UI typically disables the trigger button while
   * pending and setDetail() the returned contentTranslated.
   */
  async translateNote(noteId: number, signal?: AbortSignal): Promise<TranslateNoteResult> {
    return this.request<TranslateNoteResult>(
      'POST',
      `/user-notes/${noteId}/translate`,
      undefined,
      signal,
    );
  }

  /**
   * Mark a note as reminded (client UI displayed the due-reminder banner
   * and user acknowledged). Sets server-side `notes.reminded_at = now`.
   * 404 if the note no longer exists.
   */
  async markNoteReminded(noteId: number, signal?: AbortSignal): Promise<MarkNoteRemindedResult>;
  async markNoteReminded(
    noteId: number,
    options?: MarkNoteRemindedOptions,
    signal?: AbortSignal,
  ): Promise<MarkNoteRemindedResult>;
  async markNoteReminded(
    noteId: number,
    optionsOrSignal?: MarkNoteRemindedOptions | AbortSignal,
    signal?: AbortSignal,
  ): Promise<MarkNoteRemindedResult> {
    const options =
      optionsOrSignal !== undefined &&
      'aborted' in optionsOrSignal &&
      typeof optionsOrSignal.addEventListener === 'function'
        ? undefined
        : optionsOrSignal;
    const requestSignal =
      optionsOrSignal !== undefined &&
      'aborted' in optionsOrSignal &&
      typeof optionsOrSignal.addEventListener === 'function'
        ? optionsOrSignal
        : signal;
    const body =
      options?.expectedDueAt !== undefined ? { expectedDueAt: options.expectedDueAt } : undefined;
    return this.request<MarkNoteRemindedResult>(
      'POST',
      `/user-notes/${noteId}/mark-reminded`,
      body,
      requestSignal,
    );
  }

  // ---------------------------------------------------------------------------
  // Tracking / Interest
  // ---------------------------------------------------------------------------
  //
  // Backward-compatible URL: the HTTP path is `/tracking/rules/*` (the T1/T2
  // rename stopped short of renaming the URL). Method names use the new
  // "interest" vocabulary.

  async getInterests(): Promise<PaginatedList<InterestListItem>> {
    const res = await this.request<{ data: InterestListItem[]; total?: number }>(
      'GET',
      '/tracking/rules',
    );
    return { data: res.data, total: res.total ?? res.data.length };
  }

  /**
   * Probe whether any web-search tool plugin is registered with an active
   * `search` capability. The endpoint inspects the global plugin registry, so
   * an empty `providers` list also covers the case where every search-tool
   * plugin is missing its API key.
   */
  async getSearchToolStatus(): Promise<SearchToolStatus> {
    return this.request<SearchToolStatus>('GET', '/tracking/search-tool-status');
  }

  async getInterest(id: number, signal?: AbortSignal): Promise<InterestDetail> {
    return this.requestUnwrap<InterestDetail>('GET', `/tracking/rules/${id}`, undefined, signal);
  }

  async createInterest(data: CreateInterestInput): Promise<Interest> {
    return this.requestUnwrap<Interest>('POST', '/tracking/rules', data);
  }

  async updateInterest(id: number, data: UpdateInterestInput): Promise<Interest> {
    return this.requestUnwrap<Interest>('PUT', `/tracking/rules/${id}`, data);
  }

  async deleteInterest(id: number): Promise<void> {
    await this.request<unknown>('DELETE', `/tracking/rules/${id}`);
  }

  async enableInterest(id: number): Promise<Interest> {
    return this.requestUnwrap<Interest>('POST', `/tracking/rules/${id}/enable`);
  }

  async disableInterest(id: number): Promise<Interest> {
    return this.requestUnwrap<Interest>('POST', `/tracking/rules/${id}/disable`);
  }

  /**
   * Trigger an immediate execution. 409 `scheduler_disabled` is surfaced as a
   * `GoldpanApiError` (not swallowed) so callers can render "scheduler is
   * disabled" UI rather than silently appearing successful.
   */
  async triggerInterest(id: number): Promise<void> {
    await this.request<unknown>('POST', `/tracking/rules/${id}/run`);
  }

  /**
   * Promote an `awaiting_clarify` tracking rule to `resolved` by binding the
   * user-picked entity. UI clarify-chip click path; server enforces CAS via
   * `expectedStatus='awaiting_clarify'`, so a concurrent clarify-timeout /
   * other-tab finalize loses with 409 `race_conflict` rather than silently
   * overwriting. Unlike most tracking routes, the response is a flat object
   * (no `{ data }` envelope) — keep `request<T>()`, not `requestUnwrap`.
   */
  async resolveTrackingClarify(
    ruleId: number,
    entityId: number,
    signal?: AbortSignal,
  ): Promise<ResolveTrackingResult> {
    return this.request<ResolveTrackingResult>(
      'POST',
      `/tracking/rules/${ruleId}/resolve`,
      { entityId },
      signal,
    );
  }

  /** Server clamps `perPage` to 1..100 (default 30) and `page` to ≥1; this
   * client does not re-validate. */
  async getInterestExecutions(
    id: number,
    params?: InterestExecutionListParams,
  ): Promise<InterestExecutionListResult> {
    return this.request<InterestExecutionListResult>(
      'GET',
      `/tracking/rules/${id}/executions`,
      undefined,
      undefined,
      { page: params?.page, perPage: params?.perPage },
    );
  }

  /** The server strips `sourceId` from each item before serializing. */
  async getInterestExecution(executionId: number): Promise<InterestExecutionDetail> {
    return this.requestUnwrap<InterestExecutionDetail>(
      'GET',
      `/tracking/executions/${executionId}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------------------

  async getDebugTask(taskId: number): Promise<DebugTaskDetail> {
    return this.request<DebugTaskDetail>('GET', `/debug/tasks/${taskId}`);
  }

  async getDebugLlmCall(callId: number): Promise<LlmCallDetail> {
    return this.request<LlmCallDetail>('GET', `/debug/llm-calls/${callId}`);
  }

  // ---------------------------------------------------------------------------
  // GitHub
  // ---------------------------------------------------------------------------

  async refreshGithub(owner: string, repo: string): Promise<GithubRefreshResult> {
    return this.request<GithubRefreshResult>('POST', '/github/refresh', { owner, repo });
  }

  async refreshGithubByUrl(normalizedUrl: string): Promise<GithubRefreshResult> {
    return this.request<GithubRefreshResult>('POST', '/github/refresh-by-url', { normalizedUrl });
  }

  async getGithubState(owner: string, repo: string): Promise<{ data: GithubRepoState | null }> {
    return this.request<{ data: GithubRepoState | null }>(
      'GET',
      '/github/state',
      undefined,
      undefined,
      { owner, repo },
    );
  }

  // ---------------------------------------------------------------------------
  // Digest
  // ---------------------------------------------------------------------------

  async getDigestPreview(params: {
    channel: string;
    date?: string;
    presetId?: number;
    forceRegenerate?: boolean;
  }): Promise<DigestSnapshotResponse> {
    return this.request<DigestSnapshotResponse>('GET', '/digest/preview', undefined, undefined, {
      channel: params.channel,
      date: params.date,
      presetId: params.presetId,
      forceRegenerate: params.forceRegenerate,
    });
  }

  async getDigestConnections(
    params: DigestConnectionsParams,
    signal?: AbortSignal,
  ): Promise<{ data: DigestConnection[]; total: number }> {
    return this.request<{ data: DigestConnection[]; total: number }>(
      'GET',
      '/digest/connections',
      undefined,
      signal,
      {
        since: params.since,
        limit: params.limit ?? 5,
      },
    );
  }

  async getDigestShare(id: number, sig: string): Promise<DigestShareResponse> {
    return this.request<DigestShareResponse>(
      'GET',
      `/digest/share/${id}`,
      undefined,
      undefined,
      { sig },
      { fetchOptions: { cache: 'no-store' } },
    );
  }

  async listDigestPresets(channel: string): Promise<{ presets: DigestPreset[] }> {
    return this.request<{ presets: DigestPreset[] }>(
      'GET',
      '/digest/presets',
      undefined,
      undefined,
      { channel },
    );
  }

  /**
   * Mint a signed read-only share URL. Returns 503 with code
   * `share_link_disabled` when `GOLDPAN_DIGEST_LINK_SIGNING_KEY` or
   * `GOLDPAN_DIGEST_PUBLIC_BASE_URL` are not set. 404 when no `daily_reports`
   * row matches the key.
   */
  async createDigestShareLink(input: {
    channel: string;
    date: string;
    presetId?: number | null;
  }): Promise<{ url: string; ttlDays: number }> {
    return this.request<{ url: string; ttlDays: number }>('POST', '/digest/share-link', {
      channel: input.channel,
      date: input.date,
      ...(input.presetId !== undefined ? { presetId: input.presetId } : {}),
    });
  }

  async getDigestHistory(
    date: string,
    params: { channel?: string; presetId?: number } = {},
  ): Promise<{ snapshot: DigestDataSnapshot | null }> {
    return this.request<{ snapshot: DigestDataSnapshot | null }>(
      'GET',
      `/digest/history/${date}`,
      undefined,
      undefined,
      {
        channel: params.channel,
        presetId: params.presetId,
      },
    );
  }

  async createDigestPreset(
    channel: string,
    input: Omit<DigestPreset, 'id' | 'channel'>,
  ): Promise<{ preset: DigestPreset }> {
    return this.request<{ preset: DigestPreset }>('POST', '/digest/presets', input, undefined, {
      channel,
    });
  }

  async updateDigestPreset(
    id: number,
    patch: Partial<Omit<DigestPreset, 'id' | 'channel'>>,
  ): Promise<{ preset: DigestPreset }> {
    return this.request<{ preset: DigestPreset }>('PATCH', `/digest/presets/${id}`, patch);
  }

  /**
   * Delete a preset. The 409 `preset_in_use` branch is a legitimate business
   * response (the preset is still referenced by IM-managed digest
   * subscriptions, which have no web-sdk surface), not an error.
   */
  async deleteDigestPreset(
    id: number,
  ): Promise<{ ok: true } | { error: { code: 'preset_in_use'; usages: unknown[] } }> {
    const { response, data } = await this.fetchAndParse('DELETE', `/digest/presets/${id}`);
    if (response.status === 409 && data?.code === 'preset_in_use') {
      return {
        error: {
          code: 'preset_in_use',
          usages: (data.usages as unknown[] | undefined) ?? [],
        },
      };
    }
    if (!response.ok) throw this.buildApiError(response, data, 'Delete failed');
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Settings (env-file editing)
  // ---------------------------------------------------------------------------

  /**
   * Snapshot of every `MANAGED_ENV_KEYS` entry: configured / mask / source.
   * Secrets (KEY/TOKEN/SECRET/PASSWORD suffix) come back masked, never as
   * raw plaintext.
   */
  async getEnvState(): Promise<EnvStateResponse> {
    return this.request<EnvStateResponse>('GET', '/settings/env-state');
  }

  /**
   * List all loaded plugins (collector / intent / tool / llm-provider) for the
   * settings page. Snapshot is read-only — install / uninstall is not yet
   * supported (`registryInstallSupported: false`).
   *
   * `locale` selects per-language descriptions on the server side
   * (`descriptions[locale]` on each plugin, falling back to the default
   * English-first `description`). Omit to let the server use its effective
   * `GOLDPAN_LANGUAGE`; pass `'en'` / `'zh'` explicitly to override.
   */
  async listPlugins(locale?: 'en' | 'zh'): Promise<PluginsSnapshot> {
    const path =
      locale !== undefined
        ? `/settings/plugins?locale=${encodeURIComponent(locale)}`
        : '/settings/plugins';
    return this.request<PluginsSnapshot>('GET', path);
  }

  /**
   * Apply a partial patch to managed env keys. The server validates and
   * persists the patch as a DB-backed runtime override, then applies it to
   * `process.env` so listeners (LLM registry, etc.) pick up the new values
   * without a restart. Whitelist-filtered server-side against
   * `MANAGED_ENV_KEYS` + the active plugin envKey set; unknown keys reject
   * the entire patch (no partial writes).
   *
   * Each value may be a string (write/replace the override) or `null`
   * (delete the override → revert to the boot-env baseline / default).
   *
   * All 400 outcomes — both cross-field validation rejections (from the
   * server's `configStore.commit`, returned as `{kind:'errors'}`) and
   * route-layer input rejections (`unknown_keys` / `invalid_values` /
   * `empty_patch` / `invalid_input`, returned as the generic
   * `{type:'error', code, message}` envelope) — are normalized into
   * `CommitEnvResult.errors` so the UI only has to discriminate one shape.
   */
  async commitEnv(patch: Record<string, string | null>): Promise<CommitEnvResult> {
    const { response, data } = await this.fetchAndParse('POST', '/settings/env', { patch });
    if (response.ok) {
      return data as CommitEnvResult;
    }
    if (response.status === 400 && data) {
      if ((data as { kind?: unknown }).kind === 'errors') {
        return data as CommitEnvResult;
      }
      // Generic error envelope from the route layer. Convert into the same
      // CommitEnvResult.errors shape so the UI doesn't have to handle two
      // error formats (and so a typo'd key never silently surfaces as a
      // generic transport error).
      const code =
        typeof (data as { code?: unknown }).code === 'string'
          ? (data as { code: string }).code
          : undefined;
      const message =
        typeof (data as { message?: unknown }).message === 'string'
          ? (data as { message: string }).message
          : 'Invalid input';
      if (code !== undefined) {
        return { kind: 'errors', errors: [{ path: '', message, code }] };
      }
    }
    throw this.buildApiError(response, data, 'commit env failed');
  }

  /**
   * Download the current DB overrides as a `.env` snippet. The server returns
   * raw text (`text/plain`) plus a `Content-Disposition: attachment;
   * filename="goldpan-overrides-YYYY-MM-DD.env"` header. We expose both the
   * text and the suggested filename so the browser can trigger a save dialog
   * via Blob + anchor click. Falls back to a generic filename if the header
   * is somehow missing (defensive — the server always sets it today).
   *
   * Read-only — does NOT mutate config. Auth-aware: 401 fires the
   * `onUnauthorized` side-effect just like every other write/read.
   */
  async exportOverrides(): Promise<{ text: string; filename: string }> {
    const response = await this.fetchRaw('GET', '/settings/export-overrides');
    if (response.status === 401) {
      this.onUnauthorized?.();
    }
    if (!response.ok) {
      // Body MAY be JSON (route layer error envelope) or empty — try
      // parseBody and fall back to a generic message so the caller gets a
      // typed GoldpanApiError matching every other SDK method.
      const data = await this.parseBody(response);
      throw this.buildApiError(response, data, 'export overrides failed');
    }
    const text = await response.text();
    const cd = response.headers.get('content-disposition') ?? '';
    // Match either quoted filename="..." or bare filename=token.
    const m = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\s]+)/i.exec(cd);
    const filename = m?.[1] ?? m?.[2] ?? 'goldpan-overrides.env';
    return { text, filename };
  }

  /**
   * Snapshot of all registered LLM providers (builtin / custom / plugin).
   * Read-only — config writes still happen via `commitEnv` (DB-backed
   * runtime override). Full UI write loop blocked on MANAGED_ENV_KEYS
   * dynamic-key support (spec §15.15).
   */
  async getLlmProviders(): Promise<LlmProvidersResponse> {
    return this.request<LlmProvidersResponse>('GET', '/settings/llm-providers');
  }

  // ---------------------------------------------------------------------------
  // IM settings manifest + actions
  // ---------------------------------------------------------------------------
  //
  // 通用 manifest-driven IM 接入：每个 channel adapter (telegram / feishu / …)
  // 自描述自己的 fields / actions / setup guide，前端按 manifest 渲染表单并触发
  // action（test / lookup）。

  /**
   * Fetch all registered IM channel manifests. The server reads the plugin
   * registry's IM settings manifests; missing channels are simply absent from
   * the array (no per-channel error). Empty array is valid.
   */
  async getImSettingsManifests(): Promise<{ manifests: ImSettingsManifest[] }> {
    return this.request<{ manifests: ImSettingsManifest[] }>('GET', '/settings/im/manifests');
  }

  /**
   * Run a manifest-declared action for a given channel. Action ids and their
   * semantics are defined by each channel's manifest (`actions[].id`). The
   * server resolves the action by `(channelId, actionId)` and returns the
   * adapter-specific result; `ok: false` carries `code` / `message` for
   * UI rendering, `ok: true` may carry `data` (e.g. `envPatch` for lookup).
   *
   * Both path segments are URL-encoded so adapter-defined ids with reserved
   * characters survive routing.
   */
  async runImAction(channelId: string, actionId: string): Promise<ImActionResult> {
    return this.request<ImActionResult>(
      'POST',
      `/settings/im/${encodeURIComponent(channelId)}/actions/${encodeURIComponent(actionId)}`,
      {},
    );
  }

  // ---------------------------------------------------------------------------
  // Plugin settings contributions — generic protocol that replaces
  // ImSettingsManifest over time. Server pre-resolves every LocalizedString
  // to the requested locale before returning, so the response contains plain
  // strings only.
  // ---------------------------------------------------------------------------

  /**
   * Fetch every plugin's settings contribution, resolved for the given locale.
   * Locale defaults to the server's effective language; pass an explicit
   * `locale` to override (e.g. when previewing UI in a non-default language).
   */
  async getSettingsContributions(
    locale?: 'en' | 'zh',
  ): Promise<PluginSettingsContributionsResponse> {
    const path =
      locale !== undefined
        ? `/settings/contributions?locale=${encodeURIComponent(locale)}`
        : '/settings/contributions';
    return this.request<PluginSettingsContributionsResponse>('GET', path);
  }

  /**
   * Invoke a plugin-declared action (e.g. "test connection"). The server
   * resolves the action by `(pluginId, actionId)`, snapshots current env
   * values for the plugin's fields, and dispatches the registered handler.
   * Identical result shape to `runImAction` — failure carries `code` /
   * `message`, success may carry structured `data`.
   */
  async invokeContributionAction(
    pluginId: string,
    actionId: string,
    values?: Record<string, string | boolean | number | undefined>,
  ): Promise<PluginActionResult> {
    return this.request<PluginActionResult>(
      'POST',
      `/settings/contributions/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(actionId)}`,
      values !== undefined ? { values } : {},
    );
  }

  // ---------------------------------------------------------------------------
  // Server control
  // ---------------------------------------------------------------------------

  /**
   * Trigger a graceful server restart. The server replies 200 with the
   * estimated downtime in seconds, then schedules `process.exit(0)` shortly
   * after so the response actually flushes — the wrapping supervisor (docker
   * / pm2 / systemd) is responsible for relaunching. Callers should poll
   * `/health` after `estimatedSeconds` to detect when the server is back.
   */
  async serverRestart(): Promise<ServerRestartResult> {
    return this.request<ServerRestartResult>('POST', '/server/restart');
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async health(): Promise<HealthStatus> {
    return this.request<HealthStatus>('GET', '/health');
  }
}
