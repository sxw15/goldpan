-- digest plugin schema v1
CREATE TABLE IF NOT EXISTS daily_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  report_date TEXT NOT NULL,
  period TEXT NOT NULL CHECK(period IN ('daily','weekly')),
  preset_id INTEGER,
  snapshot_json TEXT NOT NULL,
  ai_summary_status TEXT NOT NULL CHECK(ai_summary_status IN ('pending','complete','fallback')),
  generated_at INTEGER NOT NULL
);

-- SQLite treats NULLs as distinct in UNIQUE constraints, so the two cases
-- (channel-level `preset_id IS NULL` snapshots persisted by backfill / the
-- daily cron, vs preset-specific snapshots persisted by the push scheduler)
-- must be deduped with separate partial UNIQUE indexes — otherwise reruns
-- and parallel schedulers silently insert duplicate rows for the same
-- (channel, date). `saveReport` mirrors this split with two UPSERT paths.
CREATE UNIQUE INDEX IF NOT EXISTS ux_daily_reports_channel_level
  ON daily_reports(channel, report_date) WHERE preset_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_daily_reports_preset
  ON daily_reports(channel, report_date, preset_id) WHERE preset_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS digest_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  name TEXT NOT NULL,
  period TEXT NOT NULL CHECK(period IN ('daily','weekly')),
  push_day INTEGER,
  slots_json TEXT NOT NULL,
  skip_empty INTEGER NOT NULL DEFAULT 1 CHECK(skip_empty IN (0,1)),
  include_ai_summary INTEGER NOT NULL DEFAULT 1 CHECK(include_ai_summary IN (0,1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(period <> 'weekly' OR push_day IS NOT NULL),
  UNIQUE(channel, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_digest_presets_default_per_channel
  ON digest_presets(channel) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS digest_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  preset_id INTEGER NOT NULL REFERENCES digest_presets(id) ON DELETE RESTRICT,
  push_time TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
  last_pushed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(channel_id, account_id, chat_id, user_id, preset_id)
);

CREATE INDEX IF NOT EXISTS ix_digest_subscriptions_due
  ON digest_subscriptions(paused, push_time);
