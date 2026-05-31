import { sql } from 'drizzle-orm';

// SQLite 表达式：当前 UTC 时间的 epoch 毫秒整数。所有时间列统一使用此默认值。
// julianday('now') 自 SQLite 3.0 起可用，CAST 后存为 INTEGER 而非 REAL。
// 1970-01-01 UTC = JD 2440587.5；1 day = 86400000 ms。
// ROUND 必需：julianday 的浮点表示让 (julianday - 2440587.5) * 86400000 系统性
// 比真实 ms 低约 0.98，CAST AS INTEGER 直接 truncate 会让每行恒定低 1ms。
//
// 两种导出形态，**指向同一表达式**，区别只在消费方式：
//   - NOW_MS_SQL: 原始 string，给手写 raw SQL 用（`db.prepare(\`... ${NOW_MS_SQL}\`)`）
//   - NOW_MS:    drizzle SQL 对象，给 schema DEFAULT / drizzle 表达式用（`.default(NOW_MS)`）
export const NOW_MS_SQL = `CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)`;

export const NOW_MS = sql.raw(`(${NOW_MS_SQL})`);
