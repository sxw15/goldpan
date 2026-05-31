# @goldpan/plugin-github-intent

Intent plugin that refreshes known GitHub repositories on demand via natural-language requests.

Parses user messages like `refresh vercel/next.js` and dispatches to the GitHub collector (`@goldpan/plugin-github-collector`) for an up-to-date snapshot.

Prompts live at the package root under `prompts/` (not under `src/`), consistent with other Goldpan plugins.

See spec §6.1.2 of `docs/superpowers/plans/2026-04-19-github-collector-phase1.md` for the full design.
