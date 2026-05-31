import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: (() => {
      const raw = process.env.GOLDPAN_DB_SQLITE_PATH;
      if (!raw) return path.resolve(monorepoRoot, 'data/goldpan.db');
      return path.isAbsolute(raw) ? raw : path.resolve(monorepoRoot, raw);
    })(),
  },
});
