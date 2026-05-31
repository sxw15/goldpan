# @goldpan/im-runtime

IM channel orchestration layer for Goldpan. Provides the runtime that bridges
external messaging platforms (Telegram, Discord, etc.) with Goldpan's
`handleInput` pipeline.

## Architecture

This is **Layer A** in the three-layer IM design:

- **Layer C** (`@goldpan/core`) — DB, repos, types, pipeline
- **Layer A** (`@goldpan/im-runtime`) — channel registry, dispatcher, runtime ← you are here
- **Layer B** (`@goldpan/plugin-im-*`) — platform-specific adapters

See `docs/superpowers/specs/2026-04-17-im-plugin-design.md` for the full spec.
