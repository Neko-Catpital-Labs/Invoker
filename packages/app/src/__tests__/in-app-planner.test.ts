import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanConversation } from '../../../surfaces/src/index.js';
import {
  createInAppPlanningChatSessions,
  getPlanningChatSession,
  listPlanningChatSessions,
  restorePlanningChatSessions,
  sendPlanningChatMessage,
  submitPlanningChatDraft,
  summarizePlanText,
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

const VALID_PLAN_TEXT = `name: Mock Plan
onFinish: none
tasks:
  - id: first
    description: First task
    command: echo first
`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('planning chat draft authorization', () => {
  it('keeps unauthorized YAML from becoming draft_ready or submittable', async () => {
    vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue(VALID_PLAN_REPLY);
    const sessions = createInAppPlanningChatSessions();
    const loadGeneratedPlan = vi.fn();

    const result = await sendPlanningChatMessage({
      message: 'What would this involve?',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan,
      sessions,
    });

    expect(result).toMatchObject({
      ok: true,
      reply: VALID_PLAN_REPLY,
      draftPlanAvailable: false,
    });
    if (!result.ok) throw new Error(result.error);
    expect(sessions.get(result.sessionId)?.status).toBe('still_discussing');
    expect(sessions.get(result.sessionId)?.draftPlanText).toBeUndefined();

    const submitted = await submitPlanningChatDraft({ sessionId: result.sessionId }, {
      sessions,
      loadGeneratedPlan,
    });
    expect(submitted).toMatchObject({ ok: false });
    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('accepts YAML when the user explicitly asks to draft the plan', async () => {
    vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue(VALID_PLAN_REPLY);
    const sessions = createInAppPlanningChatSessions();

    const result = await sendPlanningChatMessage({
      message: 'Please draft the full YAML plan',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
    });

    expect(result).toMatchObject({
      ok: true,
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First task', 'Second task'] },
      draftPlanText: expect.stringContaining('name: Mock Plan'),
    });
    if (!result.ok) throw new Error(result.error);
    expect(sessions.get(result.sessionId)?.status).toBe('draft_ready');
  });

  it('accepts "do it" only after the assistant asks whether to draft', async () => {
    vi.spyOn(PlanConversation.prototype, 'sendMessage')
      .mockResolvedValueOnce('I found the key choices. Do you want me to draft the YAML plan?')
      .mockResolvedValueOnce(VALID_PLAN_REPLY);
    const sessions = createInAppPlanningChatSessions();

    const scoped = await sendPlanningChatMessage({
      message: 'Help me scope a cleanup',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
    });
    if (!scoped.ok) throw new Error(scoped.error);

    const confirmed = await sendPlanningChatMessage({
      sessionId: scoped.sessionId,
      message: 'do it',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
    });

    expect(confirmed).toMatchObject({
      ok: true,
      draftPlanAvailable: true,
      draftPlanText: expect.stringContaining('name: Mock Plan'),
    });
    expect(sessions.get(scoped.sessionId)?.status).toBe('draft_ready');
  });

  it('does not treat a standalone short confirmation as draft authorization', async () => {
    vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue(VALID_PLAN_REPLY);
    const sessions = createInAppPlanningChatSessions();

    const result = await sendPlanningChatMessage({
      message: 'do it',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
    });

    expect(result).toMatchObject({ ok: true, draftPlanAvailable: false });
    if (!result.ok) throw new Error(result.error);
    expect(sessions.get(result.sessionId)?.draftPlanText).toBeUndefined();
  });
});

describe('planning chat draft YAML plumbing', () => {
  it('threads draftPlanText through list and get session responses after authorized drafting', async () => {
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

  it('submits using only authorized stored draftPlanText', async () => {
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

  it('does not submit a hidden conversation draft without authorized session draft text', async () => {
    const sessions = createInAppPlanningChatSessions();
    const conversation = new PlanConversation({}) as PlanConversation & { getDraftedPlan: () => string };
    conversation.getDraftedPlan = () => VALID_PLAN_TEXT;
    sessions.set('hidden-yaml', {
      id: 'hidden-yaml',
      title: 'Hidden YAML',
      presetKey: 'codex',
      status: 'still_discussing',
      messages: [],
      conversation,
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:00.000Z',
      nextMessageId: 1,
    });
    const loadGeneratedPlan = vi.fn();

    const result = await submitPlanningChatDraft({ sessionId: 'hidden-yaml' }, {
      sessions,
      loadGeneratedPlan,
    });

    expect(result).toMatchObject({ ok: false });
    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('restores hidden context drafts only for records persisted as draft_ready', async () => {
    const initSpy = vi.spyOn(PlanConversation.prototype, 'init').mockResolvedValue(undefined);
    const originalGetDraftedPlan = (PlanConversation.prototype as unknown as { getDraftedPlan?: () => string | null }).getDraftedPlan;
    const draftSpy = vi.fn(() => VALID_PLAN_TEXT);
    (PlanConversation.prototype as unknown as { getDraftedPlan?: () => string | null }).getDraftedPlan = draftSpy;
    const sessions = createInAppPlanningChatSessions();

    try {
      await restorePlanningChatSessions([
        {
          id: 'discussing',
          title: 'Discussing',
          presetKey: 'codex',
          status: 'still_discussing',
          messages: [],
          pendingResponse: false,
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:00:00.000Z',
        },
        {
          id: 'ready',
          title: 'Ready',
          presetKey: 'codex',
          status: 'draft_ready',
          messages: [],
          pendingResponse: false,
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:00:00.000Z',
        },
      ], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
      });
    } finally {
      if (originalGetDraftedPlan) {
        (PlanConversation.prototype as unknown as { getDraftedPlan?: () => string | null }).getDraftedPlan = originalGetDraftedPlan;
      } else {
        delete (PlanConversation.prototype as unknown as { getDraftedPlan?: () => string | null }).getDraftedPlan;
      }
    }

    expect(sessions.get('discussing')?.draftPlanText).toBeUndefined();
    expect(sessions.get('ready')?.draftPlanText).toContain('name: Mock Plan');
    expect(initSpy).toHaveBeenCalled();
    expect(draftSpy).toHaveBeenCalledTimes(1);
  });

  it('summarizes multi-workflow drafts with task groups', () => {
    expect(summarizePlanText(`
name: Grouped plan
workflows:
  - id: backend
    name: Backend workflow
    tasks:
      - id: api
        description: Add API endpoint
  - id: frontend
    name: Frontend workflow
    tasks:
      - id: sidebar
        description: Add review sidebar
      - id: actions
        description: Wire ready bar actions
`)).toMatchObject({
      name: 'Grouped plan',
      taskCount: 3,
      workflowCount: 2,
      steps: ['Backend workflow', 'Frontend workflow'],
      taskGroups: [
        { name: 'Backend workflow', workflowId: 'backend', taskCount: 1, steps: ['Add API endpoint'] },
        { name: 'Frontend workflow', workflowId: 'frontend', taskCount: 2, steps: ['Add review sidebar', 'Wire ready bar actions'] },
      ],
    });
  });
});
