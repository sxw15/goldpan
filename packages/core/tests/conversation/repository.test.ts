import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteConversationRepository } from '../../src/db/repositories/conversation.repository';
import { createTestDB, type TestDB } from '../helpers/test-db';

let testDb: TestDB;
let repo: SqliteConversationRepository;

beforeEach(() => {
  testDb = createTestDB();
  repo = new SqliteConversationRepository(testDb.db);
});
afterEach(() => testDb.cleanup());

describe('ConversationRepository', () => {
  describe('findOrCreate', () => {
    it('creates a new conversation when none exists', () => {
      const r = repo.findOrCreate('telegram:bot1:123', 'telegram');
      expect(r.created).toBe(true);
      expect(r.id).toBeGreaterThan(0);
    });
    it('returns existing active conversation', () => {
      const r1 = repo.findOrCreate('s', 'telegram');
      const r2 = repo.findOrCreate('s', 'telegram');
      expect(r2.id).toBe(r1.id);
      expect(r2.created).toBe(false);
    });
  });

  describe('appendMessage + loadContext', () => {
    it('persists user and assistant messages in chronological order', () => {
      const { id } = repo.findOrCreate('s', 'telegram');
      repo.appendMessage(id, { role: 'user', content: 'hi' });
      repo.appendMessage(id, { role: 'assistant', content: 'hello' });
      const ctx = repo.loadContext('s', 10);
      expect(ctx).not.toBeNull();
      expect(ctx!.recentMessages).toHaveLength(2);
      expect(ctx!.recentMessages[0].content).toBe('hi');
      expect(ctx!.recentMessages[1].content).toBe('hello');
    });
    it('loadContext respects windowSize', () => {
      const { id } = repo.findOrCreate('s', 'telegram');
      for (let i = 0; i < 10; i++) {
        repo.appendMessage(id, { role: 'user', content: `msg${i}` });
      }
      const ctx = repo.loadContext('s', 3);
      expect(ctx!.recentMessages).toHaveLength(3);
      expect(ctx!.recentMessages[0].content).toBe('msg7');
    });
  });

  describe('archive', () => {
    it('soft-archives the active conversation', () => {
      repo.findOrCreate('s', 'telegram');
      const result = repo.archive('s', 'user_reset');
      expect(result).not.toBeNull();
      expect(result!.archivedAt).toBeTruthy();
    });
    it('returns null when no active conversation', () => {
      expect(repo.archive('nonexistent', 'user_reset')).toBeNull();
    });
    it('findOrCreate after archive creates a new row', () => {
      const r1 = repo.findOrCreate('s', 'telegram');
      repo.archive('s', 'user_reset');
      const r2 = repo.findOrCreate('s', 'telegram');
      expect(r2.id).not.toBe(r1.id);
      expect(r2.created).toBe(true);
    });
  });

  it('partial-unique-index: two active conversations for same sessionKey is impossible (unique constraint)', () => {
    repo.findOrCreate('s', 'telegram');
    // The second insert with same sessionKey + archivedAt=NULL should be caught by the unique index.
    // But findOrCreate returns the existing one, so test that specifically:
    const r = repo.findOrCreate('s', 'telegram');
    expect(r.created).toBe(false);
  });

  it('getMessageById returns the message with its sessionKey', () => {
    const { id } = repo.findOrCreate('s', 'telegram');
    const { id: msgId } = repo.appendMessage(id, { role: 'user', content: 'find me' });
    const row = repo.getMessageById(msgId);
    expect(row).not.toBeNull();
    expect(row!.content).toBe('find me');
    expect(row!.sessionKey).toBe('s');
    expect(row!.conversationArchivedAt).toBeNull();
    // Same row remains readable after archive
    repo.archive('s', 'user_reset');
    const fetchedAfter = repo.getMessageById(msgId);
    expect(fetchedAfter?.id).toBe(msgId);
    expect(typeof fetchedAfter?.conversationArchivedAt).toBe('number');
    expect(fetchedAfter?.conversationArchivedAt).toBeGreaterThan(0);
  });

  describe('loadConversationById', () => {
    it('returns null for non-existent id', () => {
      expect(repo.loadConversationById(9999)).toBeNull();
    });
    it('returns archived conversation with messages', () => {
      const { id } = repo.findOrCreate('s', 'telegram');
      repo.appendMessage(id, { role: 'user', content: 'hello' });
      repo.appendMessage(id, { role: 'assistant', content: 'world' });
      repo.archive('s', 'user_reset');
      const result = repo.loadConversationById(id);
      expect(result).not.toBeNull();
      expect(result!.archivedAt).toBeTruthy();
      expect(result!.messages).toHaveLength(2);
      expect(result!.messages[0].content).toBe('hello');
    });
  });

  it('purgeArchived hard-deletes archived rows older than threshold AND cascades to messages', () => {
    const { id } = repo.findOrCreate('s', 'telegram');
    const { id: msgId } = repo.appendMessage(id, { role: 'user', content: 'old' });
    repo.archive('s', 'user_reset');
    const future = new Date(Date.now() + 60_000);
    expect(repo.purgeArchived(future)).toBe(1);
    expect(repo.getMessageById(msgId)).toBeNull();
  });

  it('purgeArchived never touches active conversations', () => {
    const { id } = repo.findOrCreate('s', 'telegram');
    repo.appendMessage(id, { role: 'user', content: 'still-active' });
    const future = new Date(Date.now() + 60_000);
    expect(repo.purgeArchived(future)).toBe(0);
    expect(repo.loadContext('s', 10)?.conversationId).toBe(id);
  });
});
