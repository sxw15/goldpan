import { CollectorError } from '@goldpan/core/plugins';

export interface GithubApiConfig {
  token: string | undefined;
  apiBase: string;
  timeoutMs: number;
}

export type GithubApiResult<T> = { status: 200; body: T; etag: string | null } | { status: 304 };

interface GetArgs {
  owner: string;
  repo: string;
  etag?: string | null;
  signal?: AbortSignal;
}

export class GithubApiClient {
  constructor(private readonly cfg: GithubApiConfig) {}

  async getRepo(args: GetArgs) {
    return this.request<Record<string, unknown>>(`/repos/${args.owner}/${args.repo}`, args);
  }
  async getReadme(args: GetArgs) {
    return this.request<string>(`/repos/${args.owner}/${args.repo}/readme`, args, {
      accept: 'application/vnd.github.raw',
    });
  }
  async getReleases(args: GetArgs & { perPage: number }) {
    return this.request<Array<Record<string, unknown>>>(
      `/repos/${args.owner}/${args.repo}/releases?per_page=${args.perPage}`,
      args,
    );
  }
  async getCommits(
    args: GetArgs & { perPage: number; since?: string | null; sha?: string | null },
  ) {
    const params = new URLSearchParams();
    params.set('per_page', String(args.perPage));
    if (args.since) params.set('since', args.since);
    if (args.sha) params.set('sha', args.sha);
    return this.request<Array<Record<string, unknown>>>(
      `/repos/${args.owner}/${args.repo}/commits?${params}`,
      args,
    );
  }
  async getChangelog(args: GetArgs) {
    return this.request<Record<string, unknown>>(
      `/repos/${args.owner}/${args.repo}/contents/CHANGELOG.md`,
      args,
    );
  }

  private async request<T>(
    pathSegment: string,
    args: GetArgs,
    opts?: { accept?: string },
  ): Promise<GithubApiResult<T>> {
    const url = `${this.cfg.apiBase}${pathSegment}`;
    const baseHeaders: Record<string, string> = {
      Accept: opts?.accept ?? 'application/vnd.github+json',
      'User-Agent': 'goldpan-github-collector',
    };
    if (this.cfg.token) baseHeaders.Authorization = `Bearer ${this.cfg.token}`;
    if (args.etag) baseHeaders['If-None-Match'] = args.etag;

    const maxAttempts = 3;
    let lastError: CollectorError | Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('GitHub API timeout')),
        this.cfg.timeoutMs,
      );
      const composite = args.signal
        ? AbortSignal.any([args.signal, controller.signal])
        : controller.signal;
      let response: Response;
      try {
        response = await fetch(url, { headers: baseHeaders, signal: composite });
      } catch (err) {
        clearTimeout(timer);
        if (args.signal?.aborted) {
          throw new CollectorError('aborted', 'ABORTED', false, err);
        }
        if (attempt === maxAttempts) {
          throw new CollectorError('Network error after retries', 'UPSTREAM', true, err, false);
        }
        await backoff(attempt);
        continue;
      }
      clearTimeout(timer);

      if (response.status === 304) return { status: 304 };
      if (response.status === 200) {
        const etag = response.headers.get('etag');
        const body = (
          opts?.accept === 'application/vnd.github.raw'
            ? await response.text()
            : await response.json()
        ) as T;
        return { status: 200, body, etag };
      }
      if (response.status === 404) {
        throw new CollectorError(`Not found: ${pathSegment}`, 'NOT_FOUND', false, undefined, true);
      }
      if (response.status === 422) {
        throw new CollectorError('Invalid request', 'INVALID_REQUEST', false, undefined, true);
      }
      if (response.status === 403) {
        const remaining = response.headers.get('x-ratelimit-remaining');
        const reset = response.headers.get('x-ratelimit-reset');
        if (remaining === '0') {
          throw new CollectorError(
            `Rate limited until ${reset}`,
            'RATE_LIMIT',
            false,
            undefined,
            true,
          );
        }
        const retryAfter = Number(response.headers.get('retry-after') ?? '0');
        if (retryAfter > 0 && retryAfter <= 5 && attempt < maxAttempts) {
          await sleep(retryAfter * 1000);
          continue;
        }
        throw new CollectorError('Forbidden', 'RATE_LIMIT', false, undefined, true);
      }
      if (response.status >= 500 && attempt < maxAttempts) {
        lastError = new Error(`HTTP ${response.status}`);
        await backoff(attempt);
        continue;
      }
      throw new CollectorError(`HTTP ${response.status}`, 'UPSTREAM', true, lastError, false);
    }
    throw new CollectorError('Exhausted retries', 'UPSTREAM', true, lastError, false);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function backoff(attempt: number) {
  await sleep(2 ** (attempt - 1) * 1000);
}
