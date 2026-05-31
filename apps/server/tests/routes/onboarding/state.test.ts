// apps/server/tests/routes/onboarding/state.test.ts
import { beforeEach, describe, expect, test } from 'vitest';
import {
  getWizardState,
  patchWizardState,
  resetWizardState,
} from '../../../src/routes/onboarding/state.js';

describe('wizard state in-memory', () => {
  beforeEach(() => resetWizardState());

  test('initial state is empty defaults', () => {
    const s = getWizardState();
    expect(s.language).toBeUndefined();
    expect(s.providers).toEqual({});
    expect(s.steps).toEqual({});
  });

  test('PATCH merges partial', () => {
    patchWizardState({ language: 'zh' });
    patchWizardState({ webEnabled: true });
    expect(getWizardState().language).toBe('zh');
    expect(getWizardState().webEnabled).toBe(true);
  });

  test('PATCH nested merge for providers map', () => {
    patchWizardState({ providers: { openai: { apiKey: 'sk-x' } } });
    patchWizardState({ providers: { anthropic: { apiKey: 'sk-y' } } });
    const s = getWizardState();
    expect(s.providers.openai?.apiKey).toBe('sk-x');
    expect(s.providers.anthropic?.apiKey).toBe('sk-y');
  });

  test('PATCH null deletes stale nested values', () => {
    patchWizardState({
      providers: { openai: { apiKey: 'sk-x' } },
      steps: { classifier: { model: 'openai:gpt-4o-mini' } },
      searchKeys: { tavily: 'tv-old' },
      authPassword: 'secret123',
    });
    patchWizardState({
      providers: { openai: null },
      steps: { classifier: { model: null } },
      searchKeys: { tavily: null },
      authPassword: null,
    });
    const s = getWizardState();
    expect(s.providers.openai).toBeUndefined();
    expect(s.steps.classifier?.model).toBeUndefined();
    expect(s.searchKeys?.tavily).toBeUndefined();
    expect(s.authPassword).toBeUndefined();
  });

  test('PATCH rejects invalid top-level state shapes', () => {
    // providers / steps top-level is a Record (replace whole map) — not nullable.
    expect(() => patchWizardState({ providers: null as never })).toThrow(/providers/i);
    expect(() => patchWizardState({ steps: null as never })).toThrow(/steps/i);
    expect(() => patchWizardState({ digest: 'bad' as never })).toThrow(/digest/i);
    expect(() => patchWizardState({ tracking: 1 as never })).toThrow(/tracking/i);
  });

  test('PATCH null clears nullable optional top-level subtree', () => {
    patchWizardState({
      digest: { enabled: true, modules: ['captures'] },
      tracking: { enabled: true, searchProviders: ['tavily'], rules: [] },
      embedding: { enabled: true, model: 'text-embedding-3-small' },
      im: { telegram: { enabled: true, fields: { botToken: 'tok' } } },
      searchKeys: { tavily: 'tv-x' },
    });
    patchWizardState({
      digest: null,
      tracking: null,
      embedding: null,
      im: null,
      searchKeys: null,
    });
    const s = getWizardState();
    expect(s.digest).toBeUndefined();
    expect(s.tracking).toBeUndefined();
    expect(s.embedding).toBeUndefined();
    expect(s.im).toBeUndefined();
    expect(s.searchKeys).toBeUndefined();
  });
});
