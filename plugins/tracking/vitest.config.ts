import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const coreDir = resolve(import.meta.dirname, '../../packages/core');

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      // More specific aliases must come first — `@goldpan/core/db` is a prefix
      // match and would otherwise swallow `@goldpan/core/db/repositories`,
      // resolving to `src/db/connection.ts/repositories` (a non-directory).
      '@goldpan/core/db/repositories': resolve(coreDir, 'src/db/repositories/index.ts'),
      '@goldpan/core/db/sql-fragments': resolve(coreDir, 'src/db/sql-fragments.ts'),
      '@goldpan/core/db': resolve(coreDir, 'src/db/connection.ts'),
      '@goldpan/core/plugins': resolve(coreDir, 'src/plugins/index.ts'),
      '@goldpan/core/i18n': resolve(coreDir, 'src/i18n/index.ts'),
      '@goldpan/core/prompts': resolve(coreDir, 'src/prompts/index.ts'),
      '@goldpan/core/utils': resolve(coreDir, 'src/utils/index.ts'),
      '@goldpan/core/submit': resolve(coreDir, 'src/submit.ts'),
    },
  },
});
