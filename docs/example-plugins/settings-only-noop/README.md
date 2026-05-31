# settings-only-__SLUG__

Example "settings-only" plugin. Demonstrates the full `PluginSettingsContribution` surface — fields (text + secret), action (with `requires` + `errorMessages`), and setupGuide step — without any runtime behavior. Useful when the user-facing piece is just configuration / a smoke-test button. Used as the template for `pnpm create-plugin settings-only <slug>`.

## Develop

```bash
pnpm install
pnpm --filter __PACKAGE_NAME__ build
```

After build, the plugin auto-registers (PluginRegistry scans `plugins/*/dist/index.js`) — drop it under `plugins/` and run `pnpm dev`.

See [`.agent/plugin-authoring-guide.md`](../../../../.agent/plugin-authoring-guide.md) for the full plugin authoring guide.
