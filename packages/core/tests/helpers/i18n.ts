import { beforeEach } from 'vitest';

beforeEach(async () => {
  const { resetI18n, initI18n } = await import('../../src/i18n/index.js');
  resetI18n();
  initI18n('en');
});
