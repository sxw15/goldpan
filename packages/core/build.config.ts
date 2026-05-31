import { defineBuildConfig } from 'unbuild';

export default defineBuildConfig({
  // Co-located `src/**/*.test.ts` are included by vitest (vitest.config.ts) but
  // must NOT ship to consumers — they import `vitest` (devDep) and would 500
  // any consumer that resolves them.
  entries: [
    { builder: 'mkdist', input: './src', outDir: './dist', pattern: ['**/*', '!**/*.test.*'] },
  ],
  declaration: true,
  clean: true,
});
