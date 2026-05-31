# tool-search-__SLUG__

Example search tool plugin. Returns one canned result regardless of query. Used as the template for `pnpm create-plugin tool-search <slug>`.

## Develop

```bash
cd monorepo
pnpm install
pnpm --filter __PACKAGE_NAME__ build
```

After build, the plugin auto-registers (PluginRegistry scans `monorepo/plugins/*/dist/index.js`) — drop it under `monorepo/plugins/` and run `pnpm dev`.

See [`.agent/plugin-authoring-guide.md`](../../../../.agent/plugin-authoring-guide.md) for the full plugin authoring guide.
