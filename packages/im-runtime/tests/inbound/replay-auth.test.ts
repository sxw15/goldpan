import { describe, expect, it } from 'vitest';
import { isReplayAuthorized } from '../../src/inbound/replay-auth.js';

const baseActor = {
  channelId: 'feishu',
  accountId: 'cli_x',
  chatId: 'oc_1',
  userId: 'ou_alice',
};

describe('isReplayAuthorized', () => {
  it('authorizes when channel/account/chat match (per_chat sessionKey)', () => {
    expect(isReplayAuthorized('feishu:cli_x:oc_1', baseActor)).toBe(true);
  });

  it('authorizes per_chat regardless of which user in the chat is replaying', () => {
    // per_chat sessionKey has no user component; any user in the same chat
    // may interact with the card. This mirrors how the originating chat
    // works — anyone in oc_1 can scroll up and tap the same button.
    expect(isReplayAuthorized('feishu:cli_x:oc_1', { ...baseActor, userId: 'ou_someone' })).toBe(
      true,
    );
  });

  it('rejects cross-chat replay (different chatId)', () => {
    expect(isReplayAuthorized('feishu:cli_x:oc_OTHER', baseActor)).toBe(false);
  });

  it('rejects cross-channel replay (different channelId)', () => {
    expect(isReplayAuthorized('telegram:cli_x:oc_1', baseActor)).toBe(false);
  });

  it('rejects cross-account replay (different accountId)', () => {
    expect(isReplayAuthorized('feishu:cli_OTHER:oc_1', baseActor)).toBe(false);
  });

  it('per_user: authorizes when the userId matches', () => {
    expect(isReplayAuthorized('feishu:cli_x:oc_1:ou_alice', baseActor)).toBe(true);
  });

  it('per_user: rejects cross-user replay even within the same chat', () => {
    expect(
      isReplayAuthorized('feishu:cli_x:oc_1:ou_OTHER', { ...baseActor, userId: 'ou_alice' }),
    ).toBe(false);
  });

  it('rejects malformed sessionKey (too few segments)', () => {
    expect(isReplayAuthorized('feishu:cli_x', baseActor)).toBe(false);
  });

  it('rejects malformed sessionKey (too many segments)', () => {
    expect(isReplayAuthorized('feishu:cli_x:oc_1:ou_alice:extra', baseActor)).toBe(false);
  });

  // ---- Deliberate cross-thread acceptance — see replay-auth.ts header ----
  //
  // The actor type carries no threadId by design; the threadId on the
  // originating session lives in the persisted sessionKey and is restored
  // via `sessionKeyOverride` on the synthesized re-dispatch. The defense
  // against cross-thread routing belongs at *that* boundary, not here.
  //
  // These tests pin that contract so a future "tighten replay-auth"
  // refactor can't silently re-introduce the rejection of legitimate
  // Telegram clarify taps (callback_query has no thread_id at all) or
  // Feishu DM clarify taps (no thread_id outside group chats).

  it('authorizes when the persisted sessionKey carries a threadId (actor never carries thread metadata)', () => {
    expect(isReplayAuthorized('feishu:cli_x:oc_1:t=omt_thread_a', baseActor)).toBe(true);
  });

  it('authorizes per_user even when the persisted sessionKey carries a threadId', () => {
    expect(isReplayAuthorized('feishu:cli_x:oc_1:ou_alice:t=omt_thread_a', baseActor)).toBe(true);
  });

  // The synthesized re-dispatch does NOT consult this function for the
  // threadId — it uses sessionKeyOverride pulled from the conversation
  // row. So even if a future channel forwards thread metadata into the
  // actor type, this function intentionally ignores it; the test
  // documents that intent rather than the absence of the field.
  it('actor objects with extra fields are silently ignored (no threadId comparison)', () => {
    const actorWithFakeThread = {
      ...baseActor,
      threadId: 'omt_thread_b',
    };
    expect(isReplayAuthorized('feishu:cli_x:oc_1:t=omt_thread_a', actorWithFakeThread)).toBe(true);
  });
});
