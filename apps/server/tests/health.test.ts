import type { ChannelDescriptor } from '@goldpan/im-runtime';
import { describe, expect, it } from 'vitest';
import {
  buildHealthResponse,
  dualProcessConfigHash,
  type HealthChannelView,
} from '../src/health.js';

// Compile-time contract: the runtime's ChannelDescriptor must remain assignable to the
// locally-mirrored HealthChannelView. If the runtime adds a required field or changes the
// `state` union, this assignment fails to compile and forces a deliberate /health update.
//
// LIMITATION: TypeScript structural subtyping does NOT catch new *optional* fields on
// ChannelDescriptor — those are silently dropped from /health. See the HealthChannelView
// JSDoc for the rationale and ops-side mitigation.
type _AssertChannelDescriptorAssignable = ChannelDescriptor extends HealthChannelView
  ? true
  : never;
const _channelDescriptorContract: _AssertChannelDescriptorAssignable = true;
void _channelDescriptorContract;

const EMPTY_PENDING: ReadonlySet<string> = new Set<string>();
const PLACEHOLDER_HASH = 'deadbeefcafe1234';

describe('buildHealthResponse', () => {
  it('keeps the health shape stable for healthy workers without IM channels', () => {
    const response = buildHealthResponse({
      workerRunning: true,
      runtimeChannels: [],
      pendingRestartKeys: EMPTY_PENDING,
      dualProcessConfigHash: PLACEHOLDER_HASH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      worker: { running: true },
      channels: [],
      pendingRestartKeys: [],
      dualProcessConfigHash: PLACEHOLDER_HASH,
    });
  });

  it('reports degraded health when a runtime-reported IM channel is in error', () => {
    // The runtime now retains failed channel entries inside `describeChannels()` —
    // this test verifies /health surfaces them directly without a parallel failure list.
    const failedChannel: HealthChannelView = {
      channelId: 'telegram',
      state: 'error',
      inFlightCount: 0,
      lastErrorAt: new Date('2026-04-18T00:00:00.000Z'),
      lastErrorMessage: 'boom',
    };

    const response = buildHealthResponse({
      workerRunning: true,
      runtimeChannels: [failedChannel],
      pendingRestartKeys: EMPTY_PENDING,
      dualProcessConfigHash: PLACEHOLDER_HASH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('degraded');
    expect(response.body.worker).toEqual({ running: true });
    expect(response.body.channels).toEqual([failedChannel]);
    expect(response.body.pendingRestartKeys).toEqual([]);
    expect(response.body.dualProcessConfigHash).toBe(PLACEHOLDER_HASH);
  });

  it('reports ok when every runtime channel is running', () => {
    const runningChannel: HealthChannelView = {
      channelId: 'telegram',
      state: 'running',
      inFlightCount: 0,
    };

    const response = buildHealthResponse({
      workerRunning: true,
      runtimeChannels: [runningChannel],
      pendingRestartKeys: EMPTY_PENDING,
      dualProcessConfigHash: PLACEHOLDER_HASH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.channels).toEqual([runningChannel]);
  });

  it('still reports worker failures as 503', () => {
    const response = buildHealthResponse({
      workerRunning: false,
      runtimeChannels: [],
      pendingRestartKeys: EMPTY_PENDING,
      dualProcessConfigHash: PLACEHOLDER_HASH,
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      type: 'error',
      code: 'worker_not_running',
      message: 'Worker is not running',
      status: 'degraded',
      worker: { running: false },
      channels: [],
      pendingRestartKeys: [],
      dualProcessConfigHash: PLACEHOLDER_HASH,
    });
  });

  it('returns an empty pendingRestartKeys for a fresh process', () => {
    // Boot-time invariant: nothing committed yet → empty array regardless of
    // any other field. Helps external monitors discriminate "fresh process /
    // nothing pending" from "lost the accumulator somehow".
    const response = buildHealthResponse({
      workerRunning: true,
      runtimeChannels: [],
      pendingRestartKeys: EMPTY_PENDING,
      dualProcessConfigHash: PLACEHOLDER_HASH,
    });
    expect(response.body.pendingRestartKeys).toEqual([]);
  });

  it('returns sorted pendingRestartKeys after commits accumulated', () => {
    // The accumulator is a Set inside main.ts; insertion order is whatever the
    // commits happened in. We sort here for a deterministic wire payload so
    // diffing in monitoring tools doesn't show spurious changes when the same
    // keys arrive in a different order across restarts.
    const pending = new Set<string>([
      'GOLDPAN_LANGUAGE',
      'GOLDPAN_AUTH_PASSWORD',
      'GOLDPAN_DIGEST_ENABLED',
    ]);
    const response = buildHealthResponse({
      workerRunning: true,
      runtimeChannels: [],
      pendingRestartKeys: pending,
      dualProcessConfigHash: PLACEHOLDER_HASH,
    });
    expect(response.body.pendingRestartKeys).toEqual([
      'GOLDPAN_AUTH_PASSWORD',
      'GOLDPAN_DIGEST_ENABLED',
      'GOLDPAN_LANGUAGE',
    ]);
  });
});

describe('dualProcessConfigHash', () => {
  it('produces a stable 16-char hex fingerprint', () => {
    const env: NodeJS.ProcessEnv = {
      GOLDPAN_AUTH_PASSWORD: 'pw1',
      GOLDPAN_LANGUAGE: 'en',
    };
    const hash = dualProcessConfigHash(env);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    // Stable: same input → same output across calls.
    expect(dualProcessConfigHash(env)).toBe(hash);
  });

  it('changes when GOLDPAN_LANGUAGE value changes', () => {
    // LANGUAGE is the canonical case where fingerprinting helps — a user
    // sees server-translated text but the web UI still shows the old
    // language with no immediate symptom. The hash MUST flip on language
    // divergence so external monitors can spot it.
    const before = dualProcessConfigHash({ GOLDPAN_LANGUAGE: 'en' });
    const after = dualProcessConfigHash({ GOLDPAN_LANGUAGE: 'zh' });
    expect(after).not.toBe(before);
  });

  it('is STABLE when GOLDPAN_AUTH_PASSWORD changes — password is excluded from the fingerprint', () => {
    // Security-driven property: `/health` is unauthenticated, so any value
    // derived from it is publicly observable. A 16-hex-char (64-bit)
    // truncation of SHA-256 over a typical user password is dictionary-
    // attack-feasible, so AUTH_PASSWORD is intentionally NOT in
    // HASH_FINGERPRINT_KEYS. Password divergence between server and web
    // is auto-detected by the natural failure mode (web 401 on first
    // authenticated request) — fingerprinting adds zero detection power
    // for that case while exposing a crackable digest.
    //
    // If this test starts failing, double-check that the change to
    // HASH_FINGERPRINT_KEYS was a deliberate security decision and not an
    // accidental re-introduction of password into the public fingerprint.
    const before = dualProcessConfigHash({
      GOLDPAN_AUTH_PASSWORD: 'pw1',
      GOLDPAN_LANGUAGE: 'en',
    });
    const after = dualProcessConfigHash({
      GOLDPAN_AUTH_PASSWORD: 'pw2',
      GOLDPAN_LANGUAGE: 'en',
    });
    expect(after).toBe(before);
  });

  it('treats unset and empty string identically (both contribute "")', () => {
    // Both translate to "GOLDPAN_LANGUAGE=" in the hashed payload — we
    // pin this so a deployment that switches from "unset" to "" doesn't
    // appear to drift the hash and trigger a false dual-process alarm.
    const a = dualProcessConfigHash({});
    const b = dualProcessConfigHash({ GOLDPAN_LANGUAGE: '' });
    expect(a).toBe(b);
  });
});
