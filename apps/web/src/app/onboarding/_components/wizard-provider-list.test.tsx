import { describe, expect, test } from 'vitest';
import { buildRemoveProviderPatch } from './wizard-provider-list';
import type { WizardState } from './wizard-state';

describe('buildRemoveProviderPatch', () => {
  test('clears every model reference owned by the removed provider', () => {
    const patch = buildRemoveProviderPatch('openai', {
      providers: { openai: { apiKey: 'sk' }, anthropic: { apiKey: 'sk-ant' } },
      steps: {
        classifier: { model: 'openai:gpt-4o-mini' },
        extractor: { model: 'anthropic:claude-sonnet-4-20250514' },
      },
      digest: {
        enabled: true,
        modules: ['captures'],
        summaryModel: 'openai:gpt-4o-mini',
        actionModel: 'anthropic:claude-sonnet-4-20250514',
      },
      embedding: {
        enabled: true,
        model: 'openai:text-embedding-3-small',
      },
    } satisfies WizardState);

    expect(patch.providers?.openai).toBeNull();
    expect(patch.steps?.classifier?.model).toBeNull();
    expect(patch.steps?.extractor).toBeUndefined();
    expect(patch.digest?.summaryModel).toBeNull();
    expect(patch.digest?.actionModel).toBeUndefined();
    expect(patch.embedding?.model).toBeNull();
  });
});
