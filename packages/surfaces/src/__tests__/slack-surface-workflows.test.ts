import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as child_process from 'node:child_process';
import { SlackSurface, parsePlanningRequest, parseLobbyClassification, parseLocalRequest, parseThreadRequest, parseWorkflowStatusQuery, BUILTIN_HARNESS_PRESETS, buildLobbyQuestionPrompt } from '../slack/slack-surface.js';
import { SQLiteAdapter, ConversationRepository, WorkflowChannelRepository } from '@invoker/data-store';
import type { SurfaceCommand } from '../surface.js';
import type { WorkflowContext } from '../slack/workflow-assistant.js';

// ── Mocks ────────────────────────────────────────────────────

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

vi.mock('@slack/bolt', () => {
  class MockApp {
    _eventHandlers: MockHandler[] = [];
    _actionHandlers: MockHandler[] = [];
    _commandHandlers: MockHandler[] = [];
    command = vi.fn((name: string, handler: Function) => { this._commandHandlers.push({ pattern: name, handler }); });
    action = vi.fn((pattern: string | RegExp, handler: Function) => { this._actionHandlers.push({ pattern, handler }); });
    event = vi.fn((name: string, handler: Function) => { this._eventHandlers.push({ pattern: name, handler }); });
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1.1' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
      reactions: { add: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({}) },
      conversations: {
        create: vi.fn().mockResolvedValue({ channel: { id: 'C_NEW' } }),
        invite: vi.fn().mockResolvedValue({}),
        list: vi.fn().mockResolvedValue({ channels: [] }),
      },
    };
  }
  return { App: MockApp };
});

const planConversationConfigs: any[] = [];
let draftedPlanForMock: string | null = null;
vi.mock('../slack/plan-conversation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slack/plan-conversation.js')>();
  return {
    ...actual,
    PlanConversation: vi.fn((config: unknown) => {
      planConversationConfigs.push(config);
      return {
        sendMessage: vi.fn().mockResolvedValue('planner reply'),
        getDraftedPlan: vi.fn(() => draftedPlanForMock),
        submittedPlanText: null,
        planSubmitted: false,
        conversationMode: config?.mode ?? 'plan',
        init: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return { ...actual, spawn: vi.fn() };
});
const mockSpawn = vi.mocked(child_process.spawn);

function mockProcess(stdout: string, exitCode = 0): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  // Defer the emit to the next microtask so the close listener is attached first.
  queueMicrotask(() => {
    proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', exitCode);
  });
  return proc;
}

const silentLog = () => {};

function baseConfig() {
  return {
    botToken: 'xoxb', appToken: 'xapp', signingSecret: 's', channelId: 'CLOBBY', log: silentLog,
  };
}

function mentionHandler(surface: SlackSurface): Function {
  const app = surface.getApp() as any;
  return app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')!.handler;
}

function actionHandler(surface: SlackSurface, id: string): Function {
  const app = surface.getApp() as any;
  return app._actionHandlers.find((h: MockHandler) =>
    typeof h.pattern === 'string' ? h.pattern === id : h.pattern.test(id),
  )!.handler;
}

// ── parsePlanningRequest ─────────────────────────────────────

describe('parsePlanningRequest', () => {
  const keys = ['cursor+claude', 'cursor+codex', 'omp', 'omp+claude', 'codex'];

  it('parses preset + repo tags and request text', () => {
    expect(parsePlanningRequest('<@BOT> [omp+claude] [repo:web] do X', keys, 'cursor+claude')).toEqual({
      presetKey: 'omp+claude',
      repo: 'web',
      text: 'do X',
    });
  });

  it('defaults the preset and leaves repo undefined when no tags', () => {
    expect(parsePlanningRequest('<@BOT> do X', keys, 'cursor+claude')).toEqual({
      presetKey: 'cursor+claude',
      repo: undefined,
      text: 'do X',
    });
  });


  it('normalizes a "plain <tool>" tag and stops at unknown tags', () => {
    expect(parsePlanningRequest('[plain codex] go', keys, 'cursor+claude')).toEqual({
      presetKey: 'codex',
      repo: undefined,
      text: 'go',
    });
    expect(parsePlanningRequest('[unknown] go', keys, 'cursor+claude')).toEqual({
      presetKey: 'cursor+claude',
      repo: undefined,
      text: '[unknown] go',
    });
  });

  it('resolves a bare omp preset', () => {
    expect(parsePlanningRequest('[omp] add a /health endpoint', keys, 'cursor+claude')).toEqual({
      presetKey: 'omp',
      repo: undefined,
      text: 'add a /health endpoint',
    });
  });

  it('flags a tool-shaped tag that matches no preset', () => {
    expect(parsePlanningRequest('[cursor] go', keys, 'cursor+claude')).toEqual({
      presetKey: 'cursor+claude',
      repo: undefined,
      text: 'go',
      unknownPreset: 'cursor',
    });
    expect(parsePlanningRequest('[omp+gpt5] go', keys, 'cursor+claude')).toEqual({
      presetKey: 'cursor+claude',
      repo: undefined,
      text: 'go',
      unknownPreset: 'omp+gpt5',
    });
  });
});

describe('parseLocalRequest', () => {
  it('requires explicit local prefixes', () => {
    expect(parseLocalRequest('run local: report back how many workflows are running')).toEqual({ kind: 'agent', text: 'report back how many workflows are running' });
    expect(parseLocalRequest('exec local: pnpm test')).toEqual({ kind: 'command', text: 'pnpm test' });
    expect(parseLocalRequest('local command: git status')).toEqual({ kind: 'command', text: 'git status' });
    expect(parseLocalRequest('local: fix the Slack typo')).toEqual({ kind: 'change', text: 'fix the Slack typo' });
    expect(parseLocalRequest('patch locally: update the docs')).toEqual({ kind: 'change', text: 'update the docs' });
    expect(parseLocalRequest('fix the Slack typo')).toBeNull();
  });
});


describe('parseWorkflowStatusQuery', () => {
  it('detects workflow count and status questions without an LLM classifier', () => {
    expect(parseWorkflowStatusQuery('report back how many workflows we are running')).toEqual({ intent: 'command', operation: 'status', target: { all: true } });
    expect(parseWorkflowStatusQuery('what is the status of workflows')).toEqual({ intent: 'command', operation: 'status', target: { all: true } });
    expect(parseWorkflowStatusQuery('fix the Slack workflow docs')).toBeNull();
  });
});
describe('parseThreadRequest', () => {
  it('defaults to a normal agent thread and requires an explicit plan prefix for Invoker YAML', () => {
    expect(parseThreadRequest('fix the Slack routing bug')).toEqual({ mode: 'agent', text: 'fix the Slack routing bug' });
    expect(parseThreadRequest('local: fix the Slack routing bug')).toEqual({ mode: 'agent', text: 'fix the Slack routing bug' });
    expect(parseThreadRequest('run local: report back how many workflows are running')).toEqual({ mode: 'agent', text: 'report back how many workflows are running' });
    expect(parseThreadRequest('plan: fix the Slack routing bug')).toEqual({ mode: 'plan', text: 'fix the Slack routing bug' });
    expect(parseThreadRequest('draft an Invoker plan: fix the Slack routing bug')).toEqual({ mode: 'plan', text: 'fix the Slack routing bug' });
  });

  it('treats a sole fenced plan: block as plan mode', () => {
    const fenced = '```text\nplan: Prove and fix the adverse UI test issues\n```';
    expect(parseThreadRequest(fenced)).toEqual({
      mode: 'plan',
      text: 'Prove and fix the adverse UI test issues',
    });
  });

  it('does not treat a fence nested after prose as a plan opt-in', () => {
    const mixed = 'please help\n\n```text\nplan: do not treat this as plan mode\n```';
    expect(parseThreadRequest(mixed)).toEqual({ mode: 'agent', text: mixed });
  });
});

// ── Built-in harness presets ─────────────────────────────────

describe('BUILTIN_HARNESS_PRESETS', () => {
  it('ships an omp+codex preset that runs omp with the codex model', () => {
    expect(BUILTIN_HARNESS_PRESETS['omp+codex']).toEqual({ tool: 'omp', model: 'codex' });
  });

  it('lets a lobby [omp+codex] tag select the omp+codex preset', () => {
    const keys = Object.keys(BUILTIN_HARNESS_PRESETS);
    expect(parsePlanningRequest('<@BOT> [omp+codex] add a /health endpoint', keys, 'cursor+claude')).toEqual({
      presetKey: 'omp+codex',
      repo: undefined,
      text: 'add a /health endpoint',
    });
  });
});

// ── Harness routing ──────────────────────────────────────────

describe('harness routing', () => {
  beforeEach(() => { planConversationConfigs.length = 0; });

  it('constructs the planning conversation with the preset tool/model and injected builder', async () => {
    const builder = vi.fn(() => ({ command: 'cursor', args: [] }));
    const surface = new SlackSurface({ ...baseConfig(), planningCommandBuilder: builder });
    await surface.start(async () => {});

    await mentionHandler(surface)({
      event: { text: '<@BOT> [cursor+codex] add a /health endpoint', ts: 't1', user: 'U1' },
      say: vi.fn().mockResolvedValue({ ts: 'ack' }),
    });

    const cfg = planConversationConfigs.at(-1);
    expect(cfg.tool).toBe('cursor');
    expect(cfg.model).toBe('codex');
    expect(cfg.planningCommandBuilder).toBe(builder);
  });
});

// ── Channel creation ─────────────────────────────────────────

describe('workflow channel creation', () => {
  let adapter: SQLiteAdapter;
  let repo: WorkflowChannelRepository;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new WorkflowChannelRepository(adapter);
  });

  it('creates a private channel, invites the requester, persists, and posts both places', async () => {
    const surface = new SlackSurface({ ...baseConfig(), workflowChannelRepo: repo });
    const client = (surface.getApp() as any).client;

    await surface.handleEvent({
      type: 'workflow_created', workflowId: 'wf-1-2', requestedBy: 'U1',
      lobbyChannel: 'CLOBBY', lobbyThreadTs: 't1', harnessPreset: 'omp+claude', repoUrl: 'r',
    });

    expect(client.conversations.create).toHaveBeenCalledWith({ name: 'workflow-1-2', is_private: true });
    expect(client.conversations.invite).toHaveBeenCalledWith({ channel: 'C_NEW', users: 'U1' });
    expect(repo.getByWorkflowId('wf-1-2')?.channelId).toBe('C_NEW');
    const postChannels = client.chat.postMessage.mock.calls.map((c: any[]) => c[0].channel);
    expect(postChannels).toContain('C_NEW');
    expect(postChannels).toContain('CLOBBY');
  });

  it('reuses an existing channel id on name_taken', async () => {
    const surface = new SlackSurface({ ...baseConfig(), workflowChannelRepo: repo });
    const client = (surface.getApp() as any).client;
    client.conversations.create.mockRejectedValueOnce({ data: { error: 'name_taken' } });
    client.conversations.list.mockResolvedValueOnce({ channels: [{ name: 'workflow-1-2', id: 'C_EXIST' }] });

    await surface.handleEvent({ type: 'workflow_created', workflowId: 'wf-1-2', requestedBy: 'U1' });

    expect(repo.getByWorkflowId('wf-1-2')?.channelId).toBe('C_EXIST');
  });

  it('tells the lobby when the requester invite fails', async () => {
    const surface = new SlackSurface({ ...baseConfig(), workflowChannelRepo: repo });
    const client = (surface.getApp() as any).client;
    client.conversations.invite.mockRejectedValueOnce({ data: { error: 'missing_scope' } });

    await surface.handleEvent({
      type: 'workflow_created', workflowId: 'wf-1-2', requestedBy: 'U1',
      lobbyChannel: 'CLOBBY', lobbyThreadTs: 't1',
    });

    expect(repo.getByWorkflowId('wf-1-2')?.channelId).toBe('C_NEW');
    const lobbyPost = client.chat.postMessage.mock.calls.find((c: any[]) => c[0].channel === 'CLOBBY')?.[0];
    expect(lobbyPost?.text).toContain('could not invite you');
    expect(lobbyPost?.text).toContain('missing_scope');
    expect(lobbyPost?.text).not.toBe('Created <#C_NEW> for workflow `wf-1-2`.');
  });
});

// ── Outbound routing ─────────────────────────────────────────

describe('outbound routing', () => {
  let adapter: SQLiteAdapter;
  let repo: WorkflowChannelRepository;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new WorkflowChannelRepository(adapter);
    repo.save({ workflowId: 'wf-1-2', channelId: 'C123', createdAt: new Date().toISOString() });
  });

  it('posts a mapped workflow delta to its channel', async () => {
    const surface = new SlackSurface({ ...baseConfig(), workflowChannelRepo: repo });
    const client = (surface.getApp() as any).client;
    await surface.handleEvent({
      type: 'task_delta',
      delta: { type: 'updated', taskId: 'wf-1-2/api', changes: { status: 'running' }, taskStateVersion: 1, previousTaskStateVersion: 0 },
    });
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C123' }));
  });

  it('falls back to the lobby channel for an unmapped workflow', async () => {
    const surface = new SlackSurface({ ...baseConfig(), workflowChannelRepo: repo });
    const client = (surface.getApp() as any).client;
    await surface.handleEvent({
      type: 'task_delta',
      delta: { type: 'updated', taskId: 'wf-9/api', changes: { status: 'running' }, taskStateVersion: 1, previousTaskStateVersion: 0 },
    });
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'CLOBBY' }));
  });
  it('posts a replacement progress card when chat.update rejects invalid_blocks', async () => {
    const surface = new SlackSurface({ ...baseConfig(), workflowChannelRepo: repo });
    const client = (surface.getApp() as any).client;
    client.chat.postMessage
      .mockResolvedValueOnce({ ts: 'progress-1' })
      .mockResolvedValueOnce({ ts: 'progress-2' });

    const progress = {
      workflowId: 'wf-1-2',
      name: 'Workflow',
      percentComplete: 25,
      counts: { total: 4, completed: 1, failed: 0, closed: 0, running: 1, pending: 2 },
      tasks: [{ id: 'wf-1-2/api', name: 'API', status: 'running', phase: 'executing' }],
    };

    await surface.handleEvent({ type: 'workflow_progress', progress });
    client.chat.update.mockRejectedValueOnce({ data: { error: 'invalid_blocks' } });
    await surface.handleEvent({ type: 'workflow_progress', progress });

    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C123', ts: 'progress-1' }));
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(((surface as any).progressCardTs as Map<string, string>).get('wf-1-2')).toBe('progress-2');
  });

  it('posts a replacement task card when chat.update rejects invalid_blocks', async () => {
    const surface = new SlackSurface({ ...baseConfig(), workflowChannelRepo: repo });
    const client = (surface.getApp() as any).client;
    client.chat.postMessage
      .mockResolvedValueOnce({ ts: 'task-1' })
      .mockResolvedValueOnce({ ts: 'task-2' });

    await surface.handleEvent({
      type: 'task_delta',
      delta: { type: 'updated', taskId: 'wf-1-2/api', changes: { status: 'running' }, taskStateVersion: 1, previousTaskStateVersion: 0 },
    });
    client.chat.update.mockRejectedValueOnce({ data: { error: 'invalid_blocks' } });
    await surface.handleEvent({
      type: 'task_delta',
      delta: { type: 'updated', taskId: 'wf-1-2/api', changes: { status: 'completed', summary: 'done' }, taskStateVersion: 2, previousTaskStateVersion: 1 },
    });

    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C123', ts: 'task-1' }));
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(surface.getTaskMessages().get('wf-1-2/api')).toBe('task-2');
  });

});

// ── In-channel assistant ─────────────────────────────────────

describe('in-channel workflow assistant', () => {
  let adapter: SQLiteAdapter;
  let repo: WorkflowChannelRepository;
  let convoRepo: ConversationRepository;
  let received: SurfaceCommand[];

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new WorkflowChannelRepository(adapter);
    convoRepo = new ConversationRepository(adapter, { info: silentLog, warn: silentLog, error: silentLog });
    repo.save({ workflowId: 'wf-1-2', channelId: 'C123', harnessPreset: 'omp+claude', createdAt: new Date().toISOString() });
    received = [];
    mockSpawn.mockReset();
  });

  function assistantSurface(gather?: (id: string) => Promise<WorkflowContext>) {
    const surface = new SlackSurface({
      ...baseConfig(),
      conversationRepo: convoRepo,
      workflowChannelRepo: repo,
      planningCommandBuilder: () => ({ command: 'cursor', args: ['--print', 'x'] }),
      gatherWorkflowContext: gather,
    });
    return surface;
  }

  it('routes a status verb to get_status scoped to the workflow', async () => {
    const surface = assistantSurface();
    await surface.start(async (cmd) => { received.push(cmd); });
    await mentionHandler(surface)({
      event: { text: '<@BOT> status', ts: 't1', user: 'U1', channel: 'C123' },
      say: vi.fn().mockResolvedValue({ ts: 'a' }),
    });
    expect(received).toContainEqual({ type: 'get_status', workflowId: 'wf-1-2' });
  });

  it('scopes an approve verb to the workflow task id', async () => {
    const surface = assistantSurface();
    await surface.start(async (cmd) => { received.push(cmd); });
    await mentionHandler(surface)({
      event: { text: '<@BOT> approve api', ts: 't1', user: 'U1', channel: 'C123' },
      say: vi.fn().mockResolvedValue({ ts: 'a' }),
    });
    expect(received).toContainEqual({ type: 'approve', taskId: 'wf-1-2/api' });
  });

  it('answers a free-form question only from the gathered workflow context', async () => {
    const gather = vi.fn(async (): Promise<WorkflowContext> => ({
      workflowId: 'wf-1-2',
      planning: [{ role: 'user', content: 'add health endpoint' }],
      tasks: [{ id: 'wf-1-2/api', status: 'completed', agentName: 'omp', transcript: [], output: 'added /health' }],
    }));
    mockSpawn.mockImplementationOnce(() => mockProcess('the api task added /health'));
    const surface = assistantSurface(gather);
    await surface.start(async (cmd) => { received.push(cmd); });
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({
      event: { text: '<@BOT> what did the api task change?', ts: 't1', user: 'U1', channel: 'C123' },
      say,
    });
    expect(gather).toHaveBeenCalledWith('wf-1-2');
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('/health') }));
    expect(received).toHaveLength(0);
  });
});

// ── Lobby classification parsing ─────────────────────────────

function messageHandler(surface: SlackSurface): Function {
  const app = surface.getApp() as any;
  return app._eventHandlers.find((h: MockHandler) => h.pattern === 'message')!.handler;
}

describe('parseLobbyClassification', () => {
  it('maps a bulk rebase-recreate command', () => {
    expect(parseLobbyClassification('{"intent":"command","operation":"rebase-recreate","target":"all"}'))
      .toEqual({ intent: 'command', operation: 'rebase-recreate', target: { all: true } });
  });

  it('maps a single-workflow retry command', () => {
    expect(parseLobbyClassification('{"intent":"command","operation":"retry","target":"wf-123"}'))
      .toEqual({ intent: 'command', operation: 'retry', target: { workflow: 'wf-123' } });
  });

  it('defaults a targetless status command to all workflows', () => {
    expect(parseLobbyClassification('{"intent":"command","operation":"status","target":"none"}'))
      .toEqual({ intent: 'command', operation: 'status', target: { all: true } });
  });

  it('classifies questions and plans', () => {
    expect(parseLobbyClassification('{"intent":"question","operation":"none","target":"none"}'))
      .toEqual({ intent: 'question' });
    expect(parseLobbyClassification('{"intent":"plan","operation":"none","target":"none"}'))
      .toEqual({ intent: 'plan' });
  });

  it('extracts JSON embedded in surrounding prose', () => {
    expect(parseLobbyClassification('Sure: {"intent":"command","operation":"cancel","target":"wf-9"} ok'))
      .toEqual({ intent: 'command', operation: 'cancel', target: { workflow: 'wf-9' } });
  });

  it('falls back to plan on malformed output', () => {
    expect(parseLobbyClassification('not json at all')).toEqual({ intent: 'plan' });
    expect(parseLobbyClassification('{bad json}')).toEqual({ intent: 'plan' });
  });

  it('rejects an unmappable operation as invalid-command', () => {
    expect(parseLobbyClassification('{"intent":"command","operation":"none","target":"all"}'))
      .toEqual({ intent: 'invalid-command' });
    expect(parseLobbyClassification('{"intent":"command","operation":"frobnicate","target":"all"}'))
      .toEqual({ intent: 'invalid-command' });
  });

  it('rejects a non-status mutation with no target as invalid-command', () => {
    expect(parseLobbyClassification('{"intent":"command","operation":"retry","target":"none"}'))
      .toEqual({ intent: 'invalid-command' });
  });
});

// ── Lobby intent routing (command / question / plan) ─────────

describe('lobby verb routing', () => {
  let received: SurfaceCommand[];
  let runWorkflowOp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    planConversationConfigs.length = 0;
    mockSpawn.mockReset();
    received = [];
    runWorkflowOp = vi.fn();
    draftedPlanForMock = null;
  });

  function lobbySurface(withOp = true, extra: Partial<ConstructorParameters<typeof SlackSurface>[0]> = {}) {
    return new SlackSurface({
      ...baseConfig(),
      enableImmediateAck: false,
      planningCommandBuilder: () => ({ command: 'cursor', args: ['--print', 'x'] }),
      ...(withOp ? { runWorkflowOp } : {}),
      ...extra,
    });
  }

  it('asks lobby question answers to be short ELI5 Slack prose except for clearly technical questions', () => {
    const prompt = buildLobbyQuestionPrompt('how many workflows are running?');
    expect(prompt).toContain('ELI5 Slack prose');
    expect(prompt).toContain('40 words or fewer');
    expect(prompt).toContain('clearly technical');
    expect(prompt).toContain('Do NOT generate a YAML plan');
  });

  it('stages a bulk verb for confirmation, then runs it on a plain `yes`', async () => {
    runWorkflowOp.mockResolvedValue({ ok: true, summary: 'recreate: 3 ok' });
    const surface = lobbySurface();
    await surface.start(async (cmd) => { received.push(cmd); });

    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> recreate all workflows', ts: 't1', user: 'U1' }, say });

    // Deterministic verb — no classifier spawn, nothing run yet, just a confirmation.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(planConversationConfigs).toHaveLength(0);
    expect(runWorkflowOp).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('ALL workflows') }));

    const say2 = vi.fn().mockResolvedValue({ ts: 'b' });
    await messageHandler(surface)({ event: { thread_ts: 't1', ts: 't2', user: 'U1', text: 'yes' }, say: say2 });
    expect(runWorkflowOp).toHaveBeenCalledTimes(1);
    expect(runWorkflowOp.mock.calls[0][0]).toEqual({ operation: 'recreate', target: { all: true } });
    expect(say2).toHaveBeenCalledWith(expect.objectContaining({ text: 'recreate: 3 ok' }));
  });

  it('cancels a staged bulk verb on a plain `no`', async () => {
    const surface = lobbySurface();
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> recreate all', ts: 't1', user: 'U1' }, say });

    const say2 = vi.fn().mockResolvedValue({ ts: 'b' });
    await messageHandler(surface)({ event: { thread_ts: 't1', ts: 't2', user: 'U1', text: 'no' }, say: say2 });
    expect(runWorkflowOp).not.toHaveBeenCalled();
    expect(say2).toHaveBeenCalledWith(expect.objectContaining({ text: 'Cancelled.' }));
  });

  it('notifies when a near-yes reply drops a pending approval', async () => {
    const surface = lobbySurface();
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> recreate all', ts: 't1', user: 'U1' }, say });

    const say2 = vi.fn().mockResolvedValue({ ts: 'b' });
    await messageHandler(surface)({
      event: { thread_ts: 't1', ts: 't2', user: 'U1', text: 'yes please add more tests' },
      say: say2,
    });
    expect(runWorkflowOp).not.toHaveBeenCalled();
    expect(say2).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Dropped the pending approval'),
    }));
  });

  it('accepts ok as confirmation for a staged bulk verb', async () => {
    runWorkflowOp.mockResolvedValue({ ok: true, summary: 'recreate: 3 ok' });
    const surface = lobbySurface();
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> recreate all', ts: 't1', user: 'U1' }, say });

    const say2 = vi.fn().mockResolvedValue({ ts: 'b' });
    await messageHandler(surface)({ event: { thread_ts: 't1', ts: 't2', user: 'U1', text: 'ok' }, say: say2 });
    expect(runWorkflowOp).toHaveBeenCalledTimes(1);
    expect(say2).toHaveBeenCalledWith(expect.objectContaining({ text: 'recreate: 3 ok' }));
  });

  it('confirms a bulk verb via the Approve button: acks instantly and posts the result in-thread', async () => {
    runWorkflowOp.mockResolvedValue({ ok: true, summary: 'recreate: 3 ok' });
    const surface = lobbySurface();
    await surface.start(async () => {});
    const app = surface.getApp() as any;

    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> recreate all', ts: 't1', user: 'U1' }, say });
    expect(runWorkflowOp).not.toHaveBeenCalled();

    app.client.chat.postMessage.mockClear();
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await actionHandler(surface, 'lobby_confirm')({
      action: { type: 'button', value: 't1' },
      body: { channel: { id: 'C1' }, message: { thread_ts: 't1' } },
      ack,
      respond,
    });

    expect(ack).toHaveBeenCalled();
    // Buttons are replaced immediately so the click is visibly acknowledged.
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ text: '✅ Approved.', replace_original: true }));
    expect(runWorkflowOp.mock.calls[0][0]).toEqual({ operation: 'recreate', target: { all: true } });
    // The result posts durably in-thread via the bot client, not the expiring response_url.
    expect(app.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', thread_ts: 't1', text: 'recreate: 3 ok' }),
    );
  });

  it('cancels via the Cancel button and clears the buttons', async () => {
    const surface = lobbySurface();
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> recreate all', ts: 't1', user: 'U1' }, say });

    const respond = vi.fn().mockResolvedValue(undefined);
    await actionHandler(surface, 'lobby_cancel')({
      action: { type: 'button', value: 't1' },
      body: {},
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });
    expect(runWorkflowOp).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ text: '❌ Cancelled.', replace_original: true }));
  });

  it('Approve on an expired confirmation reports it and runs nothing', async () => {
    const surface = lobbySurface();
    await surface.start(async () => {});
    const respond = vi.fn().mockResolvedValue(undefined);
    await actionHandler(surface, 'lobby_confirm')({
      action: { type: 'button', value: 'gone' },
      body: { channel: { id: 'C1' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });
    expect(runWorkflowOp).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('expired'), replace_original: true }));
  });

  it('streams live progress into the thread during a bulk op (edits one message)', async () => {
    // Drive onProgress like the host would, then resolve with a summary.
    runWorkflowOp.mockImplementation(async (_op: unknown, onProgress?: (p: unknown) => void) => {
      onProgress?.({ done: 0, total: 3, ok: 0, failed: 0, current: 'wf-a' });
      onProgress?.({ done: 3, total: 3, ok: 3, failed: 0 });
      return { ok: true, summary: 'recreate: 3 ok' };
    });
    const surface = lobbySurface();
    await surface.start(async () => {});
    const app = surface.getApp() as any;

    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> recreate all', ts: 't1', user: 'U1' }, say });

    app.client.chat.update.mockClear();
    app.client.chat.postMessage.mockResolvedValue({ ts: 'onit-ts' });
    await actionHandler(surface, 'lobby_confirm')({
      action: { type: 'button', value: 't1' },
      body: { channel: { id: 'C1' }, message: { thread_ts: 't1' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });

    // The "On it" message is edited in place with the running count, in-thread.
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', ts: 'onit-ts', text: expect.stringContaining('3/3') }),
    );
    // And the final summary still posts.
    expect(app.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', thread_ts: 't1', text: 'recreate: 3 ok' }),
    );
  });

  it('confirms a restart before relaunching Invoker, then reports health', async () => {
    const onRestartInvoker = vi.fn().mockResolvedValue(undefined);
    const surface = lobbySurface(true, { onRestartInvoker });
    await surface.start(async () => {});

    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> restart', ts: 't1', user: 'U1' }, say });
    // Destructive — staged for confirmation, nothing relaunched yet.
    expect(onRestartInvoker).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('restart Invoker') }));

    const say2 = vi.fn().mockResolvedValue({ ts: 'b' });
    await messageHandler(surface)({ event: { thread_ts: 't1', ts: 't2', user: 'U1', text: 'yes' }, say: say2 });
    expect(onRestartInvoker).toHaveBeenCalledTimes(1);
    expect(say2).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Invoker is back') }));
  });

  it('reports a restart failure when the relaunch throws', async () => {
    const onRestartInvoker = vi.fn().mockRejectedValue(new Error('no display'));
    const surface = lobbySurface(true, { onRestartInvoker });
    await surface.start(async () => {});

    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> restart', ts: 't1', user: 'U1' }, say });
    const say2 = vi.fn().mockResolvedValue({ ts: 'b' });
    await messageHandler(surface)({ event: { thread_ts: 't1', ts: 't2', user: 'U1', text: 'yes' }, say: say2 });
    expect(say2).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Restart failed') }));
  });

  it('runs a single-workflow verb immediately (no confirmation)', async () => {
    runWorkflowOp.mockResolvedValue({ ok: true, summary: 'retry: 1 ok' });
    const surface = lobbySurface();
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> retry wf-123', ts: 't1', user: 'U1' }, say });
    expect(runWorkflowOp.mock.calls[0][0]).toEqual({ operation: 'retry', target: { workflow: 'wf-123' } });
    expect(planConversationConfigs).toHaveLength(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('runs status immediately', async () => {
    runWorkflowOp.mockResolvedValue({ ok: true, summary: '`wf-1`: 1 running, 0 pending, 2 done, 0 failed' });
    const surface = lobbySurface();
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> status', ts: 't1', user: 'U1' }, say });
    expect(runWorkflowOp.mock.calls[0][0]).toEqual({ operation: 'status', target: { all: true } });
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('running') }));
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('uses the classifier only for fuzzy operational text, and always confirms before running', async () => {
    mockSpawn.mockImplementationOnce(() => mockProcess('{"intent":"command","operation":"recreate","target":"all"}'));
    runWorkflowOp.mockResolvedValue({ ok: true, summary: 'recreate: 2 ok' });
    const surface = lobbySurface();
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> can you recreate everything please', ts: 't1', user: 'U1' }, say });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(runWorkflowOp).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('recreate') }));

    const say2 = vi.fn().mockResolvedValue({ ts: 'b' });
    await messageHandler(surface)({ event: { thread_ts: 't1', ts: 't2', user: 'U1', text: 'yes' }, say: say2 });
    expect(runWorkflowOp.mock.calls[0][0]).toEqual({ operation: 'recreate', target: { all: true } });
  });

  it('acknowledges a fuzzy operational mention immediately, before the classifier returns', async () => {
    mockSpawn.mockImplementationOnce(() => mockProcess('{"intent":"command","operation":"recreate","target":"all"}'));
    const surface = lobbySurface(true, { enableImmediateAck: true });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'ack-1' });
    await mentionHandler(surface)({ event: { text: '<@BOT> can you recreate everything please', ts: 't1', user: 'U1' }, say });
    // Immediate "processing" receipt posts up front (then is cleared once the confirm is ready).
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: 'Processing your request...', thread_ts: 't1' }));
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('does not post a processing ack for an instant verb', async () => {
    runWorkflowOp.mockResolvedValue({ ok: true, summary: '`wf-1`: 1 running, 0 pending, 0 done, 0 failed' });
    const surface = lobbySurface(true, { enableImmediateAck: true });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> status', ts: 't1', user: 'U1' }, say });
    expect(say).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'Processing your request...' }));
  });

  it('answers a workflow count question with deterministic status', async () => {
    runWorkflowOp.mockResolvedValue({ ok: true, summary: '`wf-1`: 3 running, 0 pending, 0 done, 0 failed' });
    const surface = lobbySurface();
    await surface.start(async (cmd) => { received.push(cmd); });
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> how many workflows are running?', ts: 't1', user: 'U1' }, say });
    expect(runWorkflowOp.mock.calls[0][0]).toEqual({ operation: 'status', target: { all: true } });
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('3 running') }));
    expect(planConversationConfigs).toHaveLength(0);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it('routes a build request to a normal agent thread without classifying', async () => {
    const surface = lobbySurface();
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> add a /health endpoint', ts: 't1', user: 'U1' }, say });
    expect(planConversationConfigs).toHaveLength(1);
    expect(planConversationConfigs[0].mode).toBe('agent');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(runWorkflowOp).not.toHaveBeenCalled();
  });

  it('routes an explicit plan request to an Invoker plan thread', async () => {
    const surface = lobbySurface();
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> plan: add a /health endpoint', ts: 't1', user: 'U1' }, say });
    expect(planConversationConfigs).toHaveLength(1);
    expect(planConversationConfigs[0].mode).toBe('plan');
    expect(runWorkflowOp).not.toHaveBeenCalled();
  });


  it('runs an explicit shell command without creating a plan conversation', async () => {
    mockSpawn.mockImplementationOnce(() => mockProcess('ok'));
    const surface = lobbySurface(true, { adminUserIds: ['U1'] });
    await surface.start(async (cmd) => { received.push(cmd); });
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> exec local: pnpm test -- --run', ts: 't1', user: 'U1' }, say });

    expect(mockSpawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['-lc', 'pnpm test -- --run'],
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    expect(planConversationConfigs).toHaveLength(0);
    expect(runWorkflowOp).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Local command finished: exit 0') }));
  });

  it('routes run local workflow-count questions to deterministic status', async () => {
    runWorkflowOp.mockResolvedValue({ ok: true, summary: '`wf-1`: 1 running, 0 pending, 2 done, 0 failed' });
    const surface = lobbySurface();
    await surface.start(async (cmd) => { received.push(cmd); });
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> run local: report back how many workflows we are running', ts: 't1', user: 'U1' }, say });

    expect(runWorkflowOp.mock.calls[0][0]).toEqual({ operation: 'status', target: { all: true } });
    expect(planConversationConfigs).toHaveLength(0);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('running') }));
  });

  it('routes an explicit local change into a recoverable agent thread', async () => {
    const surface = lobbySurface();
    await surface.start(async (cmd) => { received.push(cmd); });
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> local: fix the Slack routing bug', ts: 't1', user: 'U1' }, say });

    expect(planConversationConfigs).toHaveLength(1);
    expect(planConversationConfigs[0].mode).toBe('agent');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(runWorkflowOp).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });
  it('submit with no drafted plan asks the user to describe one', async () => {
    const surface = lobbySurface();
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> submit', ts: 't1', user: 'U1' }, say });
    expect(received).toHaveLength(0);
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('No Invoker plan draft') }));
  });

  it('submit shows every task in the plan summary and emits start_plan on confirmation', async () => {
    const surface = lobbySurface();
    await surface.start(async (cmd) => { received.push(cmd); });
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    // Open a planning conversation in the thread, then arm its drafted plan.
    await mentionHandler(surface)({ event: { text: '<@BOT> plan: add a /health endpoint', ts: 't1', user: 'U1' }, say });
    draftedPlanForMock = `
name: "Health API rollout with several detailed implementation tasks"
tasks:
  - id: second
    description: "Wire the new /health route through the HTTP server without changing unrelated endpoints or middleware"
    dependencies: [first]
  - id: first
    description: "Add a simple /health endpoint for uptime checks"
    dependencies: []
  - id: third
    description: "Add regression coverage for healthy and unhealthy responses"
    dependencies: [second]
  - id: fourth
    description: "Run the focused surface test suite and record the result"
    dependencies: [third]
`;

    const say2 = vi.fn().mockResolvedValue({ ts: 'b' });
    await mentionHandler(surface)({ event: { text: '<@BOT> submit', thread_ts: 't1', ts: 't2', user: 'U1' }, say: say2 });
    // Shows a deterministic per-task summary in execution order, does not submit yet.
    const confirmationText = say2.mock.calls[0][0].text as string;
    expect(confirmationText).toContain('4 tasks');
    expect(confirmationText).toContain('Add a simple /health endpoint for uptime checks');
    expect(confirmationText).toContain('Wire the new /health route through the HTTP server');
    expect(confirmationText).toContain('Add regression coverage for healthy and unhealthy responses');
    expect(confirmationText).toContain('Run the focused surface test suite and record the result');
    expect(received.some((c) => c.type === 'start_plan')).toBe(false);

    const say3 = vi.fn().mockResolvedValue({ ts: 'c' });
    await messageHandler(surface)({ event: { thread_ts: 't1', ts: 't3', user: 'U1', text: 'yes' }, say: say3 });
    const startPlan = received.find((c) => c.type === 'start_plan') as Extract<SurfaceCommand, { type: 'start_plan' }> | undefined;
    expect(startPlan).toBeDefined();
    expect(startPlan!.planText).toContain('Health API');
  });

  it('reports when workflow operations are not wired in this deployment', async () => {
    const surface = lobbySurface(false);
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> status', ts: 't1', user: 'U1' }, say });
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('not available') }));
  });
});

// ── Local shell command safety (CodeRabbit PR #3028) ─────────

describe('local shell command safety', () => {
  beforeEach(() => {
    planConversationConfigs.length = 0;
    mockSpawn.mockReset();
  });

  it('refuses `exec local:` from a non-admin user (no shell spawn)', async () => {
    const surface = new SlackSurface({ ...baseConfig(), adminUserIds: ['U_ADMIN'] });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> exec local: cat /etc/passwd', ts: 't1', user: 'U_ATTACKER' }, say });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Permission denied') }));
  });

  it('refuses `exec local:` when no admins are configured', async () => {
    const surface = new SlackSurface({ ...baseConfig() });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> exec local: rm -rf /', ts: 't1', user: 'U1' }, say });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Permission denied') }));
  });

  it('runs `[repo:foo] exec local:` in the resolved repo checkout, not the default dir', async () => {
    mockSpawn.mockImplementationOnce(() => mockProcess('ok'));
    const prepareRepoCheckout = vi.fn().mockResolvedValue('/checkouts/foo');
    const surface = new SlackSurface({
      ...baseConfig(),
      adminUserIds: ['U1'],
      workingDir: '/default/dir',
      prepareRepoCheckout,
      repoAliases: { foo: 'git@github.com:me/foo.git' },
    });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> [repo:foo] exec local: pnpm test', ts: 't1', user: 'U1' }, say });

    expect(prepareRepoCheckout).toHaveBeenCalledWith('git@github.com:me/foo.git');
    expect(mockSpawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['-lc', 'pnpm test'],
      expect.objectContaining({ cwd: '/checkouts/foo' }),
    );
  });

  it('caps captured stdout while streaming, before formatting', async () => {
    const surface = new SlackSurface({ ...baseConfig(), adminUserIds: ['U1'] });
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    mockSpawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        const chunk = 'x'.repeat(100_000);
        for (let i = 0; i < 20; i++) proc.stdout.emit('data', Buffer.from(chunk)); // 2,000,000 chars emitted
        proc.emit('close', 0);
      });
      return proc;
    });

    const result = await (surface as any).runLocalCommand('noisy');
    // The fix bounds retained output; the buggy version keeps all 2,000,000 chars.
    expect(result.stdout.length).toBeLessThan(200_000);
  });
});
