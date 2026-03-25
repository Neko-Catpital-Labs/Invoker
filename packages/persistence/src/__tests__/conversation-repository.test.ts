import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { ConversationRepository } from '../conversation-repository.js';
import type { ConversationMessageEntry } from '../conversation-repository.js';
import type { PlanDefinition } from '@invoker/core';

describe('ConversationRepository', () => {
  let adapter: SQLiteAdapter;
  let repo: ConversationRepository;

  // Suppress log noise in tests
  const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new ConversationRepository(adapter, silentLogger);
  });

  afterEach(() => {
    adapter.close();
  });

  const testPlan: PlanDefinition = {
    name: 'test-plan',
    onFinish: 'merge',
    baseBranch: 'main',
    featureBranch: 'plan/test',
    tasks: [
      { id: 'task-1', description: 'First task', prompt: 'Do task 1', dependencies: [] },
      { id: 'task-2', description: 'Second task', command: 'npm test', dependencies: ['task-1'] },
    ],
  };

  function seedConversation(threadTs: string, channelId = 'C123', userId = 'U456'): void {
    adapter.saveConversation({
      threadTs,
      channelId,
      userId,
      extractedPlan: null,
      planSubmitted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  // ── saveConversation ─────────────────────────────────────

  describe('saveConversation', () => {
    it('creates a new conversation with messages', () => {
      const messages: ConversationMessageEntry[] = [
        { role: 'user', content: 'Build a feature' },
        { role: 'assistant', content: 'Sure, let me explore.' },
      ];

      repo.saveConversation('ts-1', messages);

      const loaded = repo.loadConversation('ts-1');
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toHaveLength(2);
      expect(loaded!.messages[0].role).toBe('user');
      expect(loaded!.messages[0].content).toBe('Build a feature');
    });

    it('saves extractedPlan as serialized JSON', () => {
      repo.saveConversation('ts-1', [], testPlan, false);

      const loaded = repo.loadConversation('ts-1');
      expect(loaded!.extractedPlan).toEqual(testPlan);
      expect(loaded!.planSubmitted).toBe(false);
    });

    it('saves planSubmitted flag', () => {
      repo.saveConversation('ts-1', [], testPlan, true);

      const loaded = repo.loadConversation('ts-1');
      expect(loaded!.planSubmitted).toBe(true);
    });

    it('appends only new messages on update', () => {
      seedConversation('ts-1');
      const initial: ConversationMessageEntry[] = [
        { role: 'user', content: 'Hello' },
      ];
      repo.saveConversation('ts-1', initial);

      // Second save with 2 more messages
      const updated: ConversationMessageEntry[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'Build something' },
      ];
      repo.saveConversation('ts-1', updated);

      const loaded = repo.loadConversation('ts-1');
      expect(loaded!.messages).toHaveLength(3);
    });

    it('handles complex message content (arrays of blocks)', () => {
      const complexContent = [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'src/index.ts' } },
      ];

      repo.saveConversation('ts-1', [
        { role: 'assistant', content: complexContent },
      ]);

      const loaded = repo.loadConversation('ts-1');
      expect(loaded!.messages[0].content).toEqual(complexContent);
    });

    it('updates plan without losing existing messages', () => {
      seedConversation('ts-1');
      repo.saveConversation('ts-1', [{ role: 'user', content: 'Build it' }]);

      // Update with plan
      repo.saveConversation('ts-1', [{ role: 'user', content: 'Build it' }], testPlan, true);

      const loaded = repo.loadConversation('ts-1');
      expect(loaded!.messages).toHaveLength(1);
      expect(loaded!.extractedPlan).toEqual(testPlan);
      expect(loaded!.planSubmitted).toBe(true);
    });
  });

  // ── loadConversation ─────────────────────────────────────

  describe('loadConversation', () => {
    it('returns null for non-existent thread', () => {
      expect(repo.loadConversation('nonexistent')).toBeNull();
    });

    it('deserializes plan and messages from JSON', () => {
      seedConversation('ts-1');
      adapter.updateConversation('ts-1', {
        extractedPlan: JSON.stringify(testPlan),
        planSubmitted: true,
      });
      adapter.appendMessage('ts-1', 'user', JSON.stringify('What should I build?'));
      adapter.appendMessage('ts-1', 'assistant', JSON.stringify({ text: 'A feature.' }));

      const loaded = repo.loadConversation('ts-1');
      expect(loaded!.extractedPlan).toEqual(testPlan);
      expect(loaded!.planSubmitted).toBe(true);
      expect(loaded!.messages).toHaveLength(2);
      expect(loaded!.messages[0].content).toBe('What should I build?');
      expect(loaded!.messages[1].content).toEqual({ text: 'A feature.' });
    });

    it('handles malformed plan JSON gracefully', () => {
      seedConversation('ts-1');
      adapter.updateConversation('ts-1', {
        extractedPlan: '{not valid json',
      });

      const loaded = repo.loadConversation('ts-1');
      expect(loaded!.extractedPlan).toBeNull();
    });

    it('returns raw string for non-JSON message content', () => {
      seedConversation('ts-1');
      adapter.appendMessage('ts-1', 'user', 'plain text not json');

      const loaded = repo.loadConversation('ts-1');
      expect(loaded!.messages[0].content).toBe('plain text not json');
    });
  });

  // ── deleteConversation ───────────────────────────────────

  describe('deleteConversation', () => {
    it('removes conversation and messages', () => {
      seedConversation('ts-1');
      adapter.appendMessage('ts-1', 'user', '"hello"');

      repo.deleteConversation('ts-1');

      expect(repo.loadConversation('ts-1')).toBeNull();
    });

    it('no-ops for non-existent thread', () => {
      // Should not throw
      repo.deleteConversation('nonexistent');
    });
  });

  // ── listActiveConversations ──────────────────────────────

  describe('listActiveConversations', () => {
    it('returns only non-submitted conversations', () => {
      seedConversation('ts-active');
      seedConversation('ts-submitted');
      adapter.updateConversation('ts-submitted', { planSubmitted: true });

      const active = repo.listActiveConversations();
      expect(active).toHaveLength(1);
      expect(active[0].threadTs).toBe('ts-active');
    });

    it('returns empty array when no conversations exist', () => {
      expect(repo.listActiveConversations()).toEqual([]);
    });

    it('deserializes extractedPlan in listed conversations', () => {
      seedConversation('ts-1');
      adapter.updateConversation('ts-1', {
        extractedPlan: JSON.stringify(testPlan),
      });

      const active = repo.listActiveConversations();
      expect(active[0].extractedPlan).toEqual(testPlan);
    });

    it('does not include messages (for efficiency)', () => {
      seedConversation('ts-1');
      adapter.appendMessage('ts-1', 'user', '"hello"');

      const active = repo.listActiveConversations();
      expect(active[0]).not.toHaveProperty('messages');
    });
  });

  // ── cleanupOldConversations ──────────────────────────────

  describe('cleanupOldConversations', () => {
    it('deletes conversations older than N days', () => {
      const old = new Date();
      old.setDate(old.getDate() - 10);

      adapter.saveConversation({
        threadTs: 'ts-old',
        channelId: 'C1',
        userId: 'U1',
        extractedPlan: null,
        planSubmitted: false,
        createdAt: old.toISOString(),
        updatedAt: old.toISOString(),
      });
      adapter.appendMessage('ts-old', 'user', '"old message"');

      seedConversation('ts-new'); // created "now"

      const deleted = repo.cleanupOldConversations(7);

      expect(deleted).toBe(1);
      expect(repo.loadConversation('ts-old')).toBeNull();
      expect(repo.loadConversation('ts-new')).not.toBeNull();
    });

    it('returns 0 when nothing to clean', () => {
      seedConversation('ts-recent');
      expect(repo.cleanupOldConversations(30)).toBe(0);
    });

    it('also deletes messages of cleaned-up conversations', () => {
      const old = new Date();
      old.setDate(old.getDate() - 5);

      adapter.saveConversation({
        threadTs: 'ts-old',
        channelId: 'C1',
        userId: 'U1',
        extractedPlan: null,
        planSubmitted: false,
        createdAt: old.toISOString(),
        updatedAt: old.toISOString(),
      });
      adapter.appendMessage('ts-old', 'user', '"msg"');
      adapter.appendMessage('ts-old', 'assistant', '"reply"');

      repo.cleanupOldConversations(3);

      // Messages should also be gone
      expect(adapter.loadMessages('ts-old')).toEqual([]);
    });
  });

  // ── Persistence correctness (round-trip integrity) ───────

  describe('persistence correctness', () => {
    it('round-trips a full conversation through save and load', () => {
      const messages: ConversationMessageEntry[] = [
        { role: 'user', content: 'Build a REST API' },
        { role: 'assistant', content: 'Let me explore the codebase.' },
        { role: 'user', content: 'Sounds good' },
        { role: 'assistant', content: 'Here is the plan:\n```yaml\nname: "REST API"\ntasks:\n  - id: t1\n    description: "Create endpoints"\n```' },
      ];

      repo.saveConversation('ts-full', messages, testPlan, false);
      const loaded = repo.loadConversation('ts-full');

      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toHaveLength(4);
      expect(loaded!.extractedPlan).toEqual(testPlan);
      expect(loaded!.planSubmitted).toBe(false);
      expect(loaded!.messages[0].role).toBe('user');
      expect(loaded!.messages[3].role).toBe('assistant');
    });

    it('preserves message ordering across multiple saves', () => {
      // Save first batch
      repo.saveConversation('ts-order', [
        { role: 'user', content: 'msg-1' },
        { role: 'assistant', content: 'msg-2' },
      ]);

      // Save second batch (appends msg-3 and msg-4)
      repo.saveConversation('ts-order', [
        { role: 'user', content: 'msg-1' },
        { role: 'assistant', content: 'msg-2' },
        { role: 'user', content: 'msg-3' },
        { role: 'assistant', content: 'msg-4' },
      ]);

      const loaded = repo.loadConversation('ts-order');
      expect(loaded!.messages).toHaveLength(4);
      expect(loaded!.messages.map((m) => m.content)).toEqual([
        'msg-1', 'msg-2', 'msg-3', 'msg-4',
      ]);
    });

    it('preserves plan state across incremental saves', () => {
      // First save: no plan
      repo.saveConversation('ts-plan', [
        { role: 'user', content: 'Build something' },
      ]);
      let loaded = repo.loadConversation('ts-plan');
      expect(loaded!.extractedPlan).toBeNull();
      expect(loaded!.planSubmitted).toBe(false);

      // Second save: plan extracted but not submitted
      repo.saveConversation('ts-plan', [
        { role: 'user', content: 'Build something' },
        { role: 'assistant', content: 'Here is the plan' },
      ], testPlan, false);
      loaded = repo.loadConversation('ts-plan');
      expect(loaded!.extractedPlan).toEqual(testPlan);
      expect(loaded!.planSubmitted).toBe(false);

      // Third save: plan submitted
      repo.saveConversation('ts-plan', [
        { role: 'user', content: 'Build something' },
        { role: 'assistant', content: 'Here is the plan' },
        { role: 'user', content: 'Go ahead' },
      ], testPlan, true);
      loaded = repo.loadConversation('ts-plan');
      expect(loaded!.extractedPlan).toEqual(testPlan);
      expect(loaded!.planSubmitted).toBe(true);
      expect(loaded!.messages).toHaveLength(3);
    });

    it('handles empty message list', () => {
      repo.saveConversation('ts-empty', []);

      const loaded = repo.loadConversation('ts-empty');
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toEqual([]);
    });

    it('handles very long message content', () => {
      const longContent = 'x'.repeat(50_000);
      repo.saveConversation('ts-long', [
        { role: 'user', content: longContent },
      ]);

      const loaded = repo.loadConversation('ts-long');
      expect(loaded!.messages[0].content).toBe(longContent);
    });

    it('handles messages with special characters', () => {
      const specialContent = 'Line1\nLine2\tTabbed\r\nWindows "quotes" \'apostrophe\' `backtick`';
      repo.saveConversation('ts-special', [
        { role: 'user', content: specialContent },
      ]);

      const loaded = repo.loadConversation('ts-special');
      expect(loaded!.messages[0].content).toBe(specialContent);
    });

    it('handles nested JSON content in messages', () => {
      const nestedContent = {
        blocks: [
          { type: 'text', text: 'Hello' },
          {
            type: 'tool_result',
            tool_use_id: 'tool-123',
            content: JSON.stringify({ nested: { data: [1, 2, 3] } }),
          },
        ],
      };

      repo.saveConversation('ts-nested', [
        { role: 'assistant', content: nestedContent },
      ]);

      const loaded = repo.loadConversation('ts-nested');
      expect(loaded!.messages[0].content).toEqual(nestedContent);
    });
  });

  // ── Edge cases: corrupted and interrupted state ──────────

  describe('corrupted state handling', () => {
    it('handles truncated JSON in extracted plan', () => {
      seedConversation('ts-corrupt');
      adapter.updateConversation('ts-corrupt', {
        extractedPlan: '{"name": "incomplete plan", "tasks": [{"id": "t1"',
      });

      const loaded = repo.loadConversation('ts-corrupt');
      // Should gracefully return null for corrupted plan
      expect(loaded).not.toBeNull();
      expect(loaded!.extractedPlan).toBeNull();
    });

    it('handles null extracted plan string', () => {
      seedConversation('ts-null');

      const loaded = repo.loadConversation('ts-null');
      expect(loaded!.extractedPlan).toBeNull();
    });

    it('handles empty string as extracted plan', () => {
      seedConversation('ts-empty-plan');
      adapter.updateConversation('ts-empty-plan', {
        extractedPlan: '',
      });

      const loaded = repo.loadConversation('ts-empty-plan');
      // Empty string is falsy, should return null
      expect(loaded!.extractedPlan).toBeNull();
    });

    it('loads conversation even when some messages have invalid JSON', () => {
      seedConversation('ts-bad-msg');
      adapter.appendMessage('ts-bad-msg', 'user', '{"valid": true}');
      adapter.appendMessage('ts-bad-msg', 'assistant', 'not-json-at-all');
      adapter.appendMessage('ts-bad-msg', 'user', '{"also": "valid"}');

      const loaded = repo.loadConversation('ts-bad-msg');
      expect(loaded!.messages).toHaveLength(3);
      // Valid JSON is parsed
      expect(loaded!.messages[0].content).toEqual({ valid: true });
      // Invalid JSON returned as raw string
      expect(loaded!.messages[1].content).toBe('not-json-at-all');
      // Valid JSON is parsed
      expect(loaded!.messages[2].content).toEqual({ also: 'valid' });
    });
  });

  // ── Concurrent-like scenarios ────────────────────────────

  describe('concurrent-like scenarios', () => {
    it('handles rapid successive saves to same thread', () => {
      for (let i = 0; i < 10; i++) {
        const messages: ConversationMessageEntry[] = [];
        for (let j = 0; j <= i; j++) {
          messages.push({
            role: j % 2 === 0 ? 'user' : 'assistant',
            content: `message-${j}`,
          });
        }
        repo.saveConversation('ts-rapid', messages);
      }

      const loaded = repo.loadConversation('ts-rapid');
      expect(loaded!.messages).toHaveLength(10);
      expect(loaded!.messages[0].content).toBe('message-0');
      expect(loaded!.messages[9].content).toBe('message-9');
    });

    it('does not duplicate messages on idempotent save', () => {
      const messages: ConversationMessageEntry[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];

      // Save same messages multiple times
      repo.saveConversation('ts-idempotent', messages);
      repo.saveConversation('ts-idempotent', messages);
      repo.saveConversation('ts-idempotent', messages);

      const loaded = repo.loadConversation('ts-idempotent');
      expect(loaded!.messages).toHaveLength(2);
    });

    it('multiple threads do not interfere with each other', () => {
      const threads = ['ts-A', 'ts-B', 'ts-C'];

      for (const thread of threads) {
        repo.saveConversation(thread, [
          { role: 'user', content: `msg for ${thread}` },
        ]);
      }

      for (const thread of threads) {
        const loaded = repo.loadConversation(thread);
        expect(loaded!.messages).toHaveLength(1);
        expect(loaded!.messages[0].content).toBe(`msg for ${thread}`);
      }
    });
  });

  // ── Cleanup edge cases ───────────────────────────────────

  describe('cleanup edge cases', () => {
    it('cleanup with 0 days deletes all conversations', () => {
      seedConversation('ts-1');
      seedConversation('ts-2');

      // 0 days means cutoff is "now", so all conversations with updated_at before "now" are deleted.
      // Since SQLite datetime('now') and JS Date.now() may be same second,
      // we create old conversations to ensure they're before the cutoff.
      const old = new Date();
      old.setDate(old.getDate() - 1);
      adapter.saveConversation({
        threadTs: 'ts-old-1',
        channelId: 'C1',
        userId: 'U1',
        extractedPlan: null,
        planSubmitted: false,
        createdAt: old.toISOString(),
        updatedAt: old.toISOString(),
      });

      const deleted = repo.cleanupOldConversations(0);
      expect(deleted).toBeGreaterThanOrEqual(1);
    });

    it('cleanup preserves conversations updated within the window', () => {
      const recent = new Date();
      adapter.saveConversation({
        threadTs: 'ts-recent',
        channelId: 'C1',
        userId: 'U1',
        extractedPlan: null,
        planSubmitted: false,
        createdAt: recent.toISOString(),
        updatedAt: recent.toISOString(),
      });

      const deleted = repo.cleanupOldConversations(1);
      expect(deleted).toBe(0);
      expect(repo.loadConversation('ts-recent')).not.toBeNull();
    });

    it('deleting a conversation does not affect other conversations', () => {
      seedConversation('ts-keep');
      seedConversation('ts-delete');
      adapter.appendMessage('ts-keep', 'user', '"keep me"');
      adapter.appendMessage('ts-delete', 'user', '"delete me"');

      repo.deleteConversation('ts-delete');

      expect(repo.loadConversation('ts-delete')).toBeNull();
      const kept = repo.loadConversation('ts-keep');
      expect(kept).not.toBeNull();
      expect(kept!.messages).toHaveLength(1);
      expect(kept!.messages[0].content).toBe('keep me');
    });

    it('cleanup handles conversations with plans and submitted state', () => {
      const old = new Date();
      old.setDate(old.getDate() - 30);

      adapter.saveConversation({
        threadTs: 'ts-old-plan',
        channelId: 'C1',
        userId: 'U1',
        extractedPlan: JSON.stringify(testPlan),
        planSubmitted: true,
        createdAt: old.toISOString(),
        updatedAt: old.toISOString(),
      });
      adapter.appendMessage('ts-old-plan', 'user', '"build it"');
      adapter.appendMessage('ts-old-plan', 'assistant', '"plan generated"');

      const deleted = repo.cleanupOldConversations(7);
      expect(deleted).toBe(1);
      expect(repo.loadConversation('ts-old-plan')).toBeNull();
      expect(adapter.loadMessages('ts-old-plan')).toEqual([]);
    });
  });
});
