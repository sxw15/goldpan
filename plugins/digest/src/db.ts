import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DrizzleDB, getRawDatabase } from '@goldpan/core/db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_VERSION_KEY = 'plugin:digest:schema_version';
const CURRENT_VERSION = '3';

// 版本链:每条 entry 说明"从 fromVersion 升到 toVersion 要跑哪个 .sql"。
// fromVersion = undefined 代表 fresh 安装。版本只增不删,新增 migration 时追加 entry。
const MIGRATIONS: ReadonlyArray<{ from: string | undefined; to: string; file: string }> = [
  { from: undefined, to: '1', file: '0001_init.sql' },
  { from: '1', to: '2', file: '0002_preset_push_time.sql' },
  { from: '2', to: '3', file: '0003_preset_window_mode.sql' },
];

export function ensureDigestTables(db: DrizzleDB): void {
  const raw = getRawDatabase(db);
  raw
    .transaction(() => {
      const row = raw
        .prepare('SELECT value FROM db_metadata WHERE key = ?')
        .get(SCHEMA_VERSION_KEY) as { value?: string } | undefined;
      let current = row?.value;
      if (current === CURRENT_VERSION) return;
      for (const step of MIGRATIONS) {
        if (step.from !== current) continue;
        const sqlPath = path.join(__dirname, '..', 'drizzle', step.file);
        raw.exec(readFileSync(sqlPath, 'utf8'));
        current = step.to;
      }
      raw
        .prepare(
          `INSERT INTO db_metadata (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(SCHEMA_VERSION_KEY, CURRENT_VERSION);
    })
    .immediate();
}

export function resetCrashedDigestState(db: DrizzleDB): void {
  const raw = getRawDatabase(db);
  raw
    .prepare(
      `UPDATE daily_reports SET ai_summary_status = 'fallback'
       WHERE ai_summary_status = 'pending'`,
    )
    .run();
}
