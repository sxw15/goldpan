# im-__SLUG__

Example IM channel adapter plugin. Doesn't actually connect to any service — exposes the registration shape so plugin authors can see what an IM adapter looks like before implementing one. Used as the template for `pnpm create-plugin im <slug>`.

IM plugins currently use the `ImSettingsManifest` protocol; Phase 2 will unify it with `PluginSettingsContribution`.

## Develop

```bash
pnpm install
pnpm --filter __PACKAGE_NAME__ build
```

After build, the plugin auto-registers (the IM loader scans `plugins/im-*/dist/index.js`) — drop it under `plugins/im-<slug>/` and run `pnpm dev`.

See [`.agent/plugin-authoring-guide.md`](../../../../.agent/plugin-authoring-guide.md) for the full plugin authoring guide.
