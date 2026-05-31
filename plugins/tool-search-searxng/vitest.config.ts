import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const coreDir = resolve(import.meta.dirname, '../../packages/core');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@goldpan/core/plugins': resolve(coreDir, 'src/plugins/index.ts'),
    },
  },
});
