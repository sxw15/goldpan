import { describe, expect, test } from 'vitest';
import { loadConfig } from '../config';
import { missingKeyedProviders, modelIdsFromConfig } from './provider-keys';

describe('modelIdsFromConfig', () => {
  test('includes translator model when pipeline output translation is enabled', () => {
    const config = loadConfig({
      ...process.env,
      GOLDPAN_TRANSLATE_PIPELINE_OUTPUT: 'true',
      GOLDPAN_LLM_TRANSLATOR: 'google:gemini-2.5-flash',
    });

    expect(config.llm.translator).toBe('google:gemini-2.5-flash');
    expect(modelIdsFromConfig(config)).toContain('google:gemini-2.5-flash');
    expect(missingKeyedProviders(modelIdsFromConfig(config), {})).toContain('google');
  });
});
