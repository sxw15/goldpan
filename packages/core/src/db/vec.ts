import type Database from 'better-sqlite3';
import type { ILogObj, Logger } from 'tslog';
import type { EmbeddingProvider } from '../embedding/types';
import { parseJsonStringArray } from './json-columns';

const META_KEY_MODEL = 'embedding_model';
const META_KEY_DIMENSIONS = 'embedding_dimensions';

export function ensureVecTables(
  rawDb: Database.Database,
  modelId: string,
  dimensions: number,
): void {
  const existingModel = rawDb
    .prepare('SELECT value FROM db_metadata WHERE key = ?')
    .get(META_KEY_MODEL) as { value: string } | undefined;
  const existingDims = rawDb
    .prepare('SELECT value FROM db_metadata WHERE key = ?')
    .get(META_KEY_DIMENSIONS) as { value: string } | undefined;

  if (existingModel?.value === modelId && existingDims?.value === String(dimensions)) {
    return;
  }

  rawDb
    .transaction(() => {
      rawDb.exec('DROP TABLE IF EXISTS entities_vec');
      rawDb.exec('DROP TABLE IF EXISTS knowledge_points_vec');

      rawDb.exec(`
        CREATE VIRTUAL TABLE entities_vec USING vec0(
          rowid INTEGER PRIMARY KEY,
          embedding FLOAT[${dimensions}]
        )
      `);
      rawDb.exec(`
        CREATE VIRTUAL TABLE knowledge_points_vec USING vec0(
          rowid INTEGER PRIMARY KEY,
          embedding FLOAT[${dimensions}]
        )
      `);

      const upsert = rawDb.prepare(
        `INSERT INTO db_metadata(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
      upsert.run(META_KEY_MODEL, modelId);
      upsert.run(META_KEY_DIMENSIONS, String(dimensions));
    })
    .immediate();
}

export function composeEntityText(entity: {
  name: string;
  description: string | null;
  aliases: string;
  keywords: string;
}): string {
  const parts: string[] = [entity.name];
  if (entity.description) parts.push(entity.description);

  const aliases = parseJsonStringArray(entity.aliases);
  const keywords = parseJsonStringArray(entity.keywords);

  if (aliases.length > 0) parts.push(`Aliases: ${aliases.join(', ')}`);
  if (keywords.length > 0) parts.push(`Keywords: ${keywords.join(', ')}`);

  return parts.join('. ');
}

export async function backfillEmbeddings(
  rawDb: Database.Database,
  provider: EmbeddingProvider,
  batchSize: number,
  logger: Logger<ILogObj>,
): Promise<void> {
  const missingEntities = rawDb
    .prepare(
      `SELECT e.id, e.name, e.description, e.aliases, e.keywords
       FROM entities e
       LEFT JOIN entities_vec ev ON ev.rowid = e.id
       WHERE ev.rowid IS NULL`,
    )
    .all() as Array<{
    id: number;
    name: string;
    description: string | null;
    aliases: string;
    keywords: string;
  }>;

  const missingPoints = rawDb
    .prepare(
      `SELECT kp.id, kp.content
       FROM knowledge_points kp
       LEFT JOIN knowledge_points_vec kpv ON kpv.rowid = kp.id
       WHERE kpv.rowid IS NULL AND kp.status = 'active'`,
    )
    .all() as Array<{ id: number; content: string }>;

  const total = missingEntities.length + missingPoints.length;
  if (total === 0) return;

  logger.info(
    `[embedding] Backfill starting: ${missingEntities.length} entities, ${missingPoints.length} points`,
  );

  for (let i = 0; i < missingEntities.length; i += batchSize) {
    const batch = missingEntities.slice(i, i + batchSize);
    const texts = batch.map(composeEntityText);
    const embeddings = await provider.embedMany(texts);
    rawDb.transaction(() => {
      const insert = rawDb.prepare('INSERT INTO entities_vec(rowid, embedding) VALUES (?, ?)');
      for (let j = 0; j < batch.length; j++) {
        insert.run(BigInt(batch[j].id), new Float32Array(embeddings[j]));
      }
    })();
    logger.info(
      `[embedding] Entities: ${Math.min(i + batchSize, missingEntities.length)}/${missingEntities.length}`,
    );
  }

  for (let i = 0; i < missingPoints.length; i += batchSize) {
    const batch = missingPoints.slice(i, i + batchSize);
    const texts = batch.map((p) => p.content);
    const embeddings = await provider.embedMany(texts);
    rawDb.transaction(() => {
      const insert = rawDb.prepare(
        'INSERT INTO knowledge_points_vec(rowid, embedding) VALUES (?, ?)',
      );
      for (let j = 0; j < batch.length; j++) {
        insert.run(BigInt(batch[j].id), new Float32Array(embeddings[j]));
      }
    })();
    logger.info(
      `[embedding] Points: ${Math.min(i + batchSize, missingPoints.length)}/${missingPoints.length}`,
    );
  }

  logger.info(`[embedding] Backfill complete: ${total} records embedded`);
}
