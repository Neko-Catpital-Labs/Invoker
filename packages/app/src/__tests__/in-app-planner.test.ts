import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanConversation } from '../../../surfaces/src/index.ts';
import {
  createInAppPlanningChatSessions,
  createPlanningChatSession,
  createPlanningCommandBuilderFromRegistry,
  listInAppPlanningPresets,
  listPlanningChatSessions,
  planFromGoal,
  resetPlanningChat,
  restorePlanningChatSessions,
  sendPlanningChatMessage,
  setPlanningChatTerminalMode,
  submitPlanningChatDraft,
  updatePlanningChatTerminalState,
  type LoadedGeneratedPlan,
} from '../in-app-planner.js';
import { ConversationRepository, SQLiteAdapter, type InAppPlanningSessionRecord } from '@invoker/data-store';

const PLAN_SUBMIT_HINT = '\n\nReply `submit` to submit it.';

const VALID_PLAN = `Here is the plan.

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

const VALID_PLAN_REPLY = `${VALID_PLAN}${PLAN_SUBMIT_HINT}`;

const VALID_PLAN_TEXT = `name: Mock Plan
onFinish: none
tasks:
  - id: first
    description: First task
    command: echo first
  - id: second
    description: Second task
    dependencies: [first]
    command: echo second`;

const VALID_PLAN_WITHOUT_CLOSING_FENCE = `Here is the plan.

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
    command: echo second`;

const WORKERS_SURFACE_STACKED_PLAN = `Here is the plan.

\`\`\`yaml
name: Workers Surface
repoUrl: git@github.com:test/repo.git
workflows:
  - name: Workers Surface Contracts
    tasks:
      - id: define-worker-contracts
        description: Define worker contracts
        prompt: Update shared contracts for workers
        dependencies: []
      - id: verify-worker-contracts
        description: Verify worker contracts
        command: pnpm test packages/contracts
        dependencies: [define-worker-contracts]
  - name: Workers Surface UI
    tasks:
      - id: build-workers-ui
        description: Build workers UI
        prompt: Implement the workers surface
        dependencies: []
        command: pnpm test packages/ui
\`\`\``;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('planFromGoal', () => {
  it('asks for a goal before planning', async () => {
    const loadGeneratedPlan = vi.fn();

    await expect(planFromGoal({ goal: '   ' }, {
      config: {},
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: false, error: 'Describe a goal first.' });

    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('rejects unknown planner presets before planning', async () => {
    const loadGeneratedPlan = vi.fn();

    await expect(planFromGoal({ goal: 'Add README', presetKey: 'bad' }, {
      config: {},
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: false, error: 'Unknown planner preset "bad".' });

    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('loads generated YAML as a preview without starting execution', async () => {
    const sendMessage = vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue(VALID_PLAN);
    const loadGeneratedPlan = vi.fn().mockResolvedValue({ planName: 'Mock Plan', workflowId: 'wf-1' });

    await expect(planFromGoal({ goal: '  Add README  ' }, {
      config: {},
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: true, planName: 'Mock Plan', workflowId: 'wf-1' });

    expect(sendMessage).toHaveBeenCalledWith('Add README');
    expect(loadGeneratedPlan).toHaveBeenCalledTimes(1);
    expect(loadGeneratedPlan.mock.calls[0]?.[0]).toContain('name: Mock Plan');
  });

  it('returns workflow ids and counts for stacked planner drafts', async () => {
    const sendMessage = vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue(WORKERS_SURFACE_STACKED_PLAN);
    const loadGeneratedPlan = vi.fn().mockResolvedValue({
      planName: 'Workers Surface',
      workflowId: 'wf-2',
      workflowIds: ['wf-1', 'wf-2'],
      workflowCount: 2,
    });

    await expect(planFromGoal({ goal: 'Build Workers Surface' }, {
      config: {},
      loadGeneratedPlan,
    })).resolves.toEqual({
      ok: true,
      planName: 'Workers Surface',
      workflowId: 'wf-2',
      workflowIds: ['wf-1', 'wf-2'],
      workflowCount: 2,
    });

    expect(sendMessage).toHaveBeenCalledWith('Build Workers Surface');
    expect(loadGeneratedPlan).toHaveBeenCalledWith(expect.stringContaining('workflows:'));
  });

  it('does not load invalid planner output', async () => {
    vi.spyOn(PlanConversation.prototype, 'sendMessage').mockResolvedValue('No YAML here.');
    const loadGeneratedPlan = vi.fn();

    await expect(planFromGoal({ goal: 'Add README' }, {
      config: {},
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: false, error: 'Planner did not return a valid YAML plan.' });

    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });
});
describe('listInAppPlanningPresets', () => {
  it('returns deterministic labels and the configured default', async () => {
    await expect(listInAppPlanningPresets({
      defaultSlackHarnessPreset: 'omp+claude',
      slackHarnessPresets: {
        custom: { tool: 'codex' },
        'custom+omp': { tool: 'omp', model: 'fast' },
      },
    })).resolves.toEqual(expect.arrayContaining([
      { key: 'codex', label: 'Codex', tool: 'codex', model: undefined, isDefault: false },
      { key: 'omp', label: 'OMP', tool: 'omp', model: undefined, isDefault: false },
      { key: 'omp+claude', label: 'Claude via OMP', tool: 'omp', model: 'claude', isDefault: true },
      { key: 'custom', label: 'custom', tool: 'codex', model: undefined, isDefault: false },
      { key: 'custom+omp', label: 'custom + omp', tool: 'omp', model: 'fast', isDefault: false },
    ]));
  });
});


describe('planning chat', () => {
  const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

  it('rejects blank messages without creating a session', async () => {
    const sessions = createInAppPlanningChatSessions();

    await expect(sendPlanningChatMessage({
      sessionId: 'session-1',
      message: '   ',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    })).resolves.toEqual({ ok: false, sessionId: 'session-1', error: 'Type a message first.' });
    expect(sessions.size).toBe(0);
  });

  it('rejects an unknown preset without creating a session', async () => {
    const sessions = createInAppPlanningChatSessions();

    await expect(sendPlanningChatMessage({
      message: 'hello',
      presetKey: 'bad',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    })).resolves.toEqual({ ok: false, sessionId: undefined, error: 'Unknown planner preset "bad".' });
    expect(sessions.size).toBe(0);
  });

  it('creates a first session and returns the assistant reply', async () => {
    const spawnPlanner = vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue('I can help.');
    const sessions = createInAppPlanningChatSessions();

    const result = await sendPlanningChatMessage({
      message: 'hello',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(result).toMatchObject({ ok: true, reply: 'I can help.', draftPlanAvailable: false });
    expect(result.ok && result.sessionId).toBeTruthy();
    expect(sessions.size).toBe(1);
    const session = [...sessions.values()][0];
    expect(session?.messages).toEqual([
      expect.objectContaining({ id: 1, role: 'user', text: 'hello' }),
      expect.objectContaining({ id: 2, role: 'assistant', text: 'I can help.' }),
    ]);
    expect(session?.messages.some((line) => line.text === 'Ask Invoker what you want to build.')).toBe(false);
    expect(spawnPlanner).toHaveBeenCalledTimes(1);
  });

  it('tells the in-app planner to resolve ambiguity before drafting', async () => {
    const spawnPlanner = vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue('What edge cases matter most?');
    const sessions = createInAppPlanningChatSessions();

    await sendPlanningChatMessage({
      message: 'Add the feature',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(spawnPlanner).toHaveBeenCalledTimes(1);
    const prompt = spawnPlanner.mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('Treat this as a conversation before a plan.');
    expect(prompt).toContain('Talk through edge cases, corner cases, architecture, and ambiguity with the human.');
    expect(prompt).toContain('Resolve those points before producing a YAML plan.');
    expect(prompt).toContain('Draft YAML only after the human asks you to draft/proceed');
  });

  it('reuses an existing session and keeps its original preset', async () => {
    const spawnPlanner = vi.spyOn(PlanConversation.prototype, 'spawnPlanner')
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second');
    const sessions = createInAppPlanningChatSessions();

    const first = await sendPlanningChatMessage({
      message: 'hello',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    if (!first.ok) throw new Error(first.error);

    const second = await sendPlanningChatMessage({
      sessionId: first.sessionId,
      message: 'more detail',
      presetKey: 'omp+claude',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(second).toMatchObject({ ok: true, sessionId: first.sessionId, reply: 'second' });
    expect(sessions.get(first.sessionId)?.presetKey).toBe('codex');
    expect(spawnPlanner).toHaveBeenCalledTimes(2);
  });

  it('returns the raw draft reply and keeps a draft plan summary for valid YAML', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(VALID_PLAN);
    const sessions = createInAppPlanningChatSessions();

    const result = await sendPlanningChatMessage({
      message: 'draft the full plan',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(result).toMatchObject({
      ok: true,
      reply: VALID_PLAN_REPLY,
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First task', 'Second task'] },
    });
    expect(result.ok && result.reply).toContain('```yaml');
    expect(result.ok && result.reply).toContain('name: Mock Plan');
    expect(result.ok && sessions.get(result.sessionId)?.messages.at(-1)?.text).toBe(VALID_PLAN_REPLY);
  });

  it('keeps unauthorized YAML from becoming draft-ready or submittable', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(VALID_PLAN);
    const sessions = createInAppPlanningChatSessions();
    const loadGeneratedPlan = vi.fn();

    const result = await sendPlanningChatMessage({
      message: 'What would this involve?',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan,
      sessions,
      planningCommandBuilder,
    });

    expect(result).toMatchObject({
      ok: true,
      reply: VALID_PLAN_REPLY,
      draftPlanAvailable: false,
    });
    if (!result.ok) throw new Error(result.error);
    expect(sessions.get(result.sessionId)?.status).toBe('still_discussing');
    expect(sessions.get(result.sessionId)?.draftPlanText).toBeUndefined();

    await expect(submitPlanningChatDraft({
      sessionId: result.sessionId,
    }, {
      sessions,
      loadGeneratedPlan,
    })).resolves.toMatchObject({ ok: false });
    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('accepts short confirmation only after the assistant asks whether to draft', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner')
      .mockResolvedValueOnce('I found the key choices. Do you want me to draft the YAML plan?')
      .mockResolvedValueOnce(VALID_PLAN);
    const sessions = createInAppPlanningChatSessions();

    const scoped = await sendPlanningChatMessage({
      message: 'Help me scope a cleanup',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    if (!scoped.ok) throw new Error(scoped.error);

    const confirmed = await sendPlanningChatMessage({
      sessionId: scoped.sessionId,
      message: 'do it',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(confirmed).toMatchObject({
      ok: true,
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First task', 'Second task'] },
    });
    expect(sessions.get(scoped.sessionId)?.status).toBe('draft_ready');
  });

  it('does not treat a standalone short confirmation as draft authorization', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(VALID_PLAN);
    const sessions = createInAppPlanningChatSessions();

    const result = await sendPlanningChatMessage({
      message: 'do it',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    expect(result).toMatchObject({ ok: true, draftPlanAvailable: false });
    if (!result.ok) throw new Error(result.error);
    expect(sessions.get(result.sessionId)?.draftPlanText).toBeUndefined();
  });

  it('returns a stacked workflow summary when the assistant drafts workflow bundles', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(WORKERS_SURFACE_STACKED_PLAN);
    const sessions = createInAppPlanningChatSessions();
    const result = await sendPlanningChatMessage({
      message: 'draft the Workers Surface plan',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    expect(result).toMatchObject({
      ok: true,
      draftPlanAvailable: true,
      draftPlanSummary: {
        name: 'Workers Surface',
        taskCount: 3,
        workflowCount: 2,
        steps: ['Workers Surface Contracts', 'Workers Surface UI'],
      },
    });
  });

  it('submits the latest valid draft plan', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(VALID_PLAN);
    const sessions = createInAppPlanningChatSessions();
    const sent = await sendPlanningChatMessage({
      message: 'draft',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    if (!sent.ok) throw new Error(sent.error);
    const loadGeneratedPlan = vi.fn().mockResolvedValue({
      planName: 'Mock Plan',
      workflowId: 'wf-1',
      workflowIds: ['wf-1'],
      workflowCount: 1,
    });

    await expect(submitPlanningChatDraft({
      sessionId: sent.sessionId,
    }, {
      sessions,
      loadGeneratedPlan,
    })).resolves.toEqual({
      ok: true,
      planName: 'Mock Plan',
      workflowId: 'wf-1',
      workflowIds: ['wf-1'],
      workflowCount: 1,
    });
    expect(loadGeneratedPlan).toHaveBeenCalledWith(expect.stringContaining('name: Mock Plan'));
  });

  it('submits a valid final draft plan without a closing YAML fence', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(VALID_PLAN_WITHOUT_CLOSING_FENCE);
    const sessions = createInAppPlanningChatSessions();
    const sent = await sendPlanningChatMessage({
      message: 'draft',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    if (!sent.ok) throw new Error(sent.error);
    const loadGeneratedPlan = vi.fn().mockResolvedValue({
      planName: 'Mock Plan',
      workflowId: 'wf-1',
      workflowIds: ['wf-1'],
      workflowCount: 1,
    });

    await expect(submitPlanningChatDraft({
      sessionId: sent.sessionId,
    }, {
      sessions,
      loadGeneratedPlan,
    })).resolves.toEqual({
      ok: true,
      planName: 'Mock Plan',
      workflowId: 'wf-1',
      workflowIds: ['wf-1'],
      workflowCount: 1,
    });
    expect(loadGeneratedPlan).toHaveBeenCalledWith(expect.stringContaining('name: Mock Plan'));
  });

  it('coalesces concurrent submit requests for one session', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(VALID_PLAN);
    const sessions = createInAppPlanningChatSessions();
    const sent = await sendPlanningChatMessage({
      message: 'draft',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    if (!sent.ok) throw new Error(sent.error);

    let resolveLoad: ((value: LoadedGeneratedPlan) => void) | undefined;
    const loadGeneratedPlan = vi.fn(() => new Promise<LoadedGeneratedPlan>((resolve) => {
      resolveLoad = resolve;
    }));

    const first = submitPlanningChatDraft({ sessionId: sent.sessionId }, { sessions, loadGeneratedPlan });
    const second = submitPlanningChatDraft({ sessionId: sent.sessionId }, { sessions, loadGeneratedPlan });
    await vi.dynamicImportSettled();

    expect(loadGeneratedPlan).toHaveBeenCalledTimes(1);
    resolveLoad?.({ planName: 'Mock Plan', workflowId: 'wf-1' });

    await expect(first).resolves.toEqual({ ok: true, planName: 'Mock Plan', workflowId: 'wf-1' });
    await expect(second).resolves.toEqual({ ok: true, planName: 'Mock Plan', workflowId: 'wf-1' });
  });

  it('returns load and parse failures as submit errors', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(VALID_PLAN);
    const sessions = createInAppPlanningChatSessions();
    const sent = await sendPlanningChatMessage({
      message: 'draft',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    if (!sent.ok) throw new Error(sent.error);
    const loadGeneratedPlan = vi.fn().mockRejectedValue(new Error('Task "make-selected-lists-scroll" uses "autoFix", which is no longer supported.'));

    await expect(submitPlanningChatDraft({
      sessionId: sent.sessionId,
    }, {
      sessions,
      loadGeneratedPlan,
    })).resolves.toEqual({
      ok: false,
      error: 'Task "make-selected-lists-scroll" uses "autoFix", which is no longer supported.',
    });
  });

  it('submits planner drafts after stripping legacy auto-fix fields', async () => {
    const legacyPlan = `Here is the plan.

\`\`\`yaml
name: Legacy AutoFix Draft
onFinish: none
autoFixRetries: 2
tasks:
  - id: make-selected-lists-scroll
    description: Make selected lists scroll
    command: pnpm test
    dependencies: []
    autoFix: false
\`\`\``;
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(legacyPlan);
    const sessions = createInAppPlanningChatSessions();
    const sent = await sendPlanningChatMessage({
      message: 'draft',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    if (!sent.ok) throw new Error(sent.error);
    const loadGeneratedPlan = vi.fn().mockResolvedValue({ planName: 'Legacy AutoFix Draft', workflowId: 'wf-1' });

    await expect(submitPlanningChatDraft({
      sessionId: sent.sessionId,
    }, {
      sessions,
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: true, planName: 'Legacy AutoFix Draft', workflowId: 'wf-1' });

    const submittedPlan = loadGeneratedPlan.mock.calls[0]?.[0] as string;
    expect(submittedPlan).toContain('id: make-selected-lists-scroll');
    expect(submittedPlan).not.toContain('autoFix');
    expect(submittedPlan).not.toContain('autoFixRetries');
  });

  it('submits stacked drafts as stacked workflows', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(WORKERS_SURFACE_STACKED_PLAN);
    const sessions = createInAppPlanningChatSessions();
    const sent = await sendPlanningChatMessage({
      message: 'draft',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    if (!sent.ok) throw new Error(sent.error);
    const loadGeneratedPlan = vi.fn().mockResolvedValue({
      planName: 'Workers Surface',
      workflowId: 'wf-2',
      workflowIds: ['wf-1', 'wf-2'],
      workflowCount: 2,
    });

    await expect(submitPlanningChatDraft({
      sessionId: sent.sessionId,
    }, {
      sessions,
      loadGeneratedPlan,
    })).resolves.toEqual({
      ok: true,
      planName: 'Workers Surface',
      workflowId: 'wf-2',
      workflowIds: ['wf-1', 'wf-2'],
      workflowCount: 2,
    });
    expect(sessions.get(sent.sessionId)?.messages.at(-1)?.text).toBe(
      'Plan "Workers Surface" submitted as 2 stacked workflows. Review them, then use Start ready work.',
    );
  });

  it('rejects submit for an unknown session', async () => {
    await expect(submitPlanningChatDraft({
      sessionId: 'missing',
    }, {
      sessions: createInAppPlanningChatSessions(),
      loadGeneratedPlan: vi.fn(),
    })).resolves.toEqual({ ok: false, error: 'No planning conversation yet.' });
  });

  it('rejects submit when no draft exists', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue('No YAML yet.');
    const sessions = createInAppPlanningChatSessions();
    const sent = await sendPlanningChatMessage({
      message: 'hello',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    if (!sent.ok) throw new Error(sent.error);

    await expect(submitPlanningChatDraft({
      sessionId: sent.sessionId,
    }, {
      sessions,
      loadGeneratedPlan: vi.fn(),
    })).resolves.toEqual({ ok: false, error: 'No complete plan drafted yet. Ask the AI to create a full plan, then submit again.' });
  });

  it('rejects submit when the draft summary cannot be read', async () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('bad-summary', {
      id: 'bad-summary',
      title: 'Bad summary',
      presetKey: 'codex',
      status: 'draft_ready',
      messages: [],
      conversation: new PlanConversation({}),
      draftPlanSummary: { name: 'Bad Summary', taskCount: 1, steps: ['Numeric id'] },
      draftPlanText: 'name: Bad Summary\ntasks:\n  - id: 1\n    description: Numeric id\n',
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:00.000Z',
      nextMessageId: 1,
    });

    await expect(submitPlanningChatDraft({
      sessionId: 'bad-summary',
    }, {
      sessions,
      loadGeneratedPlan: vi.fn(),
    })).resolves.toEqual({ ok: false, error: 'I found a draft plan but could not read it. Ask the AI to regenerate the plan, then submit again.' });
  });


  it('persists visible planning sessions and hidden planner context while sending', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue('What should the README include?');
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const conversationRepo = new ConversationRepository(adapter);
      const sessions = createInAppPlanningChatSessions();

      const result = await sendPlanningChatMessage({
        message: 'Add README',
        presetKey: 'codex',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo,
        planningSessionStore: adapter,
      });

      if (!result.ok) throw new Error(result.error);
      expect(adapter.loadInAppPlanningSession(result.sessionId)).toMatchObject({
        id: result.sessionId,
        title: 'Add README',
        presetKey: 'codex',
        pendingResponse: false,
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user', text: 'Add README' }),
          expect.objectContaining({ role: 'assistant', text: 'What should the README include?' }),
        ]),
      });
      expect(conversationRepo.loadConversation(result.sessionId)?.threadTs).toBe(result.sessionId);
    } finally {
      adapter.close();
    }
  });

  it('does not submit hidden planner context without approved session draft text', async () => {
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

  it('restores draft-ready sessions and submits from persisted approved draft text', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const conversationRepo = new ConversationRepository(adapter);
      const record: InAppPlanningSessionRecord = {
        id: 'planning-restored',
        title: 'Restored plan',
        presetKey: 'codex',
        status: 'draft_ready',
        messages: [
          { id: 1, role: 'system', text: 'Ask Invoker what you want to build.', tone: 'muted', createdAt: '2026-07-07T00:00:00.000Z' },
          { id: 2, role: 'user', text: 'Draft it', createdAt: '2026-07-07T00:00:01.000Z' },
          { id: 3, role: 'assistant', text: VALID_PLAN, createdAt: '2026-07-07T00:00:02.000Z' },
        ],
        draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First task', 'Second task'] },
        draftPlanText: VALID_PLAN_TEXT,
        pendingResponse: false,
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:02.000Z',
      };
      conversationRepo.saveConversation('planning-restored', [
        { role: 'user', content: 'Draft it' },
        { role: 'assistant', content: VALID_PLAN },
      ], null, false, undefined, undefined, 'plan');

      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([record], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo,
        planningSessionStore: adapter,
      });
      const loadGeneratedPlan = vi.fn().mockResolvedValue({ planName: 'Mock Plan', workflowId: 'wf-1' });

      await expect(submitPlanningChatDraft({ sessionId: 'planning-restored' }, {
        sessions,
        loadGeneratedPlan,
        planningSessionStore: adapter,
      })).resolves.toMatchObject({ ok: true, planName: 'Mock Plan', workflowId: 'wf-1' });
      expect(loadGeneratedPlan).toHaveBeenCalledWith(expect.stringContaining('name: Mock Plan'));
      expect(loadGeneratedPlan).toHaveBeenCalledWith(expect.not.stringContaining('```yaml'));
    } finally {
      adapter.close();
    }
  });

  it('restores persisted tmux mode and planning-owned terminal state', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const conversationRepo = new ConversationRepository(adapter);
      const record: InAppPlanningSessionRecord = {
        id: 'planning-tmux-restored',
        title: 'Restored tmux plan',
        presetKey: 'codex',
        status: 'still_discussing',
        messages: [
          { id: 1, role: 'system', text: 'Ask Invoker what you want to build.', tone: 'muted', createdAt: '2026-07-07T00:00:00.000Z' },
        ],
        terminalMode: 'tmux',
        terminalSessionId: 'term-planning-owned',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'planner tmux output\n',
        terminalUpdatedAt: '2026-07-07T00:00:03.000Z',
        pendingResponse: false,
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:02.000Z',
      };

      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([record], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo,
        planningSessionStore: adapter,
      });

      expect(sessions.get('planning-tmux-restored')).toMatchObject({
        terminalMode: 'tmux',
        terminalSessionId: 'term-planning-owned',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'planner tmux output\n',
      });
      expect(listPlanningChatSessions({ sessions }).sessions[0]).toMatchObject({
        terminalMode: 'tmux',
        terminalSessionId: 'term-planning-owned',
        terminalStatus: 'running',
      });
    } finally {
      adapter.close();
    }
  });

  it('persists planning terminal mode and snapshot updates without rewriting messages', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      const created = await createPlanningChatSession({ title: 'Terminal state' }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        planningSessionStore: adapter,
      });
      if (!created.ok) throw new Error(created.error);

      expect(setPlanningChatTerminalMode({
        sessionId: created.session.id,
        mode: 'tmux',
      }, {
        sessions,
        planningSessionStore: adapter,
      })).toEqual({ ok: true });
      expect(updatePlanningChatTerminalState(created.session.id, {
        terminalSessionId: 'term-planning-state',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'hello from tmux\n',
      }, {
        sessions,
        planningSessionStore: adapter,
      })).toBe(true);

      expect(adapter.loadInAppPlanningSession(created.session.id)).toMatchObject({
        terminalMode: 'tmux',
        terminalSessionId: 'term-planning-state',
        terminalStatus: 'running',
        terminalOutputSnapshot: 'hello from tmux\n',
        messages: [],
      });
    } finally {
      adapter.close();
    }
  });

  it('rebuilds missing draft summaries from hidden planner state on restore', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const conversationRepo = new ConversationRepository(adapter);
      const record: InAppPlanningSessionRecord = {
        id: 'planning-summary-restore',
        title: 'Recovered summary',
        presetKey: 'codex',
        status: 'draft_ready',
        messages: [
          { id: 1, role: 'system', text: 'Ask Invoker what you want to build.', tone: 'muted', createdAt: '2026-07-07T00:00:00.000Z' },
          { id: 2, role: 'assistant', text: VALID_PLAN, createdAt: '2026-07-07T00:00:01.000Z' },
        ],
        pendingResponse: false,
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:01.000Z',
      };
      conversationRepo.saveConversation('planning-summary-restore', [
        { role: 'assistant', content: VALID_PLAN },
      ], null, false, undefined, undefined, 'plan');

      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([record], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo,
        planningSessionStore: adapter,
      });

      expect(sessions.get('planning-summary-restore')?.draftPlanSummary).toMatchObject({
        name: 'Mock Plan',
        taskCount: 2,
      });
      expect(sessions.get('planning-summary-restore')?.draftPlanText).toContain('name: Mock Plan');
      expect(adapter.loadInAppPlanningSession('planning-summary-restore')?.draftPlanSummary).toMatchObject({
        name: 'Mock Plan',
        taskCount: 2,
      });
      expect(adapter.loadInAppPlanningSession('planning-summary-restore')?.draftPlanText).toContain('name: Mock Plan');
    } finally {
      adapter.close();
    }
  });

  it('clears submitted pending-response state during restore', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const record: InAppPlanningSessionRecord = {
        id: 'planning-submitted',
        title: 'Submitted plan',
        presetKey: 'codex',
        status: 'submitted',
        messages: [
          { id: 1, role: 'system', text: 'Ask Invoker what you want to build.', tone: 'muted', createdAt: '2026-07-07T00:00:00.000Z' },
        ],
        submittedWorkflowId: 'wf-123',
        submittedPlanName: 'Submitted plan',
        pendingResponse: true,
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:01.000Z',
      };

      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([record], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      });

      expect(sessions.get('planning-submitted')?.messages).toHaveLength(1);
      expect(adapter.loadInAppPlanningSession('planning-submitted')?.pendingResponse).toBe(false);
      expect(setPlanningChatTerminalMode({
        sessionId: 'planning-submitted',
        mode: 'tmux',
      }, {
        sessions,
        planningSessionStore: adapter,
      })).toEqual({ ok: true });
      await expect(sendPlanningChatMessage({
        sessionId: 'planning-submitted',
        message: 'change it',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      })).resolves.toMatchObject({
        ok: false,
        error: 'This planning session was already submitted. Start a new planning chat for changes.',
      });
    } finally {
      adapter.close();
    }
  });

  it('restores interrupted sessions idle with an interruption system line', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const record: InAppPlanningSessionRecord = {
        id: 'planning-interrupted',
        title: 'Interrupted plan',
        presetKey: 'codex',
        status: 'still_discussing',
        messages: [
          { id: 1, role: 'system', text: 'Ask Invoker what you want to build.', tone: 'muted', createdAt: '2026-07-07T00:00:00.000Z' },
          { id: 2, role: 'user', text: 'Continue', createdAt: '2026-07-07T00:00:01.000Z' },
        ],
        pendingResponse: true,
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:01.000Z',
      };
      adapter.upsertInAppPlanningSession(record);
      const sessions = createInAppPlanningChatSessions();

      await restorePlanningChatSessions([record], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo: new ConversationRepository(adapter),
        planningSessionStore: adapter,
      });

      const restored = sessions.get('planning-interrupted');
      expect(restored?.pendingSend).toBeUndefined();
      expect(restored?.messages.at(-1)).toMatchObject({
        role: 'system',
        text: 'Planner was interrupted before it could answer. Send another message to continue.',
        tone: 'error',
      });
      expect(adapter.loadInAppPlanningSession('planning-interrupted')?.pendingResponse).toBe(false);
    } finally {
      adapter.close();
    }
  });

  it('is a no-op without loading planner surfaces when there are no sessions', async () => {
    const sessions = createInAppPlanningChatSessions();
    const builder = vi.fn(() => ({ command: 'planner', args: [] }));

    await expect(restorePlanningChatSessions([], {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder: builder,
    })).resolves.toBeUndefined();

    expect(sessions.size).toBe(0);
    expect(builder).not.toHaveBeenCalled();
  });
  it('resets a planning chat session', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('session-1', {
      id: 'session-1',
      presetKey: 'codex',
      conversation: new PlanConversation({}),
    } as any);

    expect(resetPlanningChat({ sessionId: 'session-1' }, { sessions })).toEqual({ ok: true });
    expect(sessions.has('session-1')).toBe(false);
  });
});

describe('createPlanningCommandBuilderFromRegistry', () => {
  it('delegates planning command construction to the selected registry tool', () => {
    const buildPlanningCommand = vi.fn(() => ({ command: 'codex', args: ['--model', 'fast', 'prompt'] }));
    const registry = {
      getPlanningOrThrow: vi.fn(() => ({ buildPlanningCommand })),
    };

    const builder = createPlanningCommandBuilderFromRegistry(registry as any);
    expect(builder({ tool: 'codex', model: 'fast', prompt: 'prompt' })).toEqual({ command: 'codex', args: ['--model', 'fast', 'prompt'] });
    expect(registry.getPlanningOrThrow).toHaveBeenCalledWith('codex');
    expect(buildPlanningCommand).toHaveBeenCalledWith('prompt', { model: 'fast' });
  });
});
