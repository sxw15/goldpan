-- digest plugin schema v2: per-preset push time
-- daily preset 默认 '08:00'；weekly preset 此前 UI 显示 hard-coded '09:00',
-- 迁移时把已有 weekly 行同步过去以保持视觉一致(用户可在 drawer 手动改)。
ALTER TABLE digest_presets ADD COLUMN push_time TEXT NOT NULL DEFAULT '08:00';
UPDATE digest_presets SET push_time = '09:00' WHERE period = 'weekly';
