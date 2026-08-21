import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveInvokerHomeRoot } from '@invoker/contracts';
import { PlanConversation } from '../../../surfaces/src/index.ts';
import {
  PLANNING_TERMINAL_SUMMARY_BRIDGE_START,
  buildPlanningTerminalSummaryBridge,
  createInAppPlanningChatSessions,
  createPlanningChatSession,
  createPlanningCommandBuilderFromRegistry,
  discardPlanningChatDraft,
  listInAppPlanningPresets,
  hydrateRemotePlanningTerminalSession,
  listPlanningChatSessions,
  planFromGoal,
  rebindPlanningChatRepo,
  resetPlanningChat,
  restorePlanningChatSessions,
  sendPlanningChatMessage,
  setPlanningChatTerminalMode,
  submitPlanningChatDraft,
  updatePlanningChatTerminalState,
  type InAppPlanningChatSession,
  type LoadedGeneratedPlan,
} from '../in-app-planner.js';
import type { PlanningRepoPool } from '../planning-chat-worktree.js';
import { ConversationRepository, SQLiteAdapter, type InAppPlanningSessionRecord } from '@invoker/data-store';

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

const NO_COMPLETE_PLAN_DRAFTED_ERROR = 'No complete plan drafted yet. Ask the AI to create a full plan, then submit again.';

const INTERRUPTED_TURN_SYSTEM_LINE = {
  role: 'system',
  text: 'Planner was interrupted before it could answer.',
  tone: 'error',
} as const;

function planningSession(
  overrides: Partial<InAppPlanningChatSession> & Pick<InAppPlanningChatSession, 'id' | 'title'>,
): InAppPlanningChatSession {
  return {
    presetKey: 'codex',
    confirmationMode: 'require',
    status: 'still_discussing',
    messages: [],
    conversation: new PlanConversation({}),
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
    nextMessageId: 1,
    ...overrides,
  };
}

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

describe('buildPlanningTerminalSummaryBridge', () => {
  it('composes bounded planning tmux context from session metadata', () => {
    const longUserMessage = `Please wire the tmux bridge ${'details '.repeat(40)}tail-marker`;
    const bridge = buildPlanningTerminalSummaryBridge({
      id: 'planning-bridge',
      title: 'Planning bridge terminal',
      presetKey: 'omp+codex',
      status: 'draft_ready',
      messages: [
        { id: 1, role: 'user', text: longUserMessage, createdAt: '2026-07-07T00:00:00.000Z' },
        { id: 2, role: 'assistant', text: 'raw assistant draft that should not be copied when a summary exists', createdAt: '2026-07-07T00:00:01.000Z' },
      ],
      conversation: new PlanConversation({}),
      draftPlanSummary: {
        name: 'Bridge Plan',
        taskCount: 2,
        steps: ['Wire helper', 'Persist snapshot'],
        taskGroups: [],
      },
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:01.000Z',
      nextMessageId: 3,
    });

    expect(bridge).toContain(PLANNING_TERMINAL_SUMMARY_BRIDGE_START);
    expect(bridge).toContain('Planning session: Planning bridge terminal');
    expect(bridge).toContain('Status: draft ready');
    expect(bridge).toContain('Preset: Codex via OMP (omp+codex)');
    expect(bridge).toContain('Draft plan: Bridge Plan (2 tasks) - Wire helper; Persist snapshot');
    expect(bridge).toContain('Next: Review or submit the draft in chat');
    expect(bridge).not.toContain('tail-marker');
    expect(bridge).not.toContain('raw assistant draft');
  });

  it('strips ANSI escape and control characters from embedded chat text', () => {
    const bridge = buildPlanningTerminalSummaryBridge({
      id: 'planning-bridge-controls',
      title: 'Planning bridge terminal',
      presetKey: 'codex',
      status: 'still_discussing',
      messages: [
        {
          id: 1,
          role: 'user',
          text: '\x1b[31mred\x1b[0m text\x07with bell and \x1b]0;title\x07osc',
          createdAt: '2026-07-07T00:00:00.000Z',
        },
      ],
      conversation: new PlanConversation({}),
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:00.000Z',
      nextMessageId: 2,
    });

    expect(bridge).toContain('Latest user: [31mred[0m textwith bell and ]0;titleosc');
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(bridge)).toBe(false);
  });
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
      { key: 'codex', label: 'Codex', tool: 'codex', model: undefined, isDefault: false, defaultConfirmationMode: 'require' },
      { key: 'claude', label: 'Claude', tool: 'claude', model: undefined, isDefault: false, defaultConfirmationMode: 'require' },
      { key: 'omp', label: 'OMP', tool: 'omp', model: undefined, isDefault: false, defaultConfirmationMode: 'require' },
      { key: 'omp+claude', label: 'Claude via OMP', tool: 'omp', model: 'claude', isDefault: true, defaultConfirmationMode: 'require' },
      { key: 'custom', label: 'custom', tool: 'codex', model: undefined, isDefault: false, defaultConfirmationMode: 'require' },
      { key: 'custom+omp', label: 'custom + omp', tool: 'omp', model: 'fast', isDefault: false, defaultConfirmationMode: 'require' },
    ]));
  });
});


describe('planning chat', () => {
  const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

  it('rejects blank messages without creating a session', async () => {
    const sessions = createInAppPlanningChatSessions();

    const rejected = await sendPlanningChatMessage({
      sessionId: 'session-1',
      message: '   ',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    expect(rejected).toMatchObject({ ok: false, sessionId: 'session-1', error: 'Type a message first.' });
    expect(rejected.turnId).toEqual(expect.any(String));
    expect(sessions.size).toBe(0);
  });

  it('rejects an unknown preset without creating a session', async () => {
    const sessions = createInAppPlanningChatSessions();

    const rejected = await sendPlanningChatMessage({
      message: 'hello',
      presetKey: 'bad',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    expect(rejected).toMatchObject({ ok: false, sessionId: undefined, error: 'Unknown planner preset "bad".' });
    expect(rejected.turnId).toEqual(expect.any(String));
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
    const sentPlannerPrompt = spawnPlanner.mock.calls[0]?.[0] ?? '';
    expect(sentPlannerPrompt).toContain('This session is a planning conversation before any task plan exists.');
    expect(sentPlannerPrompt).toContain('Discuss relevant edge cases, corner cases, architecture choices, ambiguity');
    expect(sentPlannerPrompt).toContain('Drafting is not authorized yet. Do NOT output a ```yaml code block');
    expect(sentPlannerPrompt).toContain('Do not rush directly to YAML unless the user has clearly approved drafting a plan.');
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

  it('rejects an unknown continuation session without creating a new chat', async () => {
    const spawnPlanner = vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue('new chat');
    const sessions = createInAppPlanningChatSessions();

    await expect(sendPlanningChatMessage({
      sessionId: 'missing-session',
      message: 'continue planning',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    })).resolves.toEqual({
      ok: false,
      sessionId: 'missing-session',
      turnId: expect.any(String),
      error: 'Planning session "missing-session" was not found.',
    });

    expect(sessions.size).toBe(0);
    expect(spawnPlanner).not.toHaveBeenCalled();
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
      reply: VALID_PLAN,
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First task', 'Second task'] },
      draftPlanText: expect.stringContaining('name: Mock Plan'),
    });
    expect(result.ok && result.reply).toContain('```yaml');
    expect(result.ok && result.reply).toContain('name: Mock Plan');
    expect(result.ok && sessions.get(result.sessionId)?.messages.at(-1)?.text).toBe(VALID_PLAN);
  });

  it('keeps unauthorized YAML from becoming draft-ready and refuses submit', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(VALID_PLAN);
    const sessions = createInAppPlanningChatSessions();
    const loadGeneratedPlan = vi.fn().mockResolvedValue({
      planName: 'Mock Plan',
      workflowId: 'wf-1',
    } satisfies LoadedGeneratedPlan);

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
      reply: VALID_PLAN,
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
    })).resolves.toEqual({ ok: false, error: NO_COMPLETE_PLAN_DRAFTED_ERROR });
    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('does not search an earlier draft when submitting after a summary-only turn', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'in-app-draft-'));
    try {
      const sessions = createInAppPlanningChatSessions();
      const created = await createPlanningChatSession({}, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        workingDir,
      });
      if (!created.ok) throw new Error(created.error);
      const session = sessions.get(created.session.id);
      if (!session) throw new Error('expected session in map');

      const draftPath = session.conversation.planDraftFilePath();
      if (!draftPath) throw new Error('expected draft path');
      mkdirSync(dirname(draftPath), { recursive: true });

      vi.spyOn(PlanConversation.prototype, 'spawnPlanner')
        .mockImplementationOnce(async () => {
          writeFileSync(draftPath, VALID_PLAN_TEXT, 'utf8');
          return 'Plan written.';
        })
        .mockResolvedValueOnce('Plan summary.');

      const draftedBeforeAuthorization = await sendPlanningChatMessage({
        sessionId: session.id,
        message: 'What would this plan do?',
        presetKey: 'codex',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        workingDir,
      });
      expect(draftedBeforeAuthorization).toMatchObject({ ok: true, draftPlanAvailable: false });

      await sendPlanningChatMessage({
        sessionId: session.id,
        message: 'Can you summarize it?',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        workingDir,
      });

      expect(sessions.get(session.id)?.draftPlanText).toBeUndefined();

      const loadGeneratedPlan = vi.fn().mockResolvedValue({
        planName: 'Mock Plan',
        workflowId: 'wf-1',
      } satisfies LoadedGeneratedPlan);
      await expect(submitPlanningChatDraft({ sessionId: session.id }, {
        sessions,
        loadGeneratedPlan,
      })).resolves.toEqual({ ok: false, error: NO_COMPLETE_PLAN_DRAFTED_ERROR });
      expect(loadGeneratedPlan).not.toHaveBeenCalled();
      expect(sessions.get(session.id)?.draftPlanText).toBeUndefined();
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('requires the planner to recreate a plan when no prior plan exists', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue('Plan summary.');
    const sessions = createInAppPlanningChatSessions();
    const loadGeneratedPlan = vi.fn();

    const result = await sendPlanningChatMessage({
      message: 'draft it',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan,
      sessions,
      planningCommandBuilder,
    });

    expect(result).toMatchObject({ ok: true, draftPlanAvailable: false });
    await expect(submitPlanningChatDraft({ sessionId: result.sessionId }, {
      sessions,
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: false, error: NO_COMPLETE_PLAN_DRAFTED_ERROR });
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

  it('keeps the retained draft when an ordinary critique reply coincidentally contains a fenced YAML plan', async () => {
    const critiqueReplyWithYaml = `Sure, that step is optional if you already have the schema.

\`\`\`yaml
name: Coincidental Plan
onFinish: none
tasks:
  - id: only
    description: Only task
    command: echo only
\`\`\``;
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner')
      .mockResolvedValueOnce(VALID_PLAN)
      .mockResolvedValueOnce(critiqueReplyWithYaml);
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const conversationRepo = new ConversationRepository(adapter);
      const sessions = createInAppPlanningChatSessions();

      const first = await sendPlanningChatMessage({
        message: 'draft the full plan',
        presetKey: 'codex',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo,
        planningSessionStore: adapter,
      });
      if (!first.ok) throw new Error(first.error);
      expect(first).toMatchObject({ ok: true, draftPlanAvailable: true });
      expect(sessions.get(first.sessionId)?.status).toBe('draft_ready');
      const planA = sessions.get(first.sessionId)?.draftPlanText;
      expect(planA).toContain('name: Mock Plan');

      const second = await sendPlanningChatMessage({
        sessionId: first.sessionId,
        message: 'Can we skip the migration step?',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo,
        planningSessionStore: adapter,
      });
      if (!second.ok) throw new Error(second.error);
      expect(second.reply).toBe(critiqueReplyWithYaml);

      expect(sessions.get(first.sessionId)?.draftPlanText).toBe(planA);
      expect(sessions.get(first.sessionId)?.status).toBe('draft_ready');
      expect(adapter.loadInAppPlanningSession(first.sessionId)?.draftPlanText).toBe(planA);
    } finally {
      adapter.close();
    }
  });

  it('overwrites the retained draft when the user explicitly asks to re-draft', async () => {
    const redraftReply = `Here is the revised plan.

\`\`\`yaml
name: Revised Plan
onFinish: none
tasks:
  - id: only
    description: Only task
    command: echo only
\`\`\``;
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner')
      .mockResolvedValueOnce(VALID_PLAN)
      .mockResolvedValueOnce(redraftReply);
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const conversationRepo = new ConversationRepository(adapter);
      const sessions = createInAppPlanningChatSessions();

      const first = await sendPlanningChatMessage({
        message: 'draft the full plan',
        presetKey: 'codex',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo,
        planningSessionStore: adapter,
      });
      if (!first.ok) throw new Error(first.error);
      const planA = sessions.get(first.sessionId)?.draftPlanText;
      expect(planA).toContain('name: Mock Plan');

      const second = await sendPlanningChatMessage({
        sessionId: first.sessionId,
        message: 'draft it again with the migration step removed',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo,
        planningSessionStore: adapter,
      });
      if (!second.ok) throw new Error(second.error);

      const planB = sessions.get(first.sessionId)?.draftPlanText;
      expect(planB).toContain('name: Revised Plan');
      expect(planB).not.toBe(planA);
      expect(sessions.get(first.sessionId)?.status).toBe('draft_ready');
      expect(adapter.loadInAppPlanningSession(first.sessionId)?.draftPlanText).toBe(planB);
    } finally {
      adapter.close();
    }
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
    expect(sessions.get(sent.sessionId)?.status).toBe('draft_ready');
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

  it('coalesces concurrent chat turns for one session — a later turn does not start until the earlier one finishes', async () => {
    // End-to-end: the real conversation path (pendingSend chaining plus
    // PlanConversation's own turn lock, both active) never lets two chat
    // turns' planner calls run at once. See the plannerReplyOverride test
    // below for a version that isolates pendingSend specifically.
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValueOnce('turn 1 reply');
    const sessions = createInAppPlanningChatSessions();
    const first = await sendPlanningChatMessage({
      message: 'draft',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    if (!first.ok) throw new Error(first.error);

    const spawnSpy = vi.spyOn(PlanConversation.prototype, 'spawnPlanner');
    let resolveTurn2: ((value: string) => void) | undefined;
    spawnSpy.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveTurn2 = resolve; }));
    spawnSpy.mockResolvedValueOnce('turn 3 reply');
    const callsBefore = spawnSpy.mock.calls.length;

    const second = sendPlanningChatMessage({
      sessionId: first.sessionId,
      message: 'turn 2',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    const third = sendPlanningChatMessage({
      sessionId: first.sessionId,
      message: 'turn 3',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });

    // Give the event loop plenty of chances to let turn 3 start if it were
    // going to run concurrently with turn 2. With pendingSend serializing
    // chat turns, only turn 2's planner call can have happened by now.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(spawnSpy.mock.calls.length).toBe(callsBefore + 1);

    resolveTurn2?.('turn 2 reply');
    const secondResult = await second;
    const thirdResult = await third;

    expect(secondResult.ok && secondResult.reply).toBe('turn 2 reply');
    expect(thirdResult.ok && thirdResult.reply).toBe('turn 3 reply');
  });

  it('pendingSend alone serializes chat turns when the planner call bypasses PlanConversation entirely', async () => {
    // The previous test exercises the real PlanConversation.sendMessage path,
    // which now has its own turn-serialization lock — so it can't tell
    // apart "pendingSend serializes turns" from "PlanConversation's lock
    // serializes turns underneath it; pendingSend just rides along". The
    // plannerReplyOverride dependency skips conversation.sendMessage
    // entirely, isolating pendingSend as the only thing that could possibly
    // be serializing these calls.
    const sessions = createInAppPlanningChatSessions();
    const first = await sendPlanningChatMessage({
      message: 'draft',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
      plannerReplyOverride: async () => 'turn 1 reply',
    });
    if (!first.ok) throw new Error(first.error);

    let resolveTurn2: ((value: string) => void) | undefined;
    const overrideCalls: string[] = [];
    const plannerReplyOverride = vi.fn((formattedMessage: string) => {
      overrideCalls.push(formattedMessage);
      if (overrideCalls.length === 1) {
        return new Promise<string>((resolve) => { resolveTurn2 = resolve; });
      }
      return Promise.resolve('turn 3 reply');
    });

    const second = sendPlanningChatMessage({
      sessionId: first.sessionId,
      message: 'turn 2',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
      plannerReplyOverride,
    });
    const third = sendPlanningChatMessage({
      sessionId: first.sessionId,
      message: 'turn 3',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
      plannerReplyOverride,
    });

    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(overrideCalls.length).toBe(1); // only turn 2's override call has fired so far

    resolveTurn2?.('turn 2 reply');
    const secondResult = await second;
    const thirdResult = await third;

    expect(secondResult.ok && secondResult.reply).toBe('turn 2 reply');
    expect(thirdResult.ok && thirdResult.reply).toBe('turn 3 reply');
    expect(overrideCalls.length).toBe(2);
  });

  it('echoes an explicit turnId and rejects a duplicate send while that turn runs', async () => {
    const sessions = createInAppPlanningChatSessions();
    let resolveTurn: ((value: string) => void) | undefined;
    let turnStarted!: () => void;
    const started = new Promise<void>((resolve) => { turnStarted = resolve; });
    const plannerReplyOverride = vi.fn(() => {
      turnStarted();
      return new Promise<string>((resolve) => { resolveTurn = resolve; });
    });
    const deps = {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
      plannerReplyOverride,
    };

    const first = sendPlanningChatMessage({ message: 'draft', presetKey: 'codex', turnId: 'turn-explicit' }, deps);
    await started;

    const sessionId = [...sessions.keys()][0];
    const duplicate = await sendPlanningChatMessage({ sessionId, message: 'draft', turnId: 'turn-explicit' }, deps);
    expect(duplicate).toMatchObject({ ok: false, turnId: 'turn-explicit', error: 'duplicate-turn' });

    resolveTurn?.('turn reply');
    const result = await first;
    if (!result.ok) throw new Error(result.error);
    expect(result.turnId).toBe('turn-explicit');
    expect(plannerReplyOverride).toHaveBeenCalledTimes(1);
  });

  it('records a failed turn and a retry with the same turnId re-runs without duplicating the user line', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const sessions = createInAppPlanningChatSessions();
      const plannerReplyOverride = vi.fn()
        .mockRejectedValueOnce(new Error('planner crashed'))
        .mockResolvedValueOnce('recovered reply');
      const deps = {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        plannerReplyOverride,
        planningSessionStore: adapter,
      };

      const failed = await sendPlanningChatMessage({ message: 'draft', presetKey: 'codex', turnId: 'turn-retry' }, deps);
      if (failed.ok) throw new Error('expected the first turn to fail');
      expect(failed.turnId).toBe('turn-retry');
      const sessionId = failed.sessionId;
      if (!sessionId) throw new Error('expected a sessionId on the failed turn');
      const session = sessions.get(sessionId);
      expect(session?.activeTurnId).toBe('turn-retry');
      expect(session?.activeTurnStatus).toBe('failed');
      expect(session?.activeTurnError).toBe('planner crashed');
      const persisted = adapter.loadInAppPlanningSession(sessionId);
      expect(persisted?.activeTurnId).toBe('turn-retry');
      expect(persisted?.activeTurnStatus).toBe('failed');
      expect(persisted?.activeTurnError).toBe('planner crashed');
      const userLinesBefore = session?.messages.filter((line) => line.role === 'user').length;

      const retried = await sendPlanningChatMessage({ sessionId, message: 'draft', turnId: 'turn-retry' }, deps);
      if (!retried.ok) throw new Error(retried.error);
      expect(retried.reply).toBe('recovered reply');
      expect(session?.messages.filter((line) => line.role === 'user').length).toBe(userLinesBefore);
      expect(session?.activeTurnId).toBeUndefined();
      expect(session?.activeTurnStatus).toBeUndefined();
      expect(session?.activeTurnError).toBeUndefined();
      const persistedAfter = adapter.loadInAppPlanningSession(sessionId);
      expect(persistedAfter?.activeTurnId).toBeUndefined();
      expect(persistedAfter?.activeTurnStatus).toBeUndefined();
      expect(persistedAfter?.activeTurnError).toBeUndefined();
      expect(plannerReplyOverride).toHaveBeenCalledTimes(2);
    } finally {
      adapter.close();
    }
  });

  it('emits turn outcome events on the planning stream channel', async () => {
    const sessions = createInAppPlanningChatSessions();
    const onRawPlannerOutput = vi.fn();
    const ok = await sendPlanningChatMessage({ message: 'draft', presetKey: 'codex', turnId: 'turn-events' }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
      plannerReplyOverride: async () => 'turn reply',
      onRawPlannerOutput,
    });
    if (!ok.ok) throw new Error(ok.error);
    const completedEvent = onRawPlannerOutput.mock.calls
      .map(([event]) => event)
      .find((event) => event?.turn?.status === 'completed');
    expect(completedEvent).toMatchObject({
      sessionId: ok.sessionId,
      turnId: 'turn-events',
      turn: { status: 'completed', reply: 'turn reply', draftPlanAvailable: false },
    });

    const failSessions = createInAppPlanningChatSessions();
    const onFailEvent = vi.fn();
    const failed = await sendPlanningChatMessage({ message: 'draft', presetKey: 'codex', turnId: 'turn-fail' }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions: failSessions,
      planningCommandBuilder,
      plannerReplyOverride: async () => { throw new Error('boom'); },
      onRawPlannerOutput: onFailEvent,
    });
    expect(failed.ok).toBe(false);
    const failedEvent = onFailEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event?.turn?.status === 'failed');
    expect(failedEvent).toMatchObject({
      turnId: 'turn-fail',
      turn: { status: 'failed', error: 'boom' },
    });
  });

  it('never constructs a session in mode: agent (createSession and planFromGoal paths)', async () => {
    // The single shared config builder every terminal PlanConversation goes
    // through never sets `mode` at all, so every terminal session defaults
    // to 'plan' — the agent-mode system prompt (and the plan-intent
    // auto-detect wiring that currently only Slack connects) is unreachable
    // here. If someone later wires agent mode into the terminal, this test
    // breaks, forcing a conscious decision about whether plan-intent
    // detection needs to come along too, instead of a silent half-wire.
    let createSessionPrompt = '';
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockImplementationOnce((prompt: string) => {
      createSessionPrompt = prompt;
      return Promise.resolve('turn 1 reply');
    });
    const sessions = createInAppPlanningChatSessions();
    const created = await sendPlanningChatMessage({
      message: 'draft',
      presetKey: 'codex',
    }, {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    if (!created.ok) throw new Error(created.error);
    expect(sessions.get(created.sessionId)?.conversation.conversationMode).toBe('plan');
    expect(createSessionPrompt).not.toContain('You are a normal coding agent');
    expect(createSessionPrompt).not.toContain('wantsPlan');

    let goalPrompt = '';
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockImplementationOnce((prompt: string) => {
      goalPrompt = prompt;
      return Promise.resolve(VALID_PLAN);
    });
    const goalResult = await planFromGoal({ goal: 'build a REST API' }, {
      config: {},
      loadGeneratedPlan: vi.fn().mockResolvedValue({ planName: 'Mock Plan', workflowId: 'wf-1' }),
      planningCommandBuilder,
    });
    expect(goalResult.ok).toBe(true);
    expect(goalPrompt).not.toContain('You are a normal coding agent');
    expect(goalPrompt).not.toContain('wantsPlan');
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

  it('does not stage or submit planner drafts rejected for legacy auto-fix fields', async () => {
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
      planDoctorScriptPath: join(process.cwd(), '../../skills/plan-to-invoker/scripts/skill-doctor.sh'),
    });
    if (!sent.ok) throw new Error(sent.error);
    expect(sent.draftPlanAvailable).toBe(false);
    expect(sent.reply).toContain('Draft not shown: the plan doctor rejected it.');
    const loadGeneratedPlan = vi.fn().mockResolvedValue({ planName: 'Legacy AutoFix Draft', workflowId: 'wf-1' });

    await expect(submitPlanningChatDraft({
      sessionId: sent.sessionId,
    }, {
      sessions,
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: false, error: NO_COMPLETE_PLAN_DRAFTED_ERROR });
    expect(loadGeneratedPlan).not.toHaveBeenCalled();
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
      'Plan "Workers Surface" submitted as 2 stacked workflows.',
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
    })).resolves.toEqual({ ok: false, error: NO_COMPLETE_PLAN_DRAFTED_ERROR });
  });

  it('rejects submit when a saved draft snapshot is not draft-ready', async () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('not-ready-with-draft', planningSession({
      id: 'not-ready-with-draft',
      title: 'Not ready with draft',
      status: 'still_discussing',
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First task', 'Second task'] },
      draftPlanText: VALID_PLAN_TEXT,
    }));
    const loadGeneratedPlan = vi.fn().mockResolvedValue({
      planName: 'Mock Plan',
      workflowId: 'wf-1',
    } satisfies LoadedGeneratedPlan);

    await expect(submitPlanningChatDraft({
      sessionId: 'not-ready-with-draft',
    }, {
      sessions,
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: false, error: NO_COMPLETE_PLAN_DRAFTED_ERROR });
    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('rejects submit before reusing a stale pending submit when the session is not draft-ready', async () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('stale-pending-submit', planningSession({
      id: 'stale-pending-submit',
      title: 'Stale pending submit',
      status: 'still_discussing',
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First task', 'Second task'] },
      draftPlanText: VALID_PLAN_TEXT,
      pendingSubmit: Promise.resolve({
        ok: true,
        planName: 'Mock Plan',
        workflowId: 'wf-1',
      }),
    }));
    const loadGeneratedPlan = vi.fn();

    await expect(submitPlanningChatDraft({
      sessionId: 'stale-pending-submit',
    }, {
      sessions,
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: false, error: NO_COMPLETE_PLAN_DRAFTED_ERROR });
    expect(loadGeneratedPlan).not.toHaveBeenCalled();
  });

  it('rejects submit when draft-ready state has empty draft text', async () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('empty-draft-ready', planningSession({
      id: 'empty-draft-ready',
      title: 'Empty draft ready',
      status: 'draft_ready',
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First task', 'Second task'] },
      draftPlanText: '   ',
    }));
    const loadGeneratedPlan = vi.fn().mockResolvedValue({
      planName: 'Mock Plan',
      workflowId: 'wf-1',
    } satisfies LoadedGeneratedPlan);

    await expect(submitPlanningChatDraft({
      sessionId: 'empty-draft-ready',
    }, {
      sessions,
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: false, error: NO_COMPLETE_PLAN_DRAFTED_ERROR });
    expect(loadGeneratedPlan).not.toHaveBeenCalled();
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

  it('does not submit hidden planner context without a persisted draft snapshot', async () => {
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
    const loadGeneratedPlan = vi.fn().mockResolvedValue({
      planName: 'Mock Plan',
      workflowId: 'wf-1',
    } satisfies LoadedGeneratedPlan);

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
      rmSync(join(resolveInvokerHomeRoot(), 'plan-drafts', 'planning-restored.yaml'), { force: true });
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

  it('does not reconstruct missing draft snapshots from hidden planner state on restore', async () => {
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

      expect(sessions.get('planning-summary-restore')?.status).toBe('still_discussing');
      expect(sessions.get('planning-summary-restore')?.draftPlanSummary).toBeUndefined();
      expect(sessions.get('planning-summary-restore')?.draftPlanText).toBeUndefined();
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

      const restoredInterrupted = sessions.get('planning-interrupted');
      expect(restoredInterrupted?.pendingSend).toBeUndefined();
      expect(restoredInterrupted?.messages.at(-1)).toMatchObject(INTERRUPTED_TURN_SYSTEM_LINE);
      expect(adapter.loadInAppPlanningSession('planning-interrupted')?.pendingResponse).toBe(false);
    } finally {
      adapter.close();
    }
  });

  it('restores an interrupted pending turn as failed with its turnId preserved', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const record: InAppPlanningSessionRecord = {
        id: 'planning-interrupted-turn',
        title: 'Interrupted turn',
        presetKey: 'codex',
        status: 'still_discussing',
        confirmationMode: 'require',
        messages: [
          { id: 1, role: 'user', text: 'Continue', createdAt: '2026-07-07T00:00:01.000Z' },
        ],
        activeTurnId: 'turn-x',
        activeTurnStatus: 'running',
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

      const restoredTurn = sessions.get('planning-interrupted-turn');
      expect(restoredTurn?.activeTurnId).toBe('turn-x');
      expect(restoredTurn?.activeTurnStatus).toBe('failed');
      expect(restoredTurn?.activeTurnError).toBe(INTERRUPTED_TURN_SYSTEM_LINE.text);
      expect(restoredTurn?.messages.at(-1)).toMatchObject(INTERRUPTED_TURN_SYSTEM_LINE);
      const persisted = adapter.loadInAppPlanningSession('planning-interrupted-turn');
      expect(persisted?.activeTurnId).toBe('turn-x');
      expect(persisted?.activeTurnStatus).toBe('failed');
      expect(persisted?.pendingResponse).toBe(false);
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

describe('planning chat worktree provisioning', () => {
  const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

  function createFakeRepoPool(
    worktreePath: string,
  ): PlanningRepoPool & { release: ReturnType<typeof vi.fn>; softRelease: ReturnType<typeof vi.fn> } {
    const release = vi.fn(async () => {});
    const softRelease = vi.fn();
    const acquireWorktree = vi.fn(async (_repoUrl: string, branch: string) => ({
      clonePath: '/fake/clone',
      worktreePath,
      branch,
      release,
      softRelease,
    }));
    return {
      ensureCloneThroughRepoQueue: vi.fn(async () => '/fake/clone'),
      resolveBaseCommit: vi.fn(async () => 'fake-head-sha'),
      acquireWorktree,
      externalWorktreePath: vi.fn(() => worktreePath),
      release,
      softRelease,
    };
  }

  it('provisions a worktree and persists the binding fields when repoPool + config.defaultRepoUrl are set', async () => {
    const worktreePath = '/fake/worktree/create-session';
    const repoPool = createFakeRepoPool(worktreePath);
    const sessions = createInAppPlanningChatSessions();
    const upsert = vi.fn();

    const created = await createPlanningChatSession({}, {
      config: { defaultRepoUrl: 'https://example.com/repo.git', defaultBranch: 'main' },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
      repoPool,
      planningSessionStore: {
        upsertInAppPlanningSession: upsert,
        updateInAppPlanningSession: vi.fn(),
        deleteInAppPlanningSession: vi.fn(),
      },
    });
    if (!created.ok) throw new Error(created.error);
    const sessionId = created.session.id;
    const expectedBranch = `invoker/planning/${sessionId}`;

    expect(created.session.repoUrl).toBe('https://example.com/repo.git');
    expect(created.session.baseBranch).toBe('main');
    expect(created.session.baseCommit).toBe('fake-head-sha');
    expect((created.session as { worktreePath?: string }).worktreePath).toBeUndefined();
    expect((created.session as { worktreeBranch?: string }).worktreeBranch).toBeUndefined();

    expect(repoPool.ensureCloneThroughRepoQueue).toHaveBeenCalledWith('https://example.com/repo.git');
    expect(repoPool.resolveBaseCommit).toHaveBeenCalledWith('https://example.com/repo.git', 'main');
    expect(repoPool.acquireWorktree).toHaveBeenCalledWith(
      'https://example.com/repo.git',
      expectedBranch,
      'fake-head-sha',
      sessionId,
    );
    expect(repoPool.softRelease).toHaveBeenCalledTimes(1);

    const session = sessions.get(sessionId);
    expect(session?.repoUrl).toBe('https://example.com/repo.git');
    expect(session?.baseBranch).toBe('main');
    expect(session?.baseCommit).toBe('fake-head-sha');
    expect(session?.worktreePath).toBe(worktreePath);
    expect(session?.worktreeBranch).toBe(expectedBranch);
    expect(session?.conversation.workingDir).toBe(worktreePath);

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      repoUrl: 'https://example.com/repo.git',
      baseBranch: 'main',
      baseCommit: 'fake-head-sha',
      worktreePath,
      worktreeBranch: expectedBranch,
    }));
  });

  it('preserves repo binding fields across the summary-to-hydrated-session round trip', async () => {
    const worktreePath = '/fake/worktree/hydrate-round-trip';
    const repoPool = createFakeRepoPool(worktreePath);
    const sessions = createInAppPlanningChatSessions();

    const created = await createPlanningChatSession({}, {
      config: { defaultRepoUrl: 'https://example.com/repo.git', defaultBranch: 'main' },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
      repoPool,
    });
    if (!created.ok) throw new Error(created.error);

    const hydrated = hydrateRemotePlanningTerminalSession(created.session);
    expect(hydrated.repoUrl).toBe('https://example.com/repo.git');
    expect(hydrated.baseBranch).toBe('main');
    expect(hydrated.baseCommit).toBe('fake-head-sha');
  });

  it('preserves a terminalSessionId-present/terminalStatus-absent divergence verbatim across hydration', async () => {
    const sessions = createInAppPlanningChatSessions();
    const created = await createPlanningChatSession({}, {
      config: { defaultRepoUrl: 'https://example.com/repo.git', defaultBranch: 'main' },
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
    });
    if (!created.ok) throw new Error(created.error);

    const ambiguousSummary = {
      ...created.session,
      terminalSessionId: 'term-ambiguous',
      terminalStatus: undefined,
    };
    const hydrated = hydrateRemotePlanningTerminalSession(ambiguousSummary);
    expect(hydrated.terminalSessionId).toBe('term-ambiguous');
    expect(hydrated.terminalStatus).toBeUndefined();
  });

  it('falls back to deps.workingDir exactly as before when no repoPool is supplied', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'in-app-no-repo-pool-'));
    try {
      const sessions = createInAppPlanningChatSessions();
      const created = await createPlanningChatSession({}, {
        config: { defaultRepoUrl: 'https://example.com/repo.git', defaultBranch: 'main' },
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        workingDir,
      });
      if (!created.ok) throw new Error(created.error);
      const session = sessions.get(created.session.id);
      expect(session?.repoUrl).toBeUndefined();
      expect(session?.baseBranch).toBeUndefined();
      expect(session?.baseCommit).toBeUndefined();
      expect(session?.worktreePath).toBeUndefined();
      expect(session?.worktreeBranch).toBeUndefined();
      expect(session?.conversation.workingDir).toBe(workingDir);
      expect(created.session.repoUrl).toBeUndefined();
      expect(created.session.baseBranch).toBeUndefined();
      expect(created.session.baseCommit).toBeUndefined();
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('falls back to deps.workingDir when repoPool is set but no defaultRepoUrl is configured', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'in-app-no-default-repo-'));
    try {
      const repoPool = createFakeRepoPool('/fake/should-not-be-used');
      const sessions = createInAppPlanningChatSessions();
      const created = await createPlanningChatSession({}, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        workingDir,
        repoPool,
      });
      if (!created.ok) throw new Error(created.error);
      expect(repoPool.acquireWorktree).not.toHaveBeenCalled();
      const session = sessions.get(created.session.id);
      expect(session?.worktreePath).toBeUndefined();
      expect(session?.conversation.workingDir).toBe(workingDir);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('restore reconstructs a missing worktree for a session that has one recorded', async () => {
    const worktreePath = '/fake/worktree/restore-missing';
    const repoPool = createFakeRepoPool(worktreePath);
    repoPool.externalWorktreePath = vi.fn(() => '/fake/worktree/restore-missing-nonexistent');

    const record: InAppPlanningSessionRecord = {
      id: 'planning-worktree-restore',
      title: 'Restored plan with worktree',
      presetKey: 'codex',
      status: 'still_discussing',
      confirmationMode: 'require',
      repoUrl: 'https://example.com/repo.git',
      baseBranch: 'main',
      baseCommit: 'stored-base-commit',
      worktreePath: '/fake/worktree/restore-missing-nonexistent',
      worktreeBranch: 'invoker/planning/planning-worktree-restore',
      messages: [],
      pendingResponse: false,
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:00.000Z',
    };

    const sessions = createInAppPlanningChatSessions();
    await restorePlanningChatSessions([record], {
      config: {},
      loadGeneratedPlan: vi.fn(),
      sessions,
      planningCommandBuilder,
      repoPool,
    });

    expect(repoPool.acquireWorktree).toHaveBeenCalledWith(
      'https://example.com/repo.git',
      'invoker/planning/planning-worktree-restore',
      'stored-base-commit',
      'planning-worktree-restore',
    );
    expect(repoPool.resolveBaseCommit).not.toHaveBeenCalled();
    const session = sessions.get('planning-worktree-restore');
    expect(session?.worktreePath).toBe(worktreePath);
    expect(session?.conversation.workingDir).toBe(worktreePath);
  });

  it('restore leaves worktreePath untouched when the recorded path already exists on disk', async () => {
    const existingWorktreePath = mkdtempSync(join(tmpdir(), 'in-app-restore-present-'));
    try {
      const repoPool = createFakeRepoPool(existingWorktreePath);
      repoPool.externalWorktreePath = vi.fn(() => existingWorktreePath);

      const record: InAppPlanningSessionRecord = {
        id: 'planning-worktree-present',
        title: 'Restored plan with existing worktree',
        presetKey: 'codex',
        status: 'still_discussing',
        confirmationMode: 'require',
        repoUrl: 'https://example.com/repo.git',
        baseBranch: 'main',
        baseCommit: 'stored-base-commit',
        worktreePath: existingWorktreePath,
        worktreeBranch: 'invoker/planning/planning-worktree-present',
        messages: [],
        pendingResponse: false,
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:00.000Z',
      };

      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([record], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        repoPool,
      });

      expect(repoPool.acquireWorktree).not.toHaveBeenCalled();
      const session = sessions.get('planning-worktree-present');
      expect(session?.worktreePath).toBe(existingWorktreePath);
      expect(session?.conversation.workingDir).toBe(existingWorktreePath);
    } finally {
      rmSync(existingWorktreePath, { recursive: true, force: true });
    }
  });

  it('writes a .mcp.json with the invoker MCP server into a freshly provisioned worktree', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'in-app-mcp-config-'));
    try {
      const repoPool = createFakeRepoPool(worktreePath);
      const sessions = createInAppPlanningChatSessions();

      const created = await createPlanningChatSession({}, {
        config: { defaultRepoUrl: 'https://example.com/repo.git', defaultBranch: 'main' },
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        repoPool,
      });
      if (!created.ok) throw new Error(created.error);

      const mcpConfigPath = join(worktreePath, '.mcp.json');
      expect(existsSync(mcpConfigPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      expect(parsed.mcpServers.invoker.command).toBe('invoker-cli');
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('writes a .mcp.json when recreating a wiped worktree during restore', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'in-app-mcp-config-restore-'));
    try {
      const repoPool = createFakeRepoPool(worktreePath);
      repoPool.externalWorktreePath = vi.fn(() => '/fake/worktree/restore-mcp-nonexistent');

      const record: InAppPlanningSessionRecord = {
        id: 'planning-mcp-restore',
        title: 'Restored plan with mcp config',
        presetKey: 'codex',
        status: 'still_discussing',
        confirmationMode: 'require',
        repoUrl: 'https://example.com/repo.git',
        baseBranch: 'main',
        baseCommit: 'stored-base-commit',
        worktreePath: '/fake/worktree/restore-mcp-nonexistent',
        worktreeBranch: 'invoker/planning/planning-mcp-restore',
        messages: [],
        pendingResponse: false,
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:00.000Z',
      };

      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([record], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        repoPool,
      });

      const mcpConfigPath = join(worktreePath, '.mcp.json');
      expect(existsSync(mcpConfigPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      expect(parsed.mcpServers.invoker.command).toBe('invoker-cli');
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});

describe('rebindPlanningChatRepo', () => {
  function sidecarPathFor(sessionId: string): string {
    return join(resolveInvokerHomeRoot(), 'plan-drafts', `${sessionId}.yaml`);
  }

  function createFakeRebindRepoPool(
    worktreePath: string,
    headSha: string,
  ): PlanningRepoPool & { release: ReturnType<typeof vi.fn>; softRelease: ReturnType<typeof vi.fn> } {
    const release = vi.fn(async () => {});
    const softRelease = vi.fn();
    const acquireWorktree = vi.fn(async (_repoUrl: string, branch: string) => ({
      clonePath: '/fake/clone',
      worktreePath,
      branch,
      release,
      softRelease,
    }));
    return {
      ensureCloneThroughRepoQueue: vi.fn(async () => '/fake/clone'),
      resolveBaseCommit: vi.fn(async () => headSha),
      acquireWorktree,
      externalWorktreePath: vi.fn(() => worktreePath),
      release,
      softRelease,
    };
  }

  it('returns reuse and leaves the session untouched when the requested binding is unchanged', async () => {
    const repoPool = createFakeRebindRepoPool('/fake/worktree/should-not-be-used', 'sha-a');
    const sessions = createInAppPlanningChatSessions();
    const session = planningSession({
      id: 'reuse-session',
      title: 'Reuse test',
      repoUrl: 'https://example.com/repo.git',
      baseBranch: 'main',
      baseCommit: 'sha-a',
      worktreePath: '/fake/worktree/existing-reuse',
      worktreeBranch: 'invoker/planning/reuse-session',
    });
    const originalConversation = session.conversation;
    sessions.set(session.id, session);

    const result = await rebindPlanningChatRepo({
      sessionId: session.id,
      repoUrl: 'https://example.com/repo.git',
      baseBranch: 'main',
    }, {
      config: {},
      sessions,
      repoPool,
    });

    expect(result).toEqual({ ok: true, action: 'reuse' });
    expect(repoPool.acquireWorktree).not.toHaveBeenCalled();
    const stored = sessions.get(session.id);
    expect(stored?.repoUrl).toBe('https://example.com/repo.git');
    expect(stored?.baseBranch).toBe('main');
    expect(stored?.baseCommit).toBe('sha-a');
    expect(stored?.worktreePath).toBe('/fake/worktree/existing-reuse');
    expect(stored?.worktreeBranch).toBe('invoker/planning/reuse-session');
    expect(stored?.conversation).toBe(originalConversation);
  });

  it('provisions a new worktree and constructs a fresh conversation when there is no prior binding', async () => {
    const worktreePath = '/fake/worktree/provision-session';
    const repoPool = createFakeRebindRepoPool(worktreePath, 'new-head-sha');
    const sessions = createInAppPlanningChatSessions();
    const session = planningSession({
      id: 'provision-session',
      title: 'Provision test',
    });
    const originalConversation = session.conversation;
    sessions.set(session.id, session);

    const result = await rebindPlanningChatRepo({
      sessionId: session.id,
      repoUrl: 'https://example.com/new-repo.git',
      baseBranch: 'main',
    }, {
      config: {},
      sessions,
      repoPool,
    });

    expect(result).toEqual({ ok: true, action: 'provision' });
    expect(repoPool.acquireWorktree).toHaveBeenCalledWith(
      'https://example.com/new-repo.git',
      'invoker/planning/provision-session',
      'new-head-sha',
      'provision-session',
    );
    const stored = sessions.get(session.id);
    expect(stored?.repoUrl).toBe('https://example.com/new-repo.git');
    expect(stored?.baseBranch).toBe('main');
    expect(stored?.baseCommit).toBe('new-head-sha');
    expect(stored?.worktreePath).toBe(worktreePath);
    expect(stored?.worktreeBranch).toBe('invoker/planning/provision-session');
    expect(stored?.conversation).not.toBe(originalConversation);
    expect(stored?.conversation.workingDir).toBe(worktreePath);
  });

  it('writes a .mcp.json into the newly provisioned worktree when rebinding', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'in-app-rebind-mcp-config-'));
    try {
      const repoPool = createFakeRebindRepoPool(worktreePath, 'new-head-sha');
      const sessions = createInAppPlanningChatSessions();
      const session = planningSession({
        id: 'rebind-mcp-session',
        title: 'Rebind mcp test',
      });
      sessions.set(session.id, session);

      const result = await rebindPlanningChatRepo({
        sessionId: session.id,
        repoUrl: 'https://example.com/new-repo.git',
        baseBranch: 'main',
      }, {
        config: {},
        sessions,
        repoPool,
      });

      expect(result).toEqual({ ok: true, action: 'provision' });
      const mcpConfigPath = join(worktreePath, '.mcp.json');
      expect(existsSync(mcpConfigPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      expect(parsed.mcpServers.invoker.command).toBe('invoker-cli');
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('invalidates and clears a draft (session, DB, and sidecar) when rebinding to a different repo', async () => {
    const worktreePath = '/fake/worktree/invalidate-session';
    const repoPool = createFakeRebindRepoPool(worktreePath, 'new-head-sha');
    const sessions = createInAppPlanningChatSessions();
    const adapter = await SQLiteAdapter.create(':memory:');
    const sessionId = 'invalidate-session';
    try {
      const session = planningSession({
        id: sessionId,
        title: 'Invalidate test',
        status: 'draft_ready',
        repoUrl: 'https://example.com/repo.git',
        baseBranch: 'main',
        baseCommit: 'sha-a',
        worktreePath: '/fake/worktree/existing-invalidate',
        worktreeBranch: `invoker/planning/${sessionId}`,
        draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First task', 'Second task'] },
        draftPlanText: VALID_PLAN_TEXT,
      });
      sessions.set(sessionId, session);

      adapter.upsertInAppPlanningSession({
        id: sessionId,
        title: session.title,
        presetKey: session.presetKey,
        status: session.status,
        confirmationMode: session.confirmationMode,
        repoUrl: session.repoUrl,
        baseBranch: session.baseBranch,
        baseCommit: session.baseCommit,
        worktreePath: session.worktreePath,
        worktreeBranch: session.worktreeBranch,
        messages: session.messages,
        draftPlanSummary: session.draftPlanSummary,
        draftPlanText: session.draftPlanText,
        pendingResponse: false,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });

      mkdirSync(dirname(sidecarPathFor(sessionId)), { recursive: true });
      writeFileSync(sidecarPathFor(sessionId), VALID_PLAN_TEXT, 'utf8');
      expect(existsSync(sidecarPathFor(sessionId))).toBe(true);

      const result = await rebindPlanningChatRepo({
        sessionId,
        repoUrl: 'https://example.com/other-repo.git',
        baseBranch: 'main',
      }, {
        config: {},
        sessions,
        planningSessionStore: adapter,
        repoPool,
      });

      expect(result).toEqual({ ok: true, action: 'invalidate_and_block_submit' });
      const stored = sessions.get(sessionId);
      expect(stored?.draftPlanText).toBeUndefined();
      expect(stored?.draftPlanSummary).toBeUndefined();
      expect(stored?.status).toBe('still_discussing');
      expect(stored?.repoUrl).toBe('https://example.com/other-repo.git');
      expect(stored?.baseCommit).toBe('new-head-sha');
      expect(stored?.worktreePath).toBe(worktreePath);
      const invalidateMessage = stored?.messages.at(-1);
      expect(invalidateMessage?.text).toBe(
        'The target repository changed. The previous draft was cleared — ask Invoker to draft it again.',
      );
      expect(invalidateMessage?.tone).toBe('error');

      const persisted = adapter.loadInAppPlanningSession(sessionId);
      expect(persisted?.draftPlanText).toBeUndefined();
      expect(existsSync(sidecarPathFor(sessionId))).toBe(false);
    } finally {
      rmSync(sidecarPathFor(sessionId), { force: true });
      adapter.close();
    }
  });

  it('returns an error when the session is missing', async () => {
    const sessions = createInAppPlanningChatSessions();
    const repoPool = createFakeRebindRepoPool('/fake/worktree/should-not-be-used', 'sha-a');

    const result = await rebindPlanningChatRepo({ sessionId: 'does-not-exist' }, {
      config: {},
      sessions,
      repoPool,
    });

    expect(result).toEqual({ ok: false, error: 'No planning conversation yet.' });
  });

  it('returns an error when no repoPool is configured', async () => {
    const sessions = createInAppPlanningChatSessions();
    const session = planningSession({ id: 'no-pool-session', title: 'No pool' });
    sessions.set(session.id, session);

    const result = await rebindPlanningChatRepo({ sessionId: session.id }, {
      config: {},
      sessions,
    });

    expect(result).toEqual({ ok: false, error: 'Worktree provisioning is not available.' });
  });

  it('rejects rebinding a submitted session without touching repo state', async () => {
    const repoPool = createFakeRebindRepoPool('/fake/worktree/should-not-be-used', 'new-head-sha');
    const sessions = createInAppPlanningChatSessions();
    const session = planningSession({
      id: 'submitted-rebind-session',
      title: 'Submitted rebind',
      status: 'submitted',
      repoUrl: 'https://example.com/repo.git',
      baseBranch: 'main',
      baseCommit: 'sha-a',
      worktreePath: '/fake/worktree/existing-submitted',
      worktreeBranch: 'invoker/planning/submitted-rebind-session',
      submittedPlanName: 'Submitted plan',
      submittedWorkflowId: 'wf-submitted',
    });
    const originalConversation = session.conversation;
    sessions.set(session.id, session);

    const result = await rebindPlanningChatRepo({
      sessionId: session.id,
      repoUrl: 'https://example.com/other-repo.git',
      baseBranch: 'main',
    }, {
      config: {},
      sessions,
      repoPool,
    });

    expect(result).toEqual({
      ok: false,
      error: 'This planning session was already submitted. Start a new planning chat for changes.',
    });
    expect(repoPool.ensureCloneThroughRepoQueue).not.toHaveBeenCalled();
    expect(repoPool.resolveBaseCommit).not.toHaveBeenCalled();
    expect(repoPool.acquireWorktree).not.toHaveBeenCalled();
    expect(repoPool.release).not.toHaveBeenCalled();

    const stored = sessions.get(session.id);
    expect(stored?.repoUrl).toBe('https://example.com/repo.git');
    expect(stored?.baseBranch).toBe('main');
    expect(stored?.baseCommit).toBe('sha-a');
    expect(stored?.worktreePath).toBe('/fake/worktree/existing-submitted');
    expect(stored?.worktreeBranch).toBe('invoker/planning/submitted-rebind-session');
    expect(stored?.conversation).toBe(originalConversation);
  });

  it('rejects rebinding once the conversation has a message', async () => {
    const repoPool = createFakeRebindRepoPool('/fake/worktree/should-not-be-used', 'new-head-sha');
    const sessions = createInAppPlanningChatSessions();
    const session = planningSession({
      id: 'message-rebind-session',
      title: 'Message rebind',
      repoUrl: 'https://example.com/repo.git',
      baseBranch: 'main',
      baseCommit: 'sha-a',
      worktreePath: '/fake/worktree/existing-message',
      worktreeBranch: 'invoker/planning/message-rebind-session',
      messages: [
        { id: 1, role: 'user', text: 'What does this repo do?', createdAt: '2026-07-07T00:00:01.000Z' },
      ],
    });
    const originalConversation = session.conversation;
    sessions.set(session.id, session);

    const result = await rebindPlanningChatRepo({
      sessionId: session.id,
      repoUrl: 'https://example.com/other-repo.git',
      baseBranch: 'main',
    }, {
      config: {},
      sessions,
      repoPool,
    });

    expect(result).toEqual({
      ok: false,
      error: 'Set the repo before the conversation or terminal starts.',
    });
    expect(repoPool.ensureCloneThroughRepoQueue).not.toHaveBeenCalled();
    expect(repoPool.acquireWorktree).not.toHaveBeenCalled();
    expect(repoPool.release).not.toHaveBeenCalled();

    const stored = sessions.get(session.id);
    expect(stored?.repoUrl).toBe('https://example.com/repo.git');
    expect(stored?.baseCommit).toBe('sha-a');
    expect(stored?.worktreePath).toBe('/fake/worktree/existing-message');
    expect(stored?.conversation).toBe(originalConversation);
  });

  it('rejects rebinding once a terminal session exists', async () => {
    const repoPool = createFakeRebindRepoPool('/fake/worktree/should-not-be-used', 'new-head-sha');
    const sessions = createInAppPlanningChatSessions();
    const session = planningSession({
      id: 'terminal-rebind-session',
      title: 'Terminal rebind',
      repoUrl: 'https://example.com/repo.git',
      baseBranch: 'main',
      baseCommit: 'sha-a',
      worktreePath: '/fake/worktree/existing-terminal',
      worktreeBranch: 'invoker/planning/terminal-rebind-session',
      terminalMode: 'tmux',
      terminalSessionId: 'term-planning-rebind',
    });
    const originalConversation = session.conversation;
    sessions.set(session.id, session);

    const result = await rebindPlanningChatRepo({
      sessionId: session.id,
      repoUrl: 'https://example.com/other-repo.git',
      baseBranch: 'main',
    }, {
      config: {},
      sessions,
      repoPool,
    });

    expect(result).toEqual({
      ok: false,
      error: 'Set the repo before the conversation or terminal starts.',
    });
    expect(repoPool.ensureCloneThroughRepoQueue).not.toHaveBeenCalled();
    expect(repoPool.acquireWorktree).not.toHaveBeenCalled();

    const stored = sessions.get(session.id);
    expect(stored?.repoUrl).toBe('https://example.com/repo.git');
    expect(stored?.baseCommit).toBe('sha-a');
    expect(stored?.worktreePath).toBe('/fake/worktree/existing-terminal');
    expect(stored?.conversation).toBe(originalConversation);
  });

  it('rebinds an untouched session with a prior binding to a different repo', async () => {
    const worktreePath = '/fake/worktree/retarget-session';
    const repoPool = createFakeRebindRepoPool(worktreePath, 'new-head-sha');
    const sessions = createInAppPlanningChatSessions();
    const session = planningSession({
      id: 'retarget-session',
      title: 'Retarget test',
      repoUrl: 'https://example.com/repo.git',
      baseBranch: 'main',
      baseCommit: 'sha-a',
      worktreePath: '/fake/worktree/existing-retarget',
      worktreeBranch: 'invoker/planning/retarget-session',
    });
    sessions.set(session.id, session);

    const result = await rebindPlanningChatRepo({
      sessionId: session.id,
      repoUrl: 'https://example.com/other-repo.git',
      baseBranch: 'main',
    }, {
      config: {},
      sessions,
      repoPool,
    });

    expect(result).toEqual({ ok: true, action: 'provision' });
    const stored = sessions.get(session.id);
    expect(stored?.repoUrl).toBe('https://example.com/other-repo.git');
    expect(stored?.baseCommit).toBe('new-head-sha');
    expect(stored?.worktreePath).toBe(worktreePath);
  });

  it('threads the planning command builder into the rebuilt conversation', async () => {
    const worktreePath = '/fake/worktree/builder-session';
    const repoPool = createFakeRebindRepoPool(worktreePath, 'new-head-sha');
    const sessions = createInAppPlanningChatSessions();
    const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));
    const session = planningSession({ id: 'builder-session', title: 'Builder test' });
    sessions.set(session.id, session);

    const result = await rebindPlanningChatRepo({
      sessionId: session.id,
      repoUrl: 'https://example.com/new-repo.git',
      baseBranch: 'main',
    }, {
      config: {},
      sessions,
      repoPool,
      planningCommandBuilder,
    });

    expect(result).toEqual({ ok: true, action: 'provision' });
    const stored = sessions.get(session.id);
    // Without the builder the conversation falls back to spawning the literal
    // `agent` CLI, which does not exist on headless hosts.
    const conversation = stored?.conversation as unknown as { planningCommandBuilder?: unknown };
    expect(conversation.planningCommandBuilder).toBe(planningCommandBuilder);
  });

  it('returns an error when no repo URL can be resolved', async () => {
    const repoPool = createFakeRebindRepoPool('/fake/worktree/should-not-be-used', 'sha-a');
    const sessions = createInAppPlanningChatSessions();
    const session = planningSession({ id: 'no-repo-session', title: 'No repo' });
    sessions.set(session.id, session);

    const result = await rebindPlanningChatRepo({ sessionId: session.id }, {
      config: {},
      sessions,
      repoPool,
    });

    expect(result).toEqual({ ok: false, error: 'No repository specified.' });
    expect(repoPool.ensureCloneThroughRepoQueue).not.toHaveBeenCalled();
  });
});

describe('plan draft sidecar mirror', () => {
  const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

  function sidecarPathFor(sessionId: string): string {
    return join(resolveInvokerHomeRoot(), 'plan-drafts', `${sessionId}.yaml`);
  }

  it('writes the sidecar file to match the DB-persisted draft when a draft is approved', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(VALID_PLAN);
    const adapter = await SQLiteAdapter.create(':memory:');
    let sessionId: string | undefined;
    try {
      const sessions = createInAppPlanningChatSessions();
      const sent = await sendPlanningChatMessage({
        message: 'draft',
        presetKey: 'codex',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        planningSessionStore: adapter,
      });
      if (!sent.ok) throw new Error(sent.error);
      sessionId = sent.sessionId;

      const session = sessions.get(sessionId);
      if (!session?.draftPlanText) throw new Error('expected a draft plan on the session');
      const persistedDraftText = adapter.loadInAppPlanningSession(sessionId)?.draftPlanText;
      expect(persistedDraftText).toBe(session.draftPlanText);

      const sidecarPath = sidecarPathFor(sessionId);
      expect(sidecarPath).toContain(join('.invoker', 'test', 'plan-drafts'));
      expect(existsSync(sidecarPath)).toBe(true);
      expect(readFileSync(sidecarPath, 'utf8')).toBe(persistedDraftText);
    } finally {
      if (sessionId) rmSync(sidecarPathFor(sessionId), { force: true });
      adapter.close();
    }
  });

  it('removes the sidecar file when a draft is discarded', async () => {
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue(VALID_PLAN);
    const adapter = await SQLiteAdapter.create(':memory:');
    let sessionId: string | undefined;
    try {
      const sessions = createInAppPlanningChatSessions();
      const sent = await sendPlanningChatMessage({
        message: 'draft',
        presetKey: 'codex',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        planningSessionStore: adapter,
      });
      if (!sent.ok) throw new Error(sent.error);
      sessionId = sent.sessionId;
      expect(existsSync(sidecarPathFor(sessionId))).toBe(true);

      const discarded = discardPlanningChatDraft({ sessionId }, {
        sessions,
        planningSessionStore: adapter,
      });
      expect(discarded).toEqual({ ok: true });
      expect(existsSync(sidecarPathFor(sessionId))).toBe(false);
      expect(adapter.loadInAppPlanningSession(sessionId)?.draftPlanText).toBeUndefined();
    } finally {
      if (sessionId) rmSync(sidecarPathFor(sessionId), { force: true });
      adapter.close();
    }
  });

  it('reconstructs a missing sidecar file for a draft_ready session on restore', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    const sessionId = 'planning-sidecar-restore';
    try {
      const conversationRepo = new ConversationRepository(adapter);
      const record: InAppPlanningSessionRecord = {
        id: sessionId,
        title: 'Restored draft with missing sidecar',
        presetKey: 'codex',
        status: 'draft_ready',
        messages: [
          { id: 1, role: 'user', text: 'Draft it', createdAt: '2026-07-07T00:00:01.000Z' },
          { id: 2, role: 'assistant', text: VALID_PLAN, createdAt: '2026-07-07T00:00:02.000Z' },
        ],
        draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First task', 'Second task'] },
        draftPlanText: VALID_PLAN_TEXT,
        pendingResponse: false,
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:02.000Z',
      };

      expect(existsSync(sidecarPathFor(sessionId))).toBe(false);

      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([record], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo,
        planningSessionStore: adapter,
      });

      const sidecarPath = sidecarPathFor(sessionId);
      expect(existsSync(sidecarPath)).toBe(true);
      expect(readFileSync(sidecarPath, 'utf8')).toBe(VALID_PLAN_TEXT);
    } finally {
      rmSync(sidecarPathFor(sessionId), { force: true });
      adapter.close();
    }
  });

  it('removes the sidecar file when restore invalidates an unreadable draft', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    const sessionId = 'planning-sidecar-invalidated';
    try {
      const conversationRepo = new ConversationRepository(adapter);
      const record: InAppPlanningSessionRecord = {
        id: sessionId,
        title: 'Restored draft that cannot be read',
        presetKey: 'codex',
        status: 'draft_ready',
        messages: [
          { id: 1, role: 'assistant', text: VALID_PLAN, createdAt: '2026-07-07T00:00:01.000Z' },
        ],
        pendingResponse: false,
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:01.000Z',
      };

      mkdirSync(dirname(sidecarPathFor(sessionId)), { recursive: true });
      writeFileSync(sidecarPathFor(sessionId), 'stale sidecar contents', 'utf8');

      const sessions = createInAppPlanningChatSessions();
      await restorePlanningChatSessions([record], {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        conversationRepo,
        planningSessionStore: adapter,
      });

      expect(sessions.get(sessionId)?.status).toBe('still_discussing');
      expect(sessions.get(sessionId)?.draftPlanText).toBeUndefined();
      expect(existsSync(sidecarPathFor(sessionId))).toBe(false);
    } finally {
      rmSync(sidecarPathFor(sessionId), { force: true });
      adapter.close();
    }
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
