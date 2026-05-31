# @goldpan/plugin-github-collector

GitHub-repo-aware collector for goldpan. Given `https://github.com/{owner}/{repo}` (or common subpaths), fetches README / Releases / recent commits / CHANGELOG via the GitHub REST API. Supports initial and incremental collection driven by watermarks stored in `sources.metadata`.

**This package also owns `GithubService`** (refresh orchestration: cooldown / archived / in-progress pre-checks, sources+task insertion). That job logically belongs in the composition layer, but the framework's single `goldpanPlugin` export prevents a dual collector+service package — see spec §3 "P5" and "R4" for the Phase 1 trade-off.

## Exports

- `goldpanPlugin` — `CollectorPlugin` registered by the external loader
- `type GithubService` — interface consumed by `@goldpan/plugin-github-intent` via `import type`
- `type RefreshResult`, `type RepoState` — result union / read model

## Env

See spec §13 for the full `GOLDPAN_GITHUB_*` table.
