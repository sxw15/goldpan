import type { ILogObj, Logger } from 'tslog';
import { ZodError } from 'zod';
import { errorMessage } from '../errors';
import { truncate } from '../utils/truncate';
import { emitCollectDiagnostic } from './collect-diagnostics';
import {
  type PluginActionHandler,
  type PluginSettingsContribution,
  validateContribution,
} from './contribution';
import { CollectorError, ToolOutputValidationError } from './errors';
import type {
  CollectorInput,
  CollectorOutput,
  CollectorPlugin,
  CollectorResult,
  GoldpanPlugin,
  IntentDeclaration,
  IntentPlugin,
  IntentRegistration,
  LlmProviderPlugin,
  PluginContext,
  ServiceCapabilities,
  ToolDeclaration,
  ToolPlugin,
} from './types';

export interface SettingsContributionRegistration {
  contribution: PluginSettingsContribution;
  actionHandlers?: Record<string, PluginActionHandler>;
  /** Absolute directory used to serve setup-guide assets for this contribution. */
  assetDir?: string;
  /**
   * Parent plugin metadata captured at registration time. The contribution
   * itself does not declare these — they live on `GoldpanPlugin`. The web
   * settings route merges `version` and locale-resolved `description` into
   * the resolved descriptor so the meta strip can render without a second
   * round-trip. Optional because `registerSettingsContribution` is also a
   * public API for callers without a `GoldpanPlugin` parent (IM channels,
   * unit tests). When `plugin` is present, the route resolves the locale
   * description via `resolvePluginDescription(plugin, locale)` — same central
   * helper used by `/settings/plugins` — instead of open-coding the fallback.
   */
  pluginVersion?: string;
  plugin?: Pick<GoldpanPlugin, 'description' | 'descriptions'>;
}

export interface RegisterPluginOptions {
  /** Absolute directory used to serve `settingsContribution.setupGuide.images`. */
  settingsAssetDir?: string;
}

const DIAGNOSTIC_ERR_MAX = 400;

export interface PluginRegistryOptions {
  /** Timeout for collector operations in seconds (default: 30) */
  collectTimeoutSeconds?: number;
  /** Optional logger for registration diagnostics */
  logger?: Logger<ILogObj>;
}

export class PluginRegistry {
  private collectors: CollectorPlugin[] = [];
  private intentPlugins: IntentPlugin[] = [];
  private toolPlugins: ToolPlugin[] = [];
  private llmProviderPlugins: LlmProviderPlugin[] = [];
  private readonly llmProviderLoadStatus = new Map<
    string,
    { status: 'loaded' | 'failed' | 'skipped_conflict'; error?: string }
  >();
  private readonly intentNameToRegistration = new Map<string, IntentRegistration>();
  private readonly initializedPlugins = new Set<string>();
  private readonly serviceProviders = new Map<string, unknown>();
  private readonly settingsContributions = new Map<string, SettingsContributionRegistration>();
  private readonly defaultCollectTimeoutMs: number;
  private readonly logger?: Logger<ILogObj>;

  constructor(options: PluginRegistryOptions = {}) {
    this.defaultCollectTimeoutMs = (options.collectTimeoutSeconds ?? 30) * 1000;
    this.logger = options.logger;
  }

  register(plugin: GoldpanPlugin, options: RegisterPluginOptions = {}): void {
    this.assertSettingsContributionRegisterable(plugin);

    if (plugin.type === 'collector') {
      if (this.collectors.some((c) => c.name === plugin.name)) {
        throw new Error(`Plugin "${plugin.name}" is already registered`);
      }
      this.collectors.push(plugin as CollectorPlugin);
      this.collectors.sort((a, b) => b.priority - a.priority);
      this.logger?.info('Registered collector plugin', { pluginName: plugin.name });
    } else if (plugin.type === 'intent') {
      const intentPlugin = plugin as IntentPlugin;
      if (this.intentPlugins.some((p) => p.name === intentPlugin.name)) {
        throw new Error(`Plugin "${intentPlugin.name}" is already registered`);
      }
      // Reject duplicate intent names within the same plugin
      const seen = new Set<string>();
      for (const decl of intentPlugin.intents) {
        if (seen.has(decl.name)) {
          throw new Error(
            `Plugin "${intentPlugin.name}" declares duplicate intent name "${decl.name}"`,
          );
        }
        seen.add(decl.name);
      }
      // Cross-plugin intent name conflicts — priority arbitration (two-phase: validate then commit)
      const pendingOverrides = new Map<string, IntentRegistration>();
      for (const decl of intentPlugin.intents) {
        const existing = this.intentNameToRegistration.get(decl.name);
        if (existing) {
          const existingPriority = existing.declaration.priority ?? 0;
          const newPriority = decl.priority ?? 0;
          if (newPriority > existingPriority) {
            this.logger?.warn(
              `Intent "${decl.name}" overridden: plugin "${intentPlugin.name}" (priority ${newPriority}) replaces "${existing.plugin.name}" (priority ${existingPriority})`,
              { intent: decl.name, winner: intentPlugin.name, loser: existing.plugin.name },
            );
            pendingOverrides.set(decl.name, { plugin: intentPlugin, declaration: decl });
          } else if (newPriority === existingPriority) {
            throw new Error(
              `Intent "${decl.name}" is already registered by plugin "${existing.plugin.name}" with the same priority (${existingPriority})`,
            );
          } else {
            this.logger?.info(
              `Intent "${decl.name}" kept from plugin "${existing.plugin.name}" (priority ${existingPriority}); skipping lower-priority "${intentPlugin.name}" (priority ${newPriority})`,
              { intent: decl.name, winner: existing.plugin.name, skipped: intentPlugin.name },
            );
          }
        } else {
          pendingOverrides.set(decl.name, { plugin: intentPlugin, declaration: decl });
        }
      }
      // Commit all mutations atomically — only reached if no throw above
      for (const [name, reg] of pendingOverrides) {
        this.intentNameToRegistration.set(name, reg);
      }
      this.intentPlugins.push(intentPlugin);
      this.logger?.info('Registered intent plugin', {
        pluginName: intentPlugin.name,
        intents: intentPlugin.intents.map((i) => i.name),
      });
    } else if (plugin.type === 'tool') {
      if (this.toolPlugins.some((t) => t.name === plugin.name)) {
        throw new Error(`Plugin "${plugin.name}" is already registered`);
      }
      const toolPlugin = plugin as ToolPlugin;
      const toolNames = new Set<string>();
      for (const tool of toolPlugin.tools) {
        if (toolNames.has(tool.name)) {
          throw new Error(`Plugin "${plugin.name}" declares duplicate tool name "${tool.name}"`);
        }
        toolNames.add(tool.name);
      }
      this.toolPlugins.push(toolPlugin);
      this.logger?.info('Registered tool plugin', { pluginName: plugin.name });
    } else if (plugin.type === 'llm-provider') {
      if (this.llmProviderPlugins.some((p) => p.name === plugin.name)) {
        throw new Error(`Plugin "${plugin.name}" is already registered`);
      }
      this.llmProviderPlugins.push(plugin as LlmProviderPlugin);
      this.logger?.info('Registered llm-provider plugin', {
        pluginName: plugin.name,
        providerId: (plugin as LlmProviderPlugin).providerId,
      });
    } else {
      this.logger?.warn(`Unknown plugin type "${plugin.type}", skipping`, {
        pluginName: plugin.name,
      });
    }

    // Auto-register settings contribution if the plugin declares one. Runs
    // after type-specific registration, but every throwing condition has
    // already been preflighted above so this does not leave a partially
    // registered plugin behind.
    if (plugin.settingsContribution !== undefined) {
      this.registerSettingsContribution(
        plugin.settingsContribution,
        plugin.settingsActionHandlers,
        {
          ...(options.settingsAssetDir !== undefined ? { assetDir: options.settingsAssetDir } : {}),
          pluginVersion: plugin.version,
          plugin: {
            description: plugin.description,
            ...(plugin.descriptions !== undefined ? { descriptions: plugin.descriptions } : {}),
          },
        },
      );
    }
  }

  private assertSettingsContributionRegisterable(plugin: GoldpanPlugin): void {
    const contribution = plugin.settingsContribution;
    if (contribution === undefined) return;
    if (contribution.pluginId !== plugin.name) {
      throw new Error(
        `Plugin "${plugin.name}" settingsContribution.pluginId ` +
          `("${contribution.pluginId}") must match plugin.name`,
      );
    }
    if (this.settingsContributions.has(contribution.pluginId)) {
      throw new Error(
        `Settings contribution for plugin "${contribution.pluginId}" is already registered`,
      );
    }
    const validation = validateContribution(contribution);
    if (!validation.ok) {
      const issues = validation.errors
        .map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`)
        .join('; ');
      throw new Error(`Invalid settings contribution for "${contribution.pluginId}": ${issues}`);
    }
    if (contribution.actions && contribution.actions.length > 0) {
      const handlerKeys = new Set(Object.keys(plugin.settingsActionHandlers ?? {}));
      for (const action of contribution.actions) {
        if (!handlerKeys.has(action.id)) {
          throw new Error(
            `Settings contribution "${contribution.pluginId}" declares action ` +
              `"${action.id}" but no handler is provided`,
          );
        }
      }
    }
  }

  hasPlugin(name: string): boolean {
    return (
      this.collectors.some((c) => c.name === name) ||
      this.intentPlugins.some((p) => p.name === name) ||
      this.toolPlugins.some((t) => t.name === name) ||
      this.llmProviderPlugins.some((l) => l.name === name)
    );
  }

  // ─── Intent Plugin Queries ──────────────────────────────

  getIntentPlugins(): readonly IntentPlugin[] {
    return this.intentPlugins;
  }

  /** Returns effective (winning) declarations only — one per intent name. */
  getIntentDeclarations(): IntentDeclaration[] {
    return [...this.intentNameToRegistration.values()].map((r) => r.declaration);
  }

  getIntentNames(): string[] {
    return [...this.intentNameToRegistration.keys()];
  }

  findIntentHandler(intentName: string): IntentPlugin | undefined {
    return this.intentNameToRegistration.get(intentName)?.plugin;
  }

  /** Returns the full registration (plugin + declaration) for an intent name. */
  findIntentDeclaration(intentName: string): IntentRegistration | undefined {
    return this.intentNameToRegistration.get(intentName);
  }

  // ─── Tool Plugin Queries ──────────────────────────────────

  getToolPlugins(): readonly ToolPlugin[] {
    return this.toolPlugins;
  }

  // ─── LLM Provider Plugin Queries ──────────────────────────

  getLlmProviderPlugins(): readonly LlmProviderPlugin[] {
    return this.llmProviderPlugins;
  }

  /**
   * Status snapshot of LlmProviderPlugin loading. Populated by
   * createLlmRegistry's buildProviderMap (PR2 Task 2.4) when it tries to invoke
   * each plugin's createProvider; surfaced by GET /settings/llm-providers (PR3)
   * so users can see why a `cohere:command-r` modelId resolves to "Unknown LLM
   * provider".
   */
  getLlmProviderLoadStatus(): Record<
    string,
    { status: 'loaded' | 'failed' | 'skipped_conflict'; error?: string }
  > {
    return Object.fromEntries(this.llmProviderLoadStatus);
  }

  // ─── Settings Contributions ───────────────────────────────
  //
  // Generic settings UI protocol — any plugin (collector / intent / tool / IM
  // channel / future) can contribute a Settings page section by registering a
  // `PluginSettingsContribution`. The server exposes contributions via
  // `/settings/contributions?locale=…`; the web renders generic forms from the
  // returned descriptors. Action handlers (e.g. "test connection") are looked
  // up here and dispatched via `/settings/contributions/:pluginId/actions/:id`.
  //
  // This sits orthogonal to the four plugin types above — a single plugin may
  // register a typed plugin (collector/intent/tool/llm-provider) AND a
  // settings contribution. IM channels are not modelled as core plugins but
  // also register contributions via composeIMRuntime.

  /**
   * Register a settings contribution. Validates the contribution synchronously
   * (zod schema + cross-field checks); throws on duplicate pluginId or on
   * validation failure. Action handlers may be omitted when the contribution
   * has no actions.
   */
  registerSettingsContribution(
    contribution: PluginSettingsContribution,
    actionHandlers?: Record<string, PluginActionHandler>,
    options: {
      assetDir?: string;
      pluginVersion?: string;
      /**
       * Parent plugin reference (subset). When present, the route's descriptor
       * builder calls `resolvePluginDescription(plugin, locale)` — the same
       * helper used by `/settings/plugins` — so the fallback chain stays in
       * one place. IM channels and unit-test callers may omit this and lose
       * the description column on their cards (acceptable today).
       */
      plugin?: Pick<GoldpanPlugin, 'description' | 'descriptions'>;
    } = {},
  ): void {
    if (this.settingsContributions.has(contribution.pluginId)) {
      throw new Error(
        `Settings contribution for plugin "${contribution.pluginId}" is already registered`,
      );
    }
    const validation = validateContribution(contribution);
    if (!validation.ok) {
      const issues = validation.errors
        .map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`)
        .join('; ');
      throw new Error(`Invalid settings contribution for "${contribution.pluginId}": ${issues}`);
    }
    // Cross-check: every action.id must have a corresponding handler entry
    // (or no handlers at all). Catches plugin-author bugs at boot rather
    // than at "user clicks Test" time.
    if (contribution.actions && contribution.actions.length > 0) {
      const handlerKeys = new Set(Object.keys(actionHandlers ?? {}));
      for (const action of contribution.actions) {
        if (!handlerKeys.has(action.id)) {
          throw new Error(
            `Settings contribution "${contribution.pluginId}" declares action ` +
              `"${action.id}" but no handler is provided`,
          );
        }
      }
    }
    this.settingsContributions.set(contribution.pluginId, {
      contribution,
      ...(actionHandlers !== undefined ? { actionHandlers } : {}),
      ...(options.assetDir !== undefined ? { assetDir: options.assetDir } : {}),
      ...(options.pluginVersion !== undefined ? { pluginVersion: options.pluginVersion } : {}),
      ...(options.plugin !== undefined ? { plugin: options.plugin } : {}),
    });
    this.logger?.info('Registered settings contribution', {
      pluginId: contribution.pluginId,
      group: contribution.group,
      fields: contribution.fields.length,
      actions: contribution.actions?.length ?? 0,
    });
  }

  getSettingsContributions(): readonly SettingsContributionRegistration[] {
    return [...this.settingsContributions.values()];
  }

  getSettingsContribution(pluginId: string): SettingsContributionRegistration | undefined {
    return this.settingsContributions.get(pluginId);
  }

  /** Called by registry.ts:buildProviderMap after each plugin's createProvider attempt. */
  recordLlmProviderStatus(
    pluginName: string,
    status: { status: 'loaded' | 'failed' | 'skipped_conflict'; error?: string },
  ): void {
    this.llmProviderLoadStatus.set(pluginName, status);
  }

  resolveToolProvider(
    pluginName: string,
    toolName: string,
  ): { plugin: ToolPlugin; declaration: ToolDeclaration } | undefined {
    const plugin = this.toolPlugins.find((p) => p.name === pluginName);
    if (!plugin) return undefined;
    const declaration = plugin.tools.find((t) => t.name === toolName);
    if (!declaration) return undefined;
    return { plugin, declaration };
  }

  listToolCandidates(
    toolName: string,
  ): Array<{ plugin: ToolPlugin; declaration: ToolDeclaration }> {
    const candidates: Array<{ plugin: ToolPlugin; declaration: ToolDeclaration }> = [];
    for (const plugin of this.toolPlugins) {
      const decl = plugin.tools.find((t) => t.name === toolName);
      if (decl) candidates.push({ plugin, declaration: decl });
    }
    return candidates.sort((a, b) => b.plugin.priority - a.plugin.priority);
  }

  async executeToolValidated(
    pluginName: string,
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const match = this.resolveToolProvider(pluginName, toolName);
    if (!match) throw new Error(`Tool not found: ${pluginName}/${toolName}`);
    const validated = match.declaration.inputSchema.parse(input);
    const result = await match.plugin.executeTool(toolName, validated, signal);
    try {
      return match.declaration.outputSchema.parse(result);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ToolOutputValidationError(toolName, pluginName, err);
      }
      throw err;
    }
  }

  async executeToolWithFallback(
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const candidates = this.listToolCandidates(toolName);
    if (candidates.length === 0) {
      throw new Error(`No tool plugins registered for capability: ${toolName}`);
    }
    const validated = candidates[0].declaration.inputSchema.parse(input);
    const errors: Error[] = [];
    for (const { plugin, declaration } of candidates) {
      try {
        const result = await plugin.executeTool(toolName, validated, signal);
        try {
          return declaration.outputSchema.parse(result);
        } catch (err) {
          const validationErr =
            err instanceof ZodError
              ? new ToolOutputValidationError(toolName, plugin.name, err)
              : err instanceof Error
                ? err
                : new Error(String(err));
          errors.push(validationErr);
        }
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    throw new AggregateError(
      errors,
      `All ${candidates.length} tool provider(s) failed for "${toolName}"`,
    );
  }

  // ─── Service Discovery ────────────────────────────────────

  registerService<T>(serviceName: string, service: T): T {
    const existing = this.serviceProviders.get(serviceName);
    if (existing) return existing as T;
    this.serviceProviders.set(serviceName, service);
    return service;
  }

  getService<T>(serviceName: string): T | undefined {
    return this.serviceProviders.get(serviceName) as T | undefined;
  }

  // ─── Collector Queries ──────────────────────────────────

  /**
   * Async collector matching — returns the first plugin whose canHandle resolves to true.
   */
  async matchCollector(input: CollectorInput): Promise<CollectorPlugin | null> {
    for (const collector of this.collectors) {
      if (await collector.canHandle(input)) {
        return collector;
      }
    }
    return null;
  }

  /**
   * Phase 4 adapter: returns an adapter with a simple
   * `collect(): Promise<CollectorResult>` interface (URL bound at match time).
   *
   * Supports both sync and async canHandle. All matching collectors are tried
   * in priority order; if the first fails, falls back to the next — UNLESS
   * the error is a `CollectorError` with `terminal === true` (e.g. 404/403/422),
   * in which case we re-throw immediately. Falling back on a semantic failure
   * would feed the pipeline a different URL's content (spec §8.4 R5 / F10).
   */
  async getCollector(
    url: string,
  ): Promise<{ collect: () => Promise<CollectorResult> } | undefined> {
    const input: CollectorInput = { url };
    const matchingCollectors: CollectorPlugin[] = [];

    for (const collector of this.collectors) {
      if (await collector.canHandle(input)) {
        matchingCollectors.push(collector);
      }
    }
    if (matchingCollectors.length === 0) {
      return undefined;
    }

    const defaultTimeoutMs = this.defaultCollectTimeoutMs;
    return {
      async collect(): Promise<CollectorResult> {
        const errors: Error[] = [];

        for (const collector of matchingCollectors) {
          const timeoutMs = collector.getCollectTimeoutMs?.() ?? defaultTimeoutMs;
          const controller = new AbortController();
          const timer = setTimeout(() => {
            controller.abort(
              new Error(
                `Collector timeout (${timeoutMs}ms); if page requires JS rendering, increase collectTimeoutSeconds`,
              ),
            );
          }, timeoutMs);
          try {
            const output: CollectorOutput = await collector.collect({ url }, controller.signal);
            return {
              content: output.content,
              title: output.title,
              metadata: { ...output.metadata, collectorPlugin: collector.name },
            };
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            errors.push(err);
            if (err instanceof CollectorError && err.terminal) {
              // Spec §8.4 R5 / F10 — semantic failures (404/403/422) must not
              // silently fall back to another collector, which would feed the
              // pipeline a different URL's content.
              throw err;
            }
            emitCollectDiagnostic(
              `Collector "${collector.name}" failed, trying next: ${truncate(err.message, DIAGNOSTIC_ERR_MAX)}`,
            );
          } finally {
            clearTimeout(timer);
          }
        }

        throw new AggregateError(errors, `${errors.length} collector(s) failed for ${url}`);
      },
    };
  }

  // ─── Lifecycle ──────────────────────────────────────────

  async initializeAll(context: PluginContext, capabilities?: ServiceCapabilities): Promise<void> {
    const allPlugins = [
      ...this.collectors,
      ...this.intentPlugins,
      ...this.toolPlugins,
      ...this.llmProviderPlugins,
    ];
    const errors: Array<{ plugin: string; error: Error }> = [];
    for (const plugin of allPlugins) {
      // Capability validation (before initialize)
      if (plugin.requiredCapabilities && plugin.requiredCapabilities.length > 0) {
        if (!capabilities) {
          throw new Error(
            `Plugin "${plugin.name}" requires capabilities [${plugin.requiredCapabilities.join(', ')}] but none were provided`,
          );
        }
        const missing = plugin.requiredCapabilities.filter(
          (key) => !(key in capabilities) || capabilities[key] === undefined,
        );
        if (missing.length > 0) {
          throw new Error(
            `Plugin "${plugin.name}" requires capabilities [${missing.join(', ')}] but they were not provided`,
          );
        }
      }
      if (plugin.initialize) {
        try {
          const filteredCaps = plugin.requiredCapabilities
            ? (Object.fromEntries(
                plugin.requiredCapabilities.map((k) => [k, capabilities?.[k]]),
              ) as Partial<ServiceCapabilities>)
            : undefined;
          await plugin.initialize(context, filteredCaps);
          this.initializedPlugins.add(plugin.name);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          errors.push({ plugin: plugin.name, error });
          this.logger?.warn(`Plugin "${plugin.name}" initialization failed: ${error.message}`);
        }
      } else {
        this.initializedPlugins.add(plugin.name);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors.map((e) => e.error),
        `${errors.length} plugin(s) failed to initialize: ${errors.map((e) => e.plugin).join(', ')}`,
      );
    }
  }

  /**
   * Invokes every registered plugin's `postInit` after `initializeAll` has
   * finished. Isolates failures per plugin — one plugin throwing does not
   * prevent the rest from running. Call explicitly (e.g. from bootstrap's
   * caller, after any composition-layer services are attached); not run
   * automatically by initializeAll.
   */
  async runPostInit(context: PluginContext, capabilities?: ServiceCapabilities): Promise<void> {
    const allPlugins = [
      ...this.collectors,
      ...this.intentPlugins,
      ...this.toolPlugins,
      ...this.llmProviderPlugins,
    ];
    for (const plugin of allPlugins) {
      if (typeof plugin.postInit !== 'function') continue;
      const filtered = plugin.requiredCapabilities
        ? (Object.fromEntries(
            plugin.requiredCapabilities.map((k) => [k, capabilities?.[k]]),
          ) as Partial<ServiceCapabilities>)
        : undefined;
      try {
        await plugin.postInit(context, filtered);
        this.logger?.info('plugin postInit complete', { plugin: plugin.name });
      } catch (err) {
        this.logger?.error('plugin postInit failed (continuing with remaining plugins)', {
          plugin: plugin.name,
          err: errorMessage(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    }
  }

  async destroyAll(): Promise<void> {
    const errors: Error[] = [];
    for (const plugin of [
      ...this.collectors,
      ...this.intentPlugins,
      ...this.toolPlugins,
      ...this.llmProviderPlugins,
    ]) {
      if (plugin.destroy && this.initializedPlugins.has(plugin.name)) {
        try {
          await plugin.destroy();
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
    this.initializedPlugins.clear();
    this.serviceProviders.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} plugin(s) failed to destroy`);
    }
  }

  getCollectors(): readonly CollectorPlugin[] {
    return this.collectors;
  }

  /**
   * Returns names of all collectors whose canHandle matches the URL, ordered by priority (high first).
   * Used for task log summaries before collection runs.
   */
  async listMatchingCollectorNames(url: string): Promise<string[]> {
    const input: CollectorInput = { url };
    const names: string[] = [];
    for (const collector of this.collectors) {
      if (await collector.canHandle(input)) {
        names.push(collector.name);
      }
    }
    return names;
  }
}
