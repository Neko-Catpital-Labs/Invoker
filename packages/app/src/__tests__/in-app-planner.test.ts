import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationRepository, SQLiteAdapter } from '@invoker/data-store';
import { PlanConversation } from '@invoker/surfaces';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const VALID_PLAN_RESPONSE = `Here is the plan:

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
    const repo = new ConversationRepository(adapter, silentLogger);
    const spawnCursor = vi
      .spyOn(PlanConversation.prototype, 'spawnCursor')
      .mockResolvedValueOnce(VALID_PLAN_RESPONSE);

    try {
      const firstSession = new PlanConversation({
        threadTs: 'in-app-thread-1',
        conversationRepo: repo,
        log: () => {},
      });
      await firstSession.sendMessage('Create a plan for this app');

      const restoredSession = new PlanConversation({
        threadTs: 'in-app-thread-1',
        conversationRepo: repo,
        log: () => {},
      });
      await restoredSession.init();

      const reply = await restoredSession.sendMessage('execute');

      expect(spawnCursor).toHaveBeenCalledTimes(1);
      expect(reply).toContain('In-App Plan');
      expect(restoredSession.planSubmitted).toBe(true);
      expect(restoredSession.submittedPlanText).toContain('name: In-App Plan');

      const saved = repo.loadConversation('in-app-thread-1');
      expect(saved?.planSubmitted).toBe(true);
      expect(saved?.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
    } finally {
      adapter.close();
    }
  });
});
