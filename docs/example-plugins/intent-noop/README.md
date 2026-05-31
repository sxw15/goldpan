# intent-__SLUG__

Example intent plugin. Declares a single `echo` intent that returns the user's input verbatim. Used as the template for `pnpm create-plugin intent <slug>`.

## Develop

```bash
pnpm install
pnpm --filter __PACKAGE_NAME__ build
```

After build, the plugin auto-registers (PluginRegistry scans `plugins/*/dist/index.js`) — drop it under `plugins/` and run `pnpm dev`.

See [`.agent/plugin-authoring-guide.md`](../../../../.agent/plugin-authoring-guide.md) for the full plugin authoring guide.
