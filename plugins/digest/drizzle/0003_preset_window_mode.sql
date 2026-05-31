-- digest plugin schema v3: per-preset window mode
-- calendar = 对齐本地零点(daily=昨天 00:00..23:59、weekly=过去 7 个完整日历日);
-- rolling  = 以 snapshot 生成时刻为锚点的滚动窗口(daily=now-24h..now、weekly=now-7d..now)。
-- 旧行默认 calendar,保持现状不影响存量行为。
ALTER TABLE digest_presets ADD COLUMN window_mode TEXT NOT NULL DEFAULT 'calendar'
  CHECK(window_mode IN ('calendar','rolling'));
