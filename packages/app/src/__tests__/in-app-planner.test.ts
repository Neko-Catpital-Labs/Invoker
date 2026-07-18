import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationRepository, SQLiteAdapter } from '@invoker/data-store';
import { PlanConversation } from '@invoker/surfaces';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const planReply = `Here is the plan:
\`\`\`yaml
name: "In-App Plan"
onFinish: none
baseBranch: main
tasks:
  - id: implement
    description: "Implement the feature"
    prompt: "Make the change"
    dependencies: []
\`\`\`

Reply with yes to execute.`;

describe('in-app planner persistence bridge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores a persisted planner conversation and submits the recovered plan', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const repo = new ConversationRepository(adapter, silentLogger);
      const threadTs = 'in-app-thread-1';

      const firstConversation = new PlanConversation({
        threadTs,
        conversationRepo: repo,
        log: () => {},
      });
      vi.spyOn(PlanConversation.prototype, 'spawnCursor').mockResolvedValueOnce(planReply);

      await expect(firstConversation.sendMessage('Create an implementation plan')).resolves.toBe(planReply);

      const restoredConversation = new PlanConversation({
        threadTs,
        conversationRepo: repo,
        log: () => {},
      });
      await restoredConversation.init();

      vi.spyOn(PlanConversation.prototype, 'spawnCursor').mockRejectedValueOnce(
        new Error('confirmation should use the recovered plan without spawning the planner'),
      );

      await expect(restoredConversation.sendMessage('yes')).resolves.toBe(
        'Plan "In-App Plan" submitted for execution.',
      );

      expect(restoredConversation.planSubmitted).toBe(true);
      expect(restoredConversation.submittedPlanText).toContain('name: In-App Plan');

      const saved = repo.loadConversation(threadTs);
      expect(saved?.planSubmitted).toBe(true);
      expect(saved?.messages.slice(-2)).toEqual([
        { role: 'user', content: 'yes' },
        { role: 'assistant', content: 'Plan "In-App Plan" submitted for execution.' },
      ]);
    } finally {
      adapter.close();
    }
  });
});
