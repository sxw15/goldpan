# @goldpan/plugin-im-telegram

Telegram (long-polling) channel adapter for `@goldpan/im-runtime`. Registered statically by `apps/server/src/main.ts` when `GOLDPAN_IM_TELEGRAM_BOT_TOKEN` is set (see Task 30b in the implementation plan).

Required env vars:
- `GOLDPAN_IM_TELEGRAM_BOT_TOKEN` — the bot's token (BotFather)
- `GOLDPAN_IM_TELEGRAM_ALLOWED_CHAT_IDS` — comma-separated list of chat IDs allowed to talk to the bot

See `docs/superpowers/specs/2026-04-17-im-plugin-design.md`.
