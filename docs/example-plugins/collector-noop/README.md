# collector-__SLUG__

Example collector plugin. Doesn't actually fetch — echoes the input URL as markdown. Used as the template for `pnpm create-plugin collector <slug>`.

## Develop

```bash
cd monorepo
pnpm install
pnpm --filter __PACKAGE_NAME__ build
```

After build, the plugin auto-registers (PluginRegistry scans `monorepo/plugins/*/dist/index.js`) — drop it under `monorepo/plugins/` and run `pnpm dev`.

See [`.agent/plugin-authoring-guide.md`](../../../../.agent/plugin-authoring-guide.md) for the full plugin authoring guide.
