import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BootstrapHandle } from '@goldpan/core/bootstrap';
import {
  adaptImHandlersToContribution,
  convertImManifestToContribution,
  EnvSecretResolver,
  IMRuntime,
  type IMRuntimeDeps,
  type IMRuntimeOptions,
  type ImChannelBundle,
  type ImChannelRegistrationDeps,
  type ImSettingsModule,
  loadChannels,
  type SecretResolver,
} from '@goldpan/im-runtime';
import { loadImChannelConfigs } from './im/channel-configs.js';

/**
 * Slice of `BootstrapHandle` that `composeIMRuntime` actually reads. Narrowing
 * the parameter here both documents the dependency surface and lets test
 * fixtures construct only the fields we touch.
 */
export type ComposeIMRuntimeHandle = Pick<
  BootstrapHandle,
  'config' | 'db' | 'repos' | 'pluginRegistry' | 'embeddingProvider' | 'callLlm' | 'logger'
>;

/**
 * Narrow IMRuntime constructor shape for the `IMRuntimeCtor` override. Tests
 * supply any class with the same `(deps, options?)` constructor signature
 * whose instances expose `register` + `start`. The single `as IMRuntime` cast
 * at the return site keeps `Promise<IMRuntime | null>` honest for `main.ts`
 * callers that go on to call `shutdown()` / `describeChannels()`.
 */
type IMRuntimeCtorLike = new (
  deps: IMRuntimeDeps,
  options?: IMRuntimeOptions,
) => Pick<IMRuntime, 'register' | 'start'>;

/** Test-only injection seams. Production callers MUST NOT pass these. */
export interface ComposeIMRuntimeOverrides {
  IMRuntimeCtor?: IMRuntimeCtorLike;
  secretResolver?: SecretResolver;
  /**
   * Test-only: pre-resolved bundles, bypasses the filesystem scan that
   * `loadChannels` performs in production.
   */
  bundles?: ReadonlyArray<ImChannelBundle>;
}

/**
 * Default plugins directory. Resolved at module load time relative to this
 * source file's location so it's stable across tsx (src) and built (dist)
 * runs: `apps/server/src/im-compose.ts` → `monorepo/plugins/`.
 */
const DEFAULT_PLUGINS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../plugins',
);

/**
 * Composition root for IM layers — discovers `im-*` plugin bundles, parses
 * their channel-specific env slices, then registers each enabled channel into
 * a single `IMRuntime`. Lives here (not in `core/bootstrap`) because
 * `@goldpan/core` MUST stay channel-unaware.
 *
 * Behaviour contract — kept stable so `apps/server/main.ts` and plugin
 * `postInit` hooks can rely on it:
 *
 * - Always registers `im_settings_modules` service so `/settings/im/*` routes
 *   can find manifests / handlers even when no channel boots.
 *
 * - Returns `runtime: null` when (a) no plugin bundles are discovered or
 *   (b) every discovered bundle's `registration()` returns null (channel
 *   self-disabled, e.g. token missing). Callers MUST treat this as
 *   "no IM at all" — `/health` reports an empty channel list and there is
 *   no shutdown work.
 *
 * - Returns the `IMRuntime` instance when at least one channel registers,
 *   regardless of whether `runtime.start()` succeeded. On start failure we
 *   intentionally keep the reference: the runtime is the single source of
 *   truth for per-channel state (`describeChannels()` reports the failed
 *   channel as `state: 'error'` with `lastErrorMessage`). The shutdown path
 *   tolerates this — `IMRuntime#shutdown` skips entries already in a
 *   terminal state, so no adapter gets double-stopped.
 */
export async function composeIMRuntime(
  handle: ComposeIMRuntimeHandle,
  overrides: ComposeIMRuntimeOverrides = {},
): Promise<{
  runtime: IMRuntime | null;
  modules: Map<string, ImSettingsModule>;
  bundles: ReadonlyArray<ImChannelBundle>;
}> {
  const bundles =
    overrides.bundles ??
    (await loadChannels({ pluginsDir: DEFAULT_PLUGINS_DIR, logger: handle.logger }));

  const modules = new Map<string, ImSettingsModule>();
  for (const b of bundles) modules.set(b.channelId, b.module);
  const resolver = overrides.secretResolver ?? new EnvSecretResolver();

  // Always register the settings-modules service so /settings/im/* routes can
  // find manifests / handlers even if no channel is enabled at boot.
  handle.pluginRegistry.registerService('im_settings_modules', modules);

  // Mirror every IM channel into the generic settings-contribution registry.
  // The legacy /settings/im/* routes keep working off `modules` above; the new
  // /settings/contributions endpoint reads from pluginRegistry. Skips a bundle
  // if a contribution under the same pluginId already exists — defensive
  // against future composition paths registering the same channel twice.
  for (const bundle of bundles) {
    try {
      if (handle.pluginRegistry.getSettingsContribution(bundle.channelId) !== undefined) {
        handle.logger.debug(
          `composeIMRuntime: skipping duplicate settings contribution for ${bundle.channelId}`,
        );
        continue;
      }
      const contribution = convertImManifestToContribution(bundle.module.manifest);
      const actionHandlers = adaptImHandlersToContribution(bundle.module.handlers, {
        getRawEnvValue: (fieldName) => {
          const field = bundle.module.manifest.fields.find((f) => f.name === fieldName);
          if (field === undefined) return undefined;
          const rawValue = process.env[field.envKey];
          if (rawValue === undefined) return undefined;
          return field.kind === 'toggle' ? rawValue === 'true' : rawValue;
        },
        resolveEnvValue: (fieldName) => {
          const field = bundle.module.manifest.fields.find((f) => f.name === fieldName);
          if (field === undefined) return undefined;
          const rawValue = process.env[field.envKey];
          if (rawValue === undefined) return undefined;
          if (field.kind === 'toggle') return rawValue === 'true';
          if (field.kind === 'segmented') return rawValue;
          return resolver.resolve(rawValue);
        },
      });
      handle.pluginRegistry.registerSettingsContribution(contribution, actionHandlers, {
        assetDir: bundle.staticDir,
      });
    } catch (err) {
      handle.logger.error(
        `composeIMRuntime: failed to register settings contribution for ${bundle.channelId}`,
        err,
      );
    }
  }

  if (bundles.length === 0) {
    handle.logger.info('IM Runtime not started — no channels discovered');
    // 与下面 registeredCount === 0 / runtime ok 两个分支的 service 注册行为
    // 对齐：im_runtime 始终被注册（null 或 instance），下游 plugin postInit
    // 通过 truthy check 处理两种情况。不注册会让 getService 返回 undefined，
    // 与"主动注册 null"语义不一致。
    handle.pluginRegistry.registerService('im_runtime', null);
    return { runtime: null, modules, bundles };
  }

  // Each plugin's env slice (parsed via its envSpec).
  const channelConfigs = loadImChannelConfigs(
    process.env,
    bundles.map((b) => b.envSpec),
  );

  const RuntimeCtor: IMRuntimeCtorLike = overrides.IMRuntimeCtor ?? IMRuntime;
  const runtime = new RuntimeCtor(
    {
      db: handle.db,
      callLlm: handle.callLlm,
      pluginRegistry: handle.pluginRegistry,
      config: handle.config,
      repos: handle.repos,
      conversationRepo: handle.repos.conversation,
      embeddingProvider: handle.embeddingProvider,
      logger: handle.logger,
    },
    {
      conversationWindowSize: handle.config.im.conversationWindowSize,
      dedupeTtlHours: handle.config.im.dedupeTtlHours,
      dedupePurgeIntervalMinutes: handle.config.im.dedupePurgeIntervalMinutes,
    },
  );

  // Host-injected runtime resources every plugin's registration may need.
  // Adding a field is non-breaking; plugins read only what they need.
  const regDeps: ImChannelRegistrationDeps = {
    conversationRepo: handle.repos.conversation,
  };

  let registeredCount = 0;
  for (const bundle of bundles) {
    const slice = channelConfigs.get(bundle.channelId);
    const reg = bundle.registration(slice, resolver, regDeps);
    if (!reg) continue; // plugin self-disables (e.g. token missing)
    runtime.register(reg.adapter, {
      channelConfig: reg.channelConfig,
      secrets: reg.secrets,
    });
    registeredCount++;
  }

  if (registeredCount === 0) {
    handle.logger.info('IM Runtime not started — discovered channels all self-disabled');
    handle.pluginRegistry.registerService('im_runtime', null);
    return { runtime: null, modules, bundles };
  }

  try {
    await runtime.start();
    handle.logger.info('IM Runtime started', { channels: registeredCount });
  } catch (err) {
    handle.logger.error('Failed to start IM Runtime; continuing — channel state via /health', {
      err: err instanceof Error ? err.message : String(err),
    });
    // Keep `runtime` non-null so /health surfaces the failed channel
    // descriptors and shutdown still drains any partially-initialized state.
  }
  // Register im_runtime regardless of start() success: plugin postInit hooks
  // rely on looking up this service to wire outbound flows, and a failed
  // channel is still observable via describeChannels().
  handle.pluginRegistry.registerService('im_runtime', runtime);
  // Cast: in production `RuntimeCtor` is `IMRuntime` so this is identity. In
  // tests the ctor returns a Pick<IMRuntime, 'register' | 'start'> stub —
  // and tests do not invoke shutdown()/describeChannels() on the returned
  // reference. main.ts production callers always go through the real
  // IMRuntime, so the wider surface remains sound.
  return { runtime: runtime as IMRuntime, modules, bundles };
}
