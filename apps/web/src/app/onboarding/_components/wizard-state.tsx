// apps/web/src/app/onboarding/_components/wizard-state.tsx
'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { readRestartFlag } from '@/components/restart-panel/restart-flag';

/**
 * Client mirror of the wizard server's WizardState
 * (apps/server/src/routes/onboarding/state.ts). Source of truth lives there.
 *
 * Sync rule: when you add / remove / rename a field on the server side, change
 * the matching field here in the SAME PR. The wire format is JSON, so any
 * divergence is silent at compile time and only surfaces as a runtime PATCH
 * 400 or a missing-field render. There is no automated check — keeping these
 * two type blocks textually identical is a manual contract.
 */
export interface WizardState {
  language?: 'en' | 'zh';
  timezone?: string;
  webEnabled?: boolean;
  authPassword?: string;
  providers: Record<
    string,
    {
      apiKey?: string;
      baseUrl?: string;
      /** Chat / completion model ids — committed as `<ID>_MODELS`. */
      models?: string[];
      /**
       * Embedding model ids — committed as `<ID>_EMBEDDING_MODELS`. UI 上和
       * `models` 同处一个 row 编辑列表，每行的 embedding toggle 决定 model
       * id 落入 `models` (toggle off) 还是 `embeddingModels` (toggle on)。
       */
      embeddingModels?: string[];
      /**
       * For custom OpenAI-compat providers (id outside the builtin list), the
       * name of the env var that will hold the secret on commit. Builtins
       * leave this undefined — their secret env names are hardcoded server-side.
       */
      apiKeyEnv?: string;
    }
  >;
  steps: Record<string, { model?: string; enabled?: boolean }>;
  digest?: {
    enabled: boolean;
    dailyTime?: string;
    maxItemsPerModule?: number;
    summaryModel?: string;
    actionModel?: string;
    modules: string[];
  };
  tracking?: {
    enabled: boolean;
    pollInterval?: number;
    dailyLimit?: number;
    searchProviders: string[];
    rules: Array<{
      name: string;
      searchQueries: string[];
      intervalMinutes: number;
      domains?: string[];
    }>;
  };
  searchKeys?: { tavily?: string; serper?: string };
  embedding?: {
    enabled: boolean;
    model?: string;
    dimensions?: number;
    batchSize?: number;
  };
  /**
   * IM channel state, keyed by channelId. Field shapes are determined at
   * commit time by walking the manifest registered for each channel — here
   * we only require that each value be a plain object with `enabled?` and
   * `fields?: Record<string, string | undefined>`. The string typing for
   * `fields` matches `apps/server/src/routes/onboarding/state.ts`'s
   * `ImChannelWizardState` (T20) — both web and server agree that wizard
   * state stores all field values as strings (toggles serialize to
   * 'true'/'false') so the patch shape is uniform.
   */
  im?: Record<
    string,
    { enabled?: boolean; fields?: Record<string, string | undefined> } | undefined
  >;
}

type PrimitivePatch<T> = T | null | undefined;
type ProviderPatch = {
  apiKey?: PrimitivePatch<string>;
  baseUrl?: PrimitivePatch<string>;
  models?: string[] | null;
  embeddingModels?: string[] | null;
  apiKeyEnv?: PrimitivePatch<string>;
} | null;
type StepPatch = { model?: PrimitivePatch<string>; enabled?: PrimitivePatch<boolean> } | null;
type DigestPatch = {
  enabled?: PrimitivePatch<boolean>;
  dailyTime?: PrimitivePatch<string>;
  maxItemsPerModule?: PrimitivePatch<number>;
  summaryModel?: PrimitivePatch<string>;
  actionModel?: PrimitivePatch<string>;
  modules?: string[] | null;
} | null;
type EmbeddingPatch = {
  enabled?: PrimitivePatch<boolean>;
  model?: PrimitivePatch<string>;
  dimensions?: PrimitivePatch<number>;
  batchSize?: PrimitivePatch<number>;
} | null;

export interface WizardStatePatch {
  language?: PrimitivePatch<'en' | 'zh'>;
  timezone?: PrimitivePatch<string>;
  webEnabled?: PrimitivePatch<boolean>;
  authPassword?: PrimitivePatch<string>;
  providers?: Record<string, ProviderPatch>;
  steps?: Record<string, StepPatch>;
  digest?: DigestPatch;
  tracking?: Partial<WizardState['tracking']> | null;
  searchKeys?: { tavily?: PrimitivePatch<string>; serper?: PrimitivePatch<string> } | null;
  embedding?: EmbeddingPatch;
  im?: Partial<WizardState['im']> | null;
}

/**
 * Patch / hydrate failure modes the user should know about. `null` = no
 * outstanding error; pages should clear via `dismissError` once acknowledged.
 *
 * - `hydrate`: initial GET /api/onboarding/state failed. Optimistic state is
 *   the empty initial — the user could overwrite real server state if they
 *   blindly type. Banner advises a refresh.
 * - `patch`: the most recent PATCH failed (network drop OR `res.ok === false`).
 *   Optimistic state diverges from server-truth; next mount re-hydrates and
 *   silently overwrites the input. Banner explains the staleness.
 */
type PatchErrorKind = 'hydrate' | 'patch';

/**
 * Pre-bootstrap snapshot of available LLM providers, fetched once on wizard
 * mount from /api/onboarding/llm-providers. Drives the pipeline step-card's
 * model dropdown so custom (.env) + plugin providers appear alongside the 5
 * builtin. Empty array = fetch failed; UI falls back to builtin-only.
 */
export interface AvailableProvider {
  id: string;
  source: 'builtin' | 'custom' | 'plugin';
  /** Chat / completion models — drives Pipeline step model dropdown. */
  models: string[];
  /**
   * Embedding-role models — drives the onboarding embedding step's model
   * dropdown for env-only providers (i.e. user has `_EMBEDDING_MODELS` in
   * `.env` but never opened the provider in the wizard, so `state.providers`
   * has no entry). Empty when the user hasn't registered any embedding
   * model for this provider.
   */
  embeddingModels: string[];
}

interface WizardCtx {
  state: WizardState;
  patch: (p: WizardStatePatch) => Promise<void>;
  flush: () => Promise<void>;
  hydrated: boolean;
  /** Most recent unhandled patch / hydrate failure, surfaced via wizard-shell banner. */
  patchError: PatchErrorKind | null;
  /** Dismiss the banner — pages call this when the user acknowledges the warning. */
  dismissError: () => void;
  /** Fetched once on mount. Empty array on fetch failure (graceful degrade). */
  availableProviders: AvailableProvider[];
}

const WizardContext = createContext<WizardCtx | null>(null);

const initialState: WizardState = { providers: {}, steps: {} };

export function WizardStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WizardState>(initialState);
  const [hydrated, setHydrated] = useState(false);
  const [patchError, setPatchError] = useState<PatchErrorKind | null>(null);
  const [availableProviders, setAvailableProviders] = useState<AvailableProvider[]>([]);
  const pendingPatchRef = useRef<Promise<void>>(Promise.resolve());

  // Hydrate from server on mount. Single-user assumption — we don't bother
  // with cross-tab sync; if the user opens two tabs they'll briefly see two
  // optimistic states until either tab does a PATCH (which returns the merged
  // server-truth state).
  useEffect(() => {
    let alive = true;
    fetch('/api/onboarding/state')
      .then((r) => {
        if (!r.ok) throw new Error(`hydrate ${r.status}`);
        return r.json();
      })
      .then((s: WizardState) => {
        if (!alive) return;
        setState(s);
        setHydrated(true);
      })
      .catch(() => {
        if (!alive) return;
        // Suppress the hydrate banner during a restart-triggered reload: the
        // server is intentionally down and the restart-button polling loop on
        // /onboarding/complete is already in charge of redirecting away once
        // the new server is ready. Showing "无法加载向导状态" here would just
        // confuse a user who knows they pressed restart.
        if (readRestartFlag()) {
          setHydrated(true);
          return;
        }
        // Otherwise surface to the user instead of silently leaving them on
        // initialState — they could otherwise type into "blank" inputs and
        // overwrite server values that simply failed to load.
        setPatchError('hydrate');
        setHydrated(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Separate from hydrate so a slow/failed providers fetch doesn't block the
  // wizard from becoming usable — and a missing provider list shouldn't pop
  // the patchError banner (step-card has builtin model lists hardcoded; the
  // worst case is the user can't pick custom/plugin models from the dropdown).
  useEffect(() => {
    let alive = true;
    fetch('/api/onboarding/llm-providers')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then(
        (snap: {
          builtin: Array<{ id: string; models?: string[]; embeddingModels?: string[] }>;
          custom: Array<{ id: string; models?: string[]; embeddingModels?: string[] }>;
          plugin: Array<{ providerId: string; models?: string[]; embeddingModels?: string[] }>;
        }) => {
          if (!alive) return;
          setAvailableProviders([
            ...snap.builtin.map((b) => ({
              id: b.id,
              source: 'builtin' as const,
              models: b.models ?? [],
              embeddingModels: b.embeddingModels ?? [],
            })),
            ...snap.custom.map((c) => ({
              id: c.id,
              source: 'custom' as const,
              models: c.models ?? [],
              embeddingModels: c.embeddingModels ?? [],
            })),
            ...snap.plugin.map((p) => ({
              id: p.providerId,
              source: 'plugin' as const,
              models: p.models ?? [],
              embeddingModels: p.embeddingModels ?? [],
            })),
          ]);
        },
      )
      .catch(() => {
        // Wizard degrades to builtin-only — step-card has builtin model lists
        // hardcoded; fetch failure shouldn't block onboarding.
        if (!alive) return;
        setAvailableProviders([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const patch = useCallback((p: WizardStatePatch): Promise<void> => {
    // Optimistic deep-merge mirrors the server's mergeDeep so the input feels
    // snappy. When the PATCH response lands we overwrite optimistic state with
    // the server's canonical value.
    setState((prev) => mergePatch(prev, p));
    const run = pendingPatchRef.current
      .catch(() => undefined)
      .then(async () => {
        const res = await fetch('/api/onboarding/state', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(p),
        });
        if (!res.ok) {
          // PATCH was rejected (validation, rate limit, 5xx). Surface a banner
          // and reject so flush()-driven navigation stays on the current page.
          setPatchError('patch');
          throw new Error(`patch ${res.status}`);
        }
        const next = (await res.json()) as WizardState;
        setState(next);
        setPatchError(null);
      });
    const tracked = run.catch((err) => {
      // Either !res.ok above re-thrown, or a network drop. Mark the banner
      // (idempotent if already set) and rethrow so flush() callers can keep
      // the user on the current page instead of silently navigating onward.
      setPatchError('patch');
      throw err;
    });
    pendingPatchRef.current = tracked;
    return tracked;
  }, []);

  const flush = useCallback(() => pendingPatchRef.current, []);

  const dismissError = useCallback(() => setPatchError(null), []);

  return (
    <WizardContext.Provider
      value={{ state, patch, flush, hydrated, patchError, dismissError, availableProviders }}
    >
      {children}
    </WizardContext.Provider>
  );
}

export function useWizard(): WizardCtx {
  const ctx = useContext(WizardContext);
  if (!ctx) throw new Error('useWizard must be used inside WizardStateProvider');
  return ctx;
}

/**
 * Drains pending PATCHes, then navigates. If any pending PATCH fails the
 * navigation is suppressed and the user stays on the current page so they
 * can see the wizard-shell `patchError` banner and retry. Without this
 * guard a failed PATCH would silently lose the user's last edit when they
 * pressed "next".
 */
export function useWizardNavigate(): (path: string) => void {
  const router = useRouter();
  const { flush } = useWizard();
  return useCallback(
    (path: string) => {
      flush()
        .then(() => router.push(path))
        .catch(() => {
          // patch already set patchError; banner is showing
        });
    },
    [router, flush],
  );
}

function mergePatch<T>(a: T, b: WizardStatePatch): T {
  const out = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b)) {
    if (v === null) {
      delete out[k];
      continue;
    }
    const existing = (a as Record<string, unknown>)[k];
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[k] = mergePatch(existing, v as WizardStatePatch);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
