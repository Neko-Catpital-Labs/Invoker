import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanConversation } from '../../../surfaces/src/index.ts';
import {
  createInAppPlanningChatSessions,
  createPlanningCommandBuilderFromRegistry,
  listInAppPlanningPresets,
  planFromGoal,
  resetPlanningChat,
  sendPlanningChatMessage,
  submitPlanningChatDraft,
} from '../in-app-planner.js';

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

  it('returns a draft plan summary when the assistant drafts valid YAML', async () => {
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
      reply: [
        'I drafted "Mock Plan". Here is the simple version:',
        '',
        '1. First task',
        '2. Second task',
        '',
        'If this looks right, choose Submit to Invoker.',
      ].join('\n'),
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First task', 'Second task'] },
    });
    expect(result.ok && result.reply).not.toContain('```yaml');
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
    const loadGeneratedPlan = vi.fn().mockResolvedValue({ planName: 'Mock Plan', workflowId: 'wf-1' });

    await expect(submitPlanningChatDraft({
      sessionId: sent.sessionId,
    }, {
      sessions,
      loadGeneratedPlan,
    })).resolves.toEqual({ ok: true, planName: 'Mock Plan', workflowId: 'wf-1' });
    expect(loadGeneratedPlan).toHaveBeenCalledWith(expect.stringContaining('name: Mock Plan'));
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
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockResolvedValue('```yaml\nname: Bad Summary\ntasks:\n  - id: 1\n    description: Numeric id\n```');
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

    await expect(submitPlanningChatDraft({
      sessionId: sent.sessionId,
    }, {
      sessions,
      loadGeneratedPlan: vi.fn(),
    })).resolves.toEqual({ ok: false, error: 'I found a draft plan but could not read it. Ask the AI to regenerate the plan, then submit again.' });
  });

  it('resets a planning chat session', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('session-1', {
      id: 'session-1',
      presetKey: 'codex',
      conversation: new PlanConversation({}),
    });

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
