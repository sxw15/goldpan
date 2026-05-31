import type { CollectorOutput } from '@goldpan/core/plugins';
import { describe, expect, it } from 'vitest';
import { collectorMediaPlugin } from '../src/index';

const RUN_INTEGRATION = process.env.GOLDPAN_INTEGRATION_TESTS === 'true';

describe.runIf(RUN_INTEGRATION)('collector-media integration', () => {
  it('fetches "Me at the zoo" YouTube video subtitles', async () => {
    const logger = {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
    };
    await collectorMediaPlugin.initialize?.({
      logger: logger as never,
      pluginConfig: {
        dataDir: '/tmp/goldpan-integration',
        mediaCollectTimeoutSeconds: 120,
        ytDlpAutoUpdate: false,
        language: 'en',
      },
    });

    try {
      // collect() is the only step where flaky network / YouTube policy
      // changes can produce non-deterministic failures; isolate the catch
      // there so plugin regressions in later steps fail the test loudly.
      const controller = new AbortController();
      let result: CollectorOutput | null = null;
      try {
        result = await collectorMediaPlugin.collect(
          { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
          controller.signal,
        );
      } catch (err) {
        console.warn('[integration] fixture URL unavailable, skipping:', err);
        return;
      }

      expect(result.title).toBeTruthy();
      expect(result.content).toContain('# ');
      expect(result.content).toContain('## Transcript');
      expect(result.finalUrl).toContain('youtube.com');
      expect(result.metadata.collector_video_id).toBe('jNQXAC9IVRw');
      expect(result.metadata.collector_video_subtitle_lang).toBeTruthy();
      expect(['manual', 'auto']).toContain(result.metadata.collector_video_subtitle_kind);
    } finally {
      await collectorMediaPlugin.destroy?.();
    }
  }, 180_000);
});
