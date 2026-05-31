import { describe, expect, it } from 'vitest';
import { ensureDigestTables } from '../../src/db.js';
import { handleDigestAction } from '../../src/im/handler.js';
import { DigestCrudService } from '../../src/service.js';
import { makeTestDbWithMetadata } from '../fixtures/seed.js';

function setup() {
  const { db } = makeTestDbWithMetadata();
  ensureDigestTables(db);
  const service = new DigestCrudService({ db, getTimezone: () => 'UTC' });
  service.seedDefaultPresets('telegram');
  return { service };
}

const ref = { channelId: 'telegram', accountId: 'a', chatId: 'c', userId: 'u' };

describe('handleDigestAction', () => {
  it('subscribe creates a subscription and returns success', async () => {
    const { service } = setup();
    const result = await handleDigestAction({
      action: { kind: 'subscribe', presetName: 'daily_default', pushTime: '09:00' },
      language: 'en',
      service,
      ref,
    });
    expect(result.type).toBe('action');
    expect(service.listSubscriptions(ref)).toHaveLength(1);
  });

  it('subscribe without explicit pushTime falls back to preset.pushTime', async () => {
    // schema 允许 subscribe.pushTime 可选;handler 必须用 preset 自带的默认推送时间。
    // 不然 IM 用户每次 /subscribe 都得手动重复 preset 已经配好的时间,等于把字段
    // 加到 preset 上但没拿到收益。
    const { service } = setup();
    const before = service.listPresets('telegram').find((p) => p.name === 'daily_default');
    expect(before?.pushTime).toBe('08:00');
    await handleDigestAction({
      action: { kind: 'subscribe', presetName: 'daily_default' },
      language: 'en',
      service,
      ref,
    });
    const subs = service.listSubscriptions(ref);
    expect(subs).toHaveLength(1);
    expect(subs[0].pushTime).toBe('08:00');
  });

  it('subscribe with explicit pushTime overrides preset.pushTime', async () => {
    const { service } = setup();
    await handleDigestAction({
      action: { kind: 'subscribe', presetName: 'daily_default', pushTime: '20:30' },
      language: 'en',
      service,
      ref,
    });
    const subs = service.listSubscriptions(ref);
    expect(subs[0].pushTime).toBe('20:30');
  });

  it('list returns content with 0 subs message', async () => {
    const { service } = setup();
    const result = await handleDigestAction({
      action: { kind: 'list' },
      language: 'en',
      service,
      ref,
    });
    expect(result.type).toBe('content');
    expect((result as { text: string }).text).toMatch(/no subscriptions/i);
  });

  it('pause without presetName pauses all matching subscriptions', async () => {
    const { service } = setup();
    const [preset] = service.listPresets('telegram');
    service.upsertSubscription({ ...ref, presetId: preset.id, pushTime: '09:00' });
    await handleDigestAction({
      action: { kind: 'pause' },
      language: 'en',
      service,
      ref,
    });
    expect(service.listSubscriptions(ref).every((s) => s.paused)).toBe(true);
  });

  it('resume clears paused', async () => {
    const { service } = setup();
    const [preset] = service.listPresets('telegram');
    const sub = service.upsertSubscription({ ...ref, presetId: preset.id, pushTime: '09:00' });
    service.updateSubscription(sub.id, { paused: true });
    await handleDigestAction({
      action: { kind: 'resume' },
      language: 'en',
      service,
      ref,
    });
    expect(service.listSubscriptions(ref).every((s) => !s.paused)).toBe(true);
  });

  it('set_push_time updates pushTime but keeps last_pushed_at', async () => {
    const { service } = setup();
    const [preset] = service.listPresets('telegram');
    const sub = service.upsertSubscription({ ...ref, presetId: preset.id, pushTime: '09:00' });
    service.markPushed(sub.id, 12345);
    await handleDigestAction({
      action: { kind: 'set_push_time', pushTime: '10:00' },
      language: 'en',
      service,
      ref,
    });
    expect(service.getSubscription(sub.id)?.pushTime).toBe('10:00');
    expect(service.getSubscription(sub.id)?.lastPushedAt).toBe(12345);
  });

  it('unsubscribe removes subscription', async () => {
    const { service } = setup();
    const [preset] = service.listPresets('telegram');
    service.upsertSubscription({ ...ref, presetId: preset.id, pushTime: '09:00' });
    await handleDigestAction({
      action: { kind: 'unsubscribe' },
      language: 'en',
      service,
      ref,
    });
    expect(service.listSubscriptions(ref)).toHaveLength(0);
  });

  it('zh language uses zh formatters', async () => {
    const { service } = setup();
    const result = await handleDigestAction({
      action: { kind: 'list' },
      language: 'zh',
      service,
      ref,
    });
    expect((result as { text: string }).text).toMatch(/没有订阅/);
  });
});
