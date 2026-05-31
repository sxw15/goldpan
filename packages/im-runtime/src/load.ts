// monorepo/packages/im-runtime/src/load.ts
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ConversationRepository } from '@goldpan/core/conversation';
import type { ILogObj, Logger } from 'tslog';
import {
  type ImChannelEnvSpec,
  type ImSettingsModule,
  validateImSettingsManifest,
} from './settings.js';
import type { ChannelAdapter } from './types.js';

export interface LoadChannelsOptions {
  pluginsDir: string;
  logger: Logger<ILogObj>;
}

/**
 * The full bundle a plugin contributes. The bundle does NOT carry a
 * `ChannelAdapter` instance — adapter construction needs host-injected deps
 * (`conversationRepo` etc) that aren't available at load time. `registration`
 * is the seam: when the runtime invokes `bundle.registration(slice, resolver,
 * deps)`, the plugin internally calls its own `createXxxAdapter(deps)` and
 * returns the instance. So at load time we only carry the static identity
 * (`channelId`, derived from the manifest) and the four protocol exports.
 */
export interface ImChannelBundle {
  /** Stable channel id, mirrors `module.manifest.channelId`. */
  channelId: string;
  module: ImSettingsModule;
  envSpec: ImChannelEnvSpec<unknown>;
  registration: ImChannelRegistrationFn;
  /** Absolute path to the plugin's `static/` directory (for asset routing). */
  staticDir: string;
}

/**
 * Host-injected runtime resources passed to plugin's `goldpanIMRegistration`.
 *
 * Why deps as a 3rd arg (not closure / factory): an alternative considered was
 * `makeXxxRegistration(deps): ImChannelRegistrationFn` (plugin exports a
 * factory, host calls it with deps to get a closure). That requires the host
 * to know each plugin's factory name (`makeTelegramRegistration` /
 * `makeFeishuRegistration`), so adding a third-party plugin would still
 * require host-code changes — defeating the "plugin self-describes, host
 * doesn't know specific channels" goal. Putting deps as the 3rd parameter of
 * the protocol means there's exactly one calling convention
 * (`bundle.registration(slice, resolver, deps)`) and zero host edits when
 * adding new plugins.
 */
export interface ImChannelRegistrationDeps {
  /** Required by all current channel adapters. */
  conversationRepo: ConversationRepository;
  // Future: other host resources go here (e.g. a metrics emitter). Adding a
  // field is non-breaking for plugins that don't read it.
}

export type ImChannelRegistrationFn = (
  channelSlice: unknown,
  resolver: { resolve(ref: string): string },
  deps: ImChannelRegistrationDeps,
) => {
  adapter: ChannelAdapter;
  channelConfig: Record<string, unknown>;
  secrets: Record<string, string>;
} | null;

/**
 * Discover `monorepo/plugins/im-*` packages and load each one's
 * `goldpanIMSettings` + `goldpanIMEnvSpec` + `goldpanIMRegistration`. A plugin
 * is **skipped** (not fatal) when:
 *   - missing any of the three exports,
 *   - manifest fails schema validation,
 *   - manifest.channelId and envSpec.channelId disagree,
 *   - duplicate channelId among already-loaded plugins.
 *
 * Note: there is no `goldpanIMChannel` export in the protocol. Adapter
 * instances need host-injected deps and are constructed inside the plugin's
 * `goldpanIMRegistration` callback at register time.
 *
 * Skipped plugins log an ERROR with reason; boot continues so a single
 * broken third-party plugin doesn't kill the whole server.
 */
export async function loadChannels(opts: LoadChannelsOptions): Promise<ImChannelBundle[]> {
  if (!existsSync(opts.pluginsDir)) {
    opts.logger.warn(`loadChannels: pluginsDir does not exist: ${opts.pluginsDir}`);
    return [];
  }
  // 目录前缀约束：只扫描 `im-*` 子目录。第三方 plugin 装在非 `im-` 前缀的目录
  // 会被静默跳过 — 给一条 debug 帮助排查"plugin 装了但没生效"。spec/plan 的
  // 协议描述也显式说明了这条约束。
  const allEntries = readdirSync(opts.pluginsDir, { withFileTypes: true });
  const skipped = allEntries.filter((e) => e.isDirectory() && !e.name.startsWith('im-'));
  if (skipped.length > 0) {
    opts.logger.debug(
      `loadChannels: skipped ${skipped.length} non-im- plugin dir(s) under ${opts.pluginsDir}: ${skipped.map((e) => e.name).join(', ')} — IM plugins must use the im-* directory prefix`,
    );
  }
  const folders = allEntries
    .filter((e) => e.isDirectory() && e.name.startsWith('im-'))
    .map((e) => path.join(opts.pluginsDir, e.name))
    .sort();

  const inProduction = process.env.NODE_ENV === 'production';
  const bundles: ImChannelBundle[] = [];
  const seenChannelIds = new Set<string>();

  for (const folder of folders) {
    const distEntry = path.join(folder, 'dist', 'index.js');
    const srcEntry = path.join(folder, 'src', 'index.ts');
    let entry: string | null = null;
    if (existsSync(distEntry)) entry = distEntry;
    else if (!inProduction && existsSync(srcEntry)) entry = srcEntry;
    if (!entry) {
      opts.logger.warn(
        `loadChannels: no entry found for ${folder}` +
          (inProduction ? ' (TypeScript source skipped in production)' : ''),
      );
      continue;
    }

    let mod: Record<string, unknown>;
    try {
      mod = (await import(entry)) as Record<string, unknown>;
    } catch (err) {
      opts.logger.error(`loadChannels: failed to import ${entry}`, err);
      continue;
    }

    const moduleExport = mod.goldpanIMSettings as ImSettingsModule | undefined;
    const envSpec = mod.goldpanIMEnvSpec as ImChannelEnvSpec<unknown> | undefined;
    const registration = mod.goldpanIMRegistration as ImChannelRegistrationFn | undefined;

    if (!moduleExport || typeof moduleExport !== 'object' || !('manifest' in moduleExport)) {
      opts.logger.error(`loadChannels: ${entry} missing goldpanIMSettings`);
      continue;
    }
    if (!envSpec || typeof envSpec.parse !== 'function') {
      opts.logger.error(`loadChannels: ${entry} missing goldpanIMEnvSpec`);
      continue;
    }
    if (typeof registration !== 'function') {
      opts.logger.error(`loadChannels: ${entry} missing goldpanIMRegistration`);
      continue;
    }

    const validated = validateImSettingsManifest(moduleExport.manifest);
    if (!validated.ok) {
      opts.logger.error(`loadChannels: ${entry} manifest invalid`, validated.errors);
      continue;
    }
    const channelId = validated.manifest.channelId;
    if (envSpec.channelId !== channelId) {
      opts.logger.error(
        `loadChannels: ${channelId} envSpec.channelId mismatch (${envSpec.channelId})`,
      );
      continue;
    }
    if (seenChannelIds.has(channelId)) {
      opts.logger.error(`loadChannels: duplicate channelId ${channelId}`);
      continue;
    }

    seenChannelIds.add(channelId);
    bundles.push({
      channelId,
      module: moduleExport,
      envSpec,
      registration,
      staticDir: path.join(folder, 'static'),
    });
  }
  return bundles;
}
