import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRepository } from '@invoker/data-store';
import { PlanConversation } from '@invoker/surfaces';

describe('planning chat send main-process cost guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not re-load persisted conversation history after the first send initializes state', async () => {
    const repo = {
      loadConversation: vi.fn(() => ({
        threadTs: 'thread-hot-path',
        channelId: '',
        userId: '',
        messages: [
          { role: 'user', content: 'Initial request' },
          { role: 'assistant', content: 'Initial response' },
        ],
        extractedPlan: null,
        planSubmitted: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })),
      saveConversation: vi.fn(),
      deleteConversation: vi.fn(),
    } as unknown as ConversationRepository;

    vi.spyOn(PlanConversation.prototype, 'spawnCursor')
      .mockResolvedValueOnce('First reply')
      .mockResolvedValueOnce('Second reply');

    const conversation = new PlanConversation({
      threadTs: 'thread-hot-path',
      conversationRepo: repo,
      log: () => {},
    });

    await conversation.sendMessage('First follow-up');
    await conversation.sendMessage('Second follow-up');

    expect(repo.loadConversation).toHaveBeenCalledTimes(1);
    expect(repo.saveConversation).toHaveBeenCalledTimes(2);
    expect(repo.saveConversation).toHaveBeenNthCalledWith(
      1,
      'thread-hot-path',
      expect.arrayContaining([
        { role: 'user', content: 'Initial request' },
        { role: 'assistant', content: 'Initial response' },
        { role: 'user', content: 'First follow-up' },
        { role: 'assistant', content: 'First reply' },
      ]),
      null,
      false,
    );
    expect(repo.saveConversation).toHaveBeenNthCalledWith(
      2,
      'thread-hot-path',
      expect.arrayContaining([
        { role: 'user', content: 'Second follow-up' },
        { role: 'assistant', content: 'Second reply' },
      ]),
      null,
      false,
    );
  });
});
