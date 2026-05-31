import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const coreDir = resolve(import.meta.dirname, '../core');
const runtimeDir = import.meta.dirname;

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@goldpan/core/db/schema': resolve(coreDir, 'src/db/schema.ts'),
      '@goldpan/core/db/migrate': resolve(coreDir, 'src/db/migrate.ts'),
      '@goldpan/core/db/sql-fragments': resolve(coreDir, 'src/db/sql-fragments.ts'),
      '@goldpan/core/db': resolve(coreDir, 'src/db/connection.ts'),
      '@goldpan/core/plugins': resolve(coreDir, 'src/plugins/index.ts'),
      '@goldpan/core/i18n': resolve(coreDir, 'src/i18n/index.ts'),
      '@goldpan/core/utils': resolve(coreDir, 'src/utils/index.ts'),
      '@goldpan/core/conversation': resolve(coreDir, 'src/conversation/index.ts'),
      '@goldpan/core/submit': resolve(coreDir, 'src/submit.ts'),
      '@goldpan/core': resolve(coreDir, 'src/index.ts'),
      '@goldpan/im-runtime/testing': resolve(runtimeDir, 'src/testing/index.ts'),
      '@goldpan/im-runtime': resolve(runtimeDir, 'src/index.ts'),
    },
  },
});
