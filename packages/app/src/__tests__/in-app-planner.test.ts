import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanConversation } from '../../../surfaces/src/index.js';
import {
  createInAppPlanningChatSessions,
  getPlanningChatSession,
  listPlanningChatSessions,
  sendPlanningChatMessage,
  submitPlanningChatDraft,
} from '../in-app-planner.js';

const VALID_PLAN_REPLY = `Here is the plan.

\`\`\`yaml
name: Mock Plan
onFinish: none
tasks:
  - id: first
    description: First task
    command: echo first
  - id: second
    description: Second task
    dependencies: [first]
    command: echo second
\`\`\``;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('planning chat draft YAML plumbing', () => {
  it('returns draftPlanText from send responses and stores it on the session', async () => {
    vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue(VALID_PLAN_REPLY);
    const sessions = createInAppPlanningChatSessions();

    const result = await sendPlanningChatMessage({
      message: 'draft the full plan',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
    });

    expect(result).toMatchObject({
      ok: true,
      reply: VALID_PLAN_REPLY,
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First task', 'Second task'] },
      draftPlanText: expect.stringContaining('name: Mock Plan'),
    });
    if (!result.ok) throw new Error(result.error);
    expect(sessions.get(result.sessionId)?.draftPlanText).toContain('name: Mock Plan');
  });

  it('threads draftPlanText through list and get session responses', async () => {
    vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue(VALID_PLAN_REPLY);
    const sessions = createInAppPlanningChatSessions();
    const sent = await sendPlanningChatMessage({
      message: 'draft',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
    });
    if (!sent.ok) throw new Error(sent.error);

    const listed = listPlanningChatSessions({ sessions });
    const fetched = getPlanningChatSession({ sessionId: sent.sessionId }, { sessions });

    expect(listed.sessions[0]).toMatchObject({
      id: sent.sessionId,
      draftPlanAvailable: true,
      draftPlanText: expect.stringContaining('name: Mock Plan'),
    });
    expect(fetched).toMatchObject({
      ok: true,
      session: {
        id: sent.sessionId,
        draftPlanAvailable: true,
        draftPlanText: expect.stringContaining('name: Mock Plan'),
      },
    });
  });

  it('keeps summary-only legacy sessions draft-available without inventing YAML text', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('legacy-summary-only', {
      id: 'legacy-summary-only',
      title: 'Legacy plan',
      presetKey: 'codex',
      status: 'draft_ready',
      messages: [],
      conversation: new PlanConversation({}),
      draftPlanSummary: { name: 'Legacy plan', taskCount: 1, steps: ['Legacy task'] },
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:01.000Z',
      nextMessageId: 1,
    });

    const listedSession = listPlanningChatSessions({ sessions }).sessions[0];
    const fetched = getPlanningChatSession({ sessionId: 'legacy-summary-only' }, { sessions });

    expect(listedSession).toMatchObject({
      id: 'legacy-summary-only',
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Legacy plan', taskCount: 1, steps: ['Legacy task'] },
    });
    expect('draftPlanText' in listedSession).toBe(false);
    expect(fetched.ok && 'draftPlanText' in fetched.session).toBe(false);
  });

  it('submits using stored draftPlanText instead of parsing visible chat text', async () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('stored-yaml', {
      id: 'stored-yaml',
      title: 'Stored YAML',
      presetKey: 'codex',
      status: 'draft_ready',
      messages: [{ id: 1, role: 'assistant', text: 'Draft ready.', createdAt: '2026-07-07T00:00:00.000Z' }],
      conversation: new PlanConversation({}),
      draftPlanSummary: { name: 'Stored YAML', taskCount: 1, steps: ['Use stored text'] },
      draftPlanText: 'name: Stored YAML\ntasks:\n  - id: stored\n    description: Use stored text\n',
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:00.000Z',
      nextMessageId: 2,
    });
    const loadGeneratedPlan = vi.fn().mockResolvedValue({ planName: 'Stored YAML', workflowId: 'wf-1' });

    await expect(submitPlanningChatDraft({ sessionId: 'stored-yaml' }, {
      sessions,
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: true, planName: 'Stored YAML', workflowId: 'wf-1' });
    expect(loadGeneratedPlan).toHaveBeenCalledWith(expect.stringContaining('name: Stored YAML'));
  });
});
