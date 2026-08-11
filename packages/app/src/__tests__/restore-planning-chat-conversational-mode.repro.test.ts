import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanConversation } from '../../../surfaces/src/index.ts';
import type { InAppPlanningSessionRecord } from '@invoker/data-store';
import {
  createInAppPlanningChatSessions,
  planFromGoal,
  restorePlanningChatSessions,
  sendPlanningChatMessage,
} from '../in-app-planner.js';

const VALID_PLAN = `Here is the plan.

\`\`\`yaml
name: Mock Plan
onFinish: none
tasks:
  - id: first
    description: First task
    command: echo first
\`\`\``;

const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

afterEach(() => {
  vi.restoreAllMocks();
  planningCommandBuilder.mockClear();
});

describe('restored in-app planning chat conversational mode', () => {
  it('keeps planFromGoal in conversational planning mode instead of the Slack agent prompt', async () => {
    let prompt = '';
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockImplementationOnce((nextPrompt: string) => {
      prompt = nextPrompt;
      return Promise.resolve(VALID_PLAN);
    });

    const result = await planFromGoal({ goal: 'build a REST API' }, {
      config: {},
      loadGeneratedPlan: vi.fn().mockResolvedValue({ planName: 'Mock Plan', workflowId: 'wf-1' }),
      planningCommandBuilder,
    });

    expect(result.ok).toBe(true);
    expect(prompt).toContain('conversational planning mode');
    expect(prompt).toContain('Drafting is not authorized yet.');
    expect(prompt).not.toContain('You are a normal coding agent running in a git worktree for a Slack thread.');
    expect(prompt).not.toContain('type `/plan <request>`');
  });

  it('keeps restored planning chats in conversational planning mode instead of the direct YAML prompt', async () => {
    const sessions = createInAppPlanningChatSessions();
    const record: InAppPlanningSessionRecord = {
      id: 'restored-planning-chat',
      title: 'Restored planning chat',
      presetKey: 'codex',
      status: 'still_discussing',
      messages: [
        { id: 1, role: 'user', text: 'scope a REST API', createdAt: '2026-07-07T00:00:00.000Z' },
        { id: 2, role: 'assistant', text: 'Which endpoints matter?', createdAt: '2026-07-07T00:00:01.000Z' },
      ],
      pendingResponse: false,
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:01.000Z',
    };

    await restorePlanningChatSessions([record], {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    let prompt = '';
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockImplementationOnce((nextPrompt: string) => {
      prompt = nextPrompt;
      return Promise.resolve('Let us scope the endpoints first.');
    });

    const result = await sendPlanningChatMessage({ sessionId: 'restored-planning-chat', message: 'Users and health checks.' }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(result.ok).toBe(true);
    expect(prompt).toContain('conversational planning mode');
    expect(prompt).toContain('hosting surface reads that exact YAML');
    expect(prompt).toContain('Slack orchestrator or the in-app planner');
    expect(prompt).not.toContain('Generate a YAML task plan');
    expect(prompt).not.toContain('Slack orchestrator reads that exact YAML');
  });
});
