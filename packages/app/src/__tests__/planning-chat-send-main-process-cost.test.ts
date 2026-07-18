import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationRepository, SQLiteAdapter } from '@invoker/data-store';
import type { ConversationMessageEntry } from '@invoker/data-store';
import { PlanConversation } from '@invoker/surfaces';

describe('planning chat send main-process cost guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists one additional planner turn with delta message writes after restore', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const repo = new ConversationRepository(adapter, {
        info: () => {},
        warn: () => {},
        error: () => {},
      });
      const threadTs = 'planning-chat-hot-path';
      const largeHistory: ConversationMessageEntry[] = Array.from({ length: 1_000 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index}`,
      }));
      repo.saveConversation(threadTs, largeHistory);

      const conversation = new PlanConversation({
        threadTs,
        conversationRepo: repo,
        log: () => {},
      });
      await conversation.init();

      const loadMessages = vi.spyOn(adapter, 'loadMessages').mockImplementation(() => {
        throw new Error('planning chat send should not reload the full persisted transcript');
      });
      const appendMessage = vi.spyOn(adapter, 'appendMessage');
      const countMessages = vi.spyOn(adapter, 'countMessages');
      vi.spyOn(PlanConversation.prototype, 'spawnCursor').mockResolvedValue('Planner delta reply');

      await expect(conversation.sendMessage('one additional planner turn')).resolves.toBe('Planner delta reply');

      expect(loadMessages).not.toHaveBeenCalled();
      expect(countMessages).toHaveBeenCalledWith(threadTs);
      expect(appendMessage).toHaveBeenCalledTimes(2);
      expect(adapter.countMessages(threadTs)).toBe(1_002);

      loadMessages.mockRestore();
      const loaded = repo.loadConversation(threadTs);
      expect(loaded!.messages.slice(-2)).toEqual([
        { role: 'user', content: 'one additional planner turn' },
        { role: 'assistant', content: 'Planner delta reply' },
      ]);
    } finally {
      adapter.close();
    }
  });
});
