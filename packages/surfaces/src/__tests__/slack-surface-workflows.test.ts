import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as child_process from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackSurface, extractRepoUrlFromMessage, parsePlanningRequest, parseLocalRequest, parseWorkflowStatusQuery, BUILTIN_HARNESS_PRESETS } from '../slack/slack-surface.js';
import { SQLiteAdapter, ConversationRepository, SlackSessionRepository, WorkflowChannelRepository } from '@invoker/data-store';
import * as executionEngine from '@invoker/execution-engine';
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
      pins: { add: vi.fn().mockResolvedValue({}) },
      files: { uploadV2: vi.fn().mockResolvedValue({}) },
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
      hasExplicitPreset: true,
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
      hasExplicitPreset: true,
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
      hasExplicitPreset: true,
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

  it('extracts one direct repository URL from Slack markup or prose', () => {
    expect(parsePlanningRequest(
      '<@BOT> plan this in <https://github.com/EdbertChan/notarepo/|notarepo>',
      keys,
      'cursor+claude',
    )).toMatchObject({
      presetKey: 'cursor+claude',
      repositoryUrls: ['https://github.com/EdbertChan/notarepo'],
    });
    expect(parsePlanningRequest(
      'plan this in git@github.com:EdbertChan/notarepo.git',
      keys,
      'cursor+claude',
    )).toMatchObject({
      repositoryUrls: ['git@github.com:EdbertChan/notarepo.git'],
    });
  });
});

describe('extractRepoUrlFromMessage', () => {
  it('extracts wrapped and labeled Slack links', () => {
    expect(extractRepoUrlFromMessage('use <https://github.com/openai/invoker> please')).toBe('https://github.com/openai/invoker');
    expect(extractRepoUrlFromMessage('use <https://github.com/openai/invoker|repo> please')).toBe('https://github.com/openai/invoker');
  });

  it('extracts a plain repo URL', () => {
    expect(extractRepoUrlFromMessage('repo is https://github.com/openai/invoker')).toBe('https://github.com/openai/invoker');
  });

  it('normalizes a trailing slash', () => {
    expect(extractRepoUrlFromMessage('repo is https://github.com/EdbertChan/notarepo/')).toBe('https://github.com/EdbertChan/notarepo');
  });

  it('keeps a .git suffix', () => {
    expect(extractRepoUrlFromMessage('repo is https://github.com/EdbertChan/notarepo.git')).toBe('https://github.com/EdbertChan/notarepo.git');
  });

  it('accepts non-GitHub http URLs only when they end in .git', () => {
    expect(extractRepoUrlFromMessage('repo is https://gitlab.com/openai/invoker')).toBeUndefined();
    expect(extractRepoUrlFromMessage('repo is https://gitlab.com/openai/invoker.git')).toBe('https://gitlab.com/openai/invoker.git');
  });

  it('rejects generic website roots', () => {
    expect(extractRepoUrlFromMessage('details at https://www.onorca.dev')).toBeUndefined();
  });

  it('rejects credential-bearing URLs', () => {
    expect(extractRepoUrlFromMessage('https://token@github.com/openai/invoker')).toBeUndefined();
    expect(extractRepoUrlFromMessage('https://token:secret@github.com/openai/invoker.git')).toBeUndefined();
  });

  it('rejects deep links', () => {
    expect(extractRepoUrlFromMessage('https://github.com/openai/invoker/issues/12')).toBeUndefined();
    expect(extractRepoUrlFromMessage('https://github.com/openai/invoker/pull/5')).toBeUndefined();
    expect(extractRepoUrlFromMessage('https://github.com/openai/invoker/tree/main')).toBeUndefined();
    expect(extractRepoUrlFromMessage('https://github.com/openai/invoker/blob/main/README.md')).toBeUndefined();
  });

  it('returns the first repo-root URL when multiple are present', () => {
    expect(extractRepoUrlFromMessage('try https://gitlab.com/first/repo.git then https://github.com/second/repo')).toBe('https://gitlab.com/first/repo.git');
  });

  it('returns undefined when no repo URL is present', () => {
    expect(extractRepoUrlFromMessage('please plan this without a repo link')).toBeUndefined();
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
      hasExplicitPreset: true,
      text: 'add a /health endpoint',
    });
  });
});

// ── Harness routing ──────────────────────────────────────────

describe('harness routing', () => {
  beforeEach(() => { planConversationConfigs.length = 0; });

  it('constructs the planning conversation with the preset tool/model and injected builder', async () => {
    const builder = vi.fn(() => ({ command: 'cursor', args: [] }));
    const surface = new SlackSurface({
      ...baseConfig(),
      defaultRepoUrl: 'git@github.com:default/repo.git',
      planningCommandBuilder: builder,
    });
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

  it('pins a workflow plan summary and uploads its YAML file', async () => {
    const planDir = mkdtempSync(join(tmpdir(), 'workflow-plan-'));
    const planFile = join(planDir, 'submitted.yaml');
    writeFileSync(planFile, [
      'name: Workflow plan',
      'tasks:',
      '  - id: task-1',
      '    description: Deliver the workflow plan',
      '    dependencies: []',
      '',
    ].join('\n'));
    const surface = new SlackSurface({ ...baseConfig(), workflowChannelRepo: repo });
    const client = (surface.getApp() as any).client;

    await surface.handleEvent({ type: 'workflow_created', workflowId: 'wf-1-2', planFile });

    const planCard = client.chat.postMessage.mock.calls
      .map((call: any[]) => call[0])
      .find((message: { text?: string }) => message.text?.includes('Plan for workflow'));
    expect(planCard).toEqual(expect.objectContaining({ channel: 'C_NEW', text: expect.stringContaining('Workflow plan') }));
    expect(client.pins.add).toHaveBeenCalledWith({ channel: 'C_NEW', timestamp: '1.1' });
    expect(client.files.uploadV2).toHaveBeenCalledWith({
      channel_id: 'C_NEW',
      file_uploads: [{ file: planFile, filename: 'workflow-wf-1-2-plan.yaml' }],
    });
    rmSync(planDir, { recursive: true, force: true });
  });

  it('continues publishing the workflow plan when Slack cannot pin it', async () => {
    const planDir = mkdtempSync(join(tmpdir(), 'workflow-plan-'));
    const planFile = join(planDir, 'submitted.yaml');
    writeFileSync(planFile, [
      'name: Workflow plan',
      'tasks:',
      '  - id: task-1',
      '    description: Deliver the workflow plan',
      '    dependencies: []',
      '',
    ].join('\n'));
    const surface = new SlackSurface({ ...baseConfig(), workflowChannelRepo: repo });
    const client = (surface.getApp() as any).client;
    client.pins.add.mockRejectedValueOnce(new Error('missing_scope'));

    await surface.handleEvent({ type: 'workflow_created', workflowId: 'wf-1-2', planFile });

    expect(client.files.uploadV2).toHaveBeenCalledWith(expect.objectContaining({
      channel_id: 'C_NEW',
      file_uploads: [{ file: planFile, filename: 'workflow-wf-1-2-plan.yaml' }],
    }));
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C_NEW',
      text: expect.stringContaining('pins:write'),
    }));
    rmSync(planDir, { recursive: true, force: true });
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

  it('suppresses unmapped workflow updates instead of posting to the lobby', async () => {
    const surface = new SlackSurface({ ...baseConfig(), workflowChannelRepo: repo });
    const client = (surface.getApp() as any).client;
    await surface.handleEvent({
      type: 'task_delta',
      delta: { type: 'updated', taskId: 'wf-9/api', changes: { status: 'running' }, taskStateVersion: 1, previousTaskStateVersion: 0 },
    });
    await surface.handleEvent({
      type: 'workflow_progress',
      progress: {
        workflowId: 'wf-9',
        name: 'Unmapped',
        percentComplete: 0,
        counts: { total: 1, completed: 0, failed: 0, closed: 0, running: 0, pending: 1 },
        tasks: [],
      },
    });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
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

  it('uses a temporary prompt file for oversized workflow assistant context', async () => {
    const hugeOutput = 'running task details\n'.repeat(10_000);
    const gather = vi.fn(async (): Promise<WorkflowContext> => ({
      workflowId: 'wf-1-2',
      planning: [{ role: 'user', content: 'track progress' }],
      tasks: [{ id: 'wf-1-2/api', status: 'running', agentName: 'omp', transcript: [], output: hugeOutput }],
    }));
    let promptFile = '';
    const planningCommandBuilder = vi.fn(({ prompt }: { prompt: string }) => {
      const match = prompt.match(/file: (.+)\n/);
      promptFile = match?.[1] ?? '';
      const promptContents = readFileSync(promptFile, 'utf8');
      expect(prompt).toContain('The full task instructions are in this file:');
      expect(promptContents).toContain('Task wf-1-2/api (status=running');
      expect(promptContents).toContain(hugeOutput);
      return { command: 'cursor', args: ['--print', prompt] };
    });
    mockSpawn.mockImplementationOnce(() => mockProcess('The running task is wf-1-2/api.') as any);
    const surface = new SlackSurface({
      ...baseConfig(),
      conversationRepo: convoRepo,
      workflowChannelRepo: repo,
      planningCommandBuilder,
      gatherWorkflowContext: gather,
    });
    await surface.start(async (cmd) => { received.push(cmd); });
    const say = vi.fn().mockResolvedValue({ ts: 'a' });

    await mentionHandler(surface)({
      event: { text: '<@BOT> how are we doing', ts: 't1', user: 'U1', channel: 'C123' },
      say,
    });

    expect(planningCommandBuilder).toHaveBeenCalledOnce();
    expect(promptFile).toContain('invoker-slack-prompt-');
    expect(existsSync(promptFile)).toBe(false);
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('wf-1-2/api') }));
  });

  it('logs prompt cleanup failures after workflow assistant planning', async () => {
    const cleanupError = new Error('device busy');
    const logSpy = vi.fn();
    const materializeSpy = vi.spyOn(executionEngine, 'materializeLocalAgentPrompt').mockReturnValue({
      effectivePrompt: 'materialized prompt',
      cleanup: () => ({ directory: '/tmp/invoker-slack-prompt-test-1234', error: cleanupError }),
    });
    mockSpawn.mockImplementationOnce(() => mockProcess('The running task is wf-1-2/api.'));
    const surface = new SlackSurface({
      ...baseConfig(),
      log: logSpy,
      conversationRepo: convoRepo,
      workflowChannelRepo: repo,
      planningCommandBuilder: () => ({ command: 'cursor', args: ['--print', 'materialized prompt'] }),
    });
    const runOneShotPlanner = Reflect.get(surface, 'runOneShotPlanner') as (
      harness: { tool: string; model: string },
      prompt: string,
    ) => Promise<string>;

    try {
      await expect(runOneShotPlanner.call(surface, { tool: 'omp', model: 'claude-sonnet-4-5' }, 'ignored prompt')).resolves.toBe(
        'The running task is wf-1-2/api.',
      );
      expect(logSpy).toHaveBeenCalledWith(
        'slack-surface',
        'warn',
        '[PROMPT_CLEANUP] failed to remove materialized planner prompt at /tmp/invoker-slack-prompt-test-1234: device busy',
      );
    } finally {
      materializeSpy.mockRestore();
    }
  });
});

// ── Lobby classification parsing ─────────────────────────────

function messageHandler(surface: SlackSurface): Function {
  const app = surface.getApp() as any;
  return app._eventHandlers.find((h: MockHandler) => h.pattern === 'message')!.handler;
}

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

  async function persistentLobbySurface(extra: Partial<ConstructorParameters<typeof SlackSurface>[0]> = {}) {
    const adapter = await SQLiteAdapter.create(':memory:');
    const conversationRepo = new ConversationRepository(adapter, { info: silentLog, warn: silentLog, error: silentLog });
    const slackSessionRepo = new SlackSessionRepository(adapter);
    const workflowChannelRepo = new WorkflowChannelRepository(adapter);
    const surface = lobbySurface(true, { conversationRepo, slackSessionRepo, workflowChannelRepo, ...extra });
    return { adapter, conversationRepo, slackSessionRepo, workflowChannelRepo, surface };
  }

  it('returns only the final Codex message from one-shot Slack replies', async () => {
    const raw = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'reasoning', text: 'Inspecting the repository.' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Progress update.' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Final user-facing answer.' },
      }),
    ].join('\n');
    mockSpawn.mockImplementationOnce(() => mockProcess(raw));
    const surface = lobbySurface();

    await expect((surface as any).runOneShotPlanner({ tool: 'codex' }, 'answer this')).resolves.toBe(
      'Final user-facing answer.',
    );
  });

  // Repro: the Slack thread that prompted this asked the bot to investigate a
  // landing failure. There is no classifier anymore — every non-deterministic
  // mention routes straight into a normal agent-mode conversation, which is
  // where the execution boundary (SLACK_LOCAL_REPRO_POLICY) lives; see
  // "agent mode refuses Invoker YAML and redirects" in plan-conversation.test.ts
  // for coverage of that boundary text itself.
  it('routes a lobby question into a normal agent thread instead of running an operation', async () => {
    const surface = lobbySurface();
    await surface.start(async (cmd) => { received.push(cmd); });
    const say = vi.fn().mockResolvedValue({ ts: 'a' });

    await mentionHandler(surface)({
      event: {
        text: '<@BOT> why do we get extra merge stacks when we babysit landing these workflows?',
        ts: 't1', user: 'U1', channel: 'CLOBBY',
      },
      say,
    });

    expect(planConversationConfigs).toHaveLength(1);
    expect(planConversationConfigs[0].mode).toBe('agent');
    expect(runWorkflowOp).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
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

  it('refuses lobby controls from non-lobby channels while still accepting planning mentions', async () => {
    const onRestartInvoker = vi.fn().mockResolvedValue(undefined);
    const surface = lobbySurface(true, { onRestartInvoker });
    await surface.start(async () => {});
    const handlePlanningMention = vi.spyOn(surface as any, 'handlePlanningMention');

    const sayRestart = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({
      event: { text: '<@BOT> restart', ts: 't-restart', user: 'U1', channel: 'COTHER' },
      say: sayRestart,
    });
    expect(onRestartInvoker).not.toHaveBeenCalled();
    expect(sayRestart).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('restart/submit/workflow controls only work in the lobby channel or DMs'),
    }));

    const sayOp = vi.fn().mockResolvedValue({ ts: 'b' });
    await mentionHandler(surface)({
      event: { text: '<@BOT> recreate all', ts: 't-op', user: 'U1', channel: 'COTHER' },
      say: sayOp,
    });
    expect(runWorkflowOp).not.toHaveBeenCalled();
    expect(sayOp).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('restart/submit/workflow controls only work in the lobby channel or DMs'),
    }));

    handlePlanningMention.mockClear();
    const sayPlan = vi.fn().mockResolvedValue({ ts: 'c' });
    await mentionHandler(surface)({
      event: { text: '<@BOT> draft a plan for a health endpoint', ts: 't-plan', user: 'U1', channel: 'COTHER' },
      say: sayPlan,
    });
    expect(handlePlanningMention).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'COTHER', ts: 't-plan' }),
      sayPlan,
      'COTHER',
    );
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

  it('treats fuzzy operational text as a normal agent question, not a workflow op', async () => {
    const surface = lobbySurface();
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> can you recreate everything please', ts: 't1', user: 'U1' }, say });

    // Only the deterministic verb grammar (`recreate all`, etc.) triggers a workflow
    // op; fuzzy prose with no classifier just becomes a normal agent-mode turn.
    expect(planConversationConfigs).toHaveLength(1);
    expect(planConversationConfigs[0].mode).toBe('agent');
    expect(runWorkflowOp).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('planner reply') }));
  });

  it('acknowledges a fuzzy operational mention immediately, before the agent responds', async () => {
    const surface = lobbySurface(true, { enableImmediateAck: true });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'ack-1' });
    await mentionHandler(surface)({ event: { text: '<@BOT> can you recreate everything please', ts: 't1', user: 'U1' }, say });
    // Immediate "processing" receipt posts up front (then is replaced by the agent's reply).
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: 'Processing your request...', thread_ts: 't1' }));
    expect(planConversationConfigs).toHaveLength(1);
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

  it('starts a normal agent thread for a build request (no classifier, no plan-mode inference)', async () => {
    const surface = lobbySurface(true, { defaultRepoUrl: 'git@github.com:default/repo.git' });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> add a /health endpoint', ts: 't1', user: 'U1' }, say });
    expect(planConversationConfigs).toHaveLength(1);
    expect(planConversationConfigs[0].mode).toBe('agent');
    expect(runWorkflowOp).not.toHaveBeenCalled();
  });

  it('routes a build request into conversational planning when conversationalPlanning is enabled', async () => {
    const surface = lobbySurface(true, { defaultRepoUrl: 'git@github.com:default/repo.git', conversationalPlanning: true });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> lets change the theme of the app from black to pink', ts: 't1', user: 'U1' }, say });
    expect(planConversationConfigs).toHaveLength(1);
    expect(planConversationConfigs[0].mode).toBe('plan');
    expect(planConversationConfigs[0].conversationalPlanning).toBe(true);
    expect(runWorkflowOp).not.toHaveBeenCalled();
  });

  it('keeps an explicit local: request in agent mode even when conversationalPlanning is enabled', async () => {
    const surface = lobbySurface(true, { defaultRepoUrl: 'git@github.com:default/repo.git', conversationalPlanning: true });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> local: reproduce the flaky test', ts: 't1', user: 'U1' }, say });
    expect(planConversationConfigs).toHaveLength(1);
    expect(planConversationConfigs[0].mode).toBe('agent');
    expect(runWorkflowOp).not.toHaveBeenCalled();
  });

  it('treats a `plan:`-prefixed message as literal agent text, not a mode switch', async () => {
    const surface = lobbySurface(true, { defaultRepoUrl: 'git@github.com:default/repo.git' });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({ event: { text: '<@BOT> plan: add a /health endpoint', ts: 't1', user: 'U1' }, say });
    expect(planConversationConfigs).toHaveLength(1);
    expect(planConversationConfigs[0].mode).toBe('agent');
    expect(runWorkflowOp).not.toHaveBeenCalled();
  });

  it('uses a direct repository URL for a clone-backed planning session', async () => {
    const prepareRepoCheckout = vi.fn().mockResolvedValue('/planning-clones/notarepo');
    const surface = lobbySurface(true, {
      defaultRepoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker.git',
      workingDir: '/manager/Invoker',
      prepareRepoCheckout,
    });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({
      event: {
        text: '<@BOT> plan this in <https://github.com/EdbertChan/notarepo/|notarepo>',
        ts: 'direct-repo',
        user: 'U1',
      },
      say,
    });

    expect(prepareRepoCheckout).toHaveBeenCalledWith('https://github.com/EdbertChan/notarepo');
    expect(planConversationConfigs.at(-1)).toEqual(expect.objectContaining({
      repoUrl: 'https://github.com/EdbertChan/notarepo',
      workingDir: '/planning-clones/notarepo',
    }));
  });

  it('uses a repo-root URL in the first agent message instead of defaultRepoUrl', async () => {
    const surface = lobbySurface(true, {
      defaultRepoUrl: 'git@github.com:default/repo.git',
      enableImmediateAck: true,
    });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });

    await mentionHandler(surface)({
      event: {
        text: '<@BOT> add a /health endpoint to https://github.com/openai/invoker',
        ts: 't1',
        user: 'U1',
        channel: 'CLOBBY',
      },
      say,
    });

    // No classifier and no plan-mode fork anymore: the "I picked repo ... from the
    // URL in your message" announcement was only ever emitted for the plan-mode
    // branch, which no longer exists. Every mention is a normal agent-mode turn.
    expect(planConversationConfigs).toHaveLength(1);
    expect(planConversationConfigs[0].mode).toBe('agent');
    expect(planConversationConfigs[0].repoUrl).toBe('https://github.com/openai/invoker');
  });

  it('rejects multiple repository selectors before creating a session', async () => {
    const surface = lobbySurface(true, {
      repoAliases: { proof: 'https://github.com/example/proof.git' },
    });
    await surface.start(async () => {});
    const multipleSay = vi.fn().mockResolvedValue({ ts: 'a' });
    await mentionHandler(surface)({
      event: {
        text: '<@BOT> plan https://github.com/example/one and https://github.com/example/two',
        ts: 'repo-multiple',
        user: 'U1',
      },
      say: multipleSay,
    });
    expect(multipleSay).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('multiple repository URLs') }));
    expect(planConversationConfigs).toHaveLength(0);
  });

  it('provisions the reported public repo channels and routes each channel by resolved ID', async () => {
    const { adapter, slackSessionRepo, workflowChannelRepo, surface } = await persistentLobbySurface({
      adminUserIds: ['U_ADMIN'],
      defaultRepoUrl: 'https://github.com/example/default',
    });
    const client = (surface.getApp() as any).client;
    client.conversations.create
      .mockResolvedValueOnce({ channel: { id: 'C_INVOKER_REPO' } })
      .mockResolvedValueOnce({ channel: { id: 'C_RIPS_REPO' } });

    try {
      await surface.start(async (cmd) => { received.push(cmd); });
      const setupSay = vi.fn().mockResolvedValue({ ts: 'setup-reply' });
      await mentionHandler(surface)({
        event: {
          text: '<@BOT> set up #invoker-repo https://github.com/Neko-Catpital-Labs/Invoker and #rips-clone-mobile-repo https://github.com/EdbertChan/notarepo',
          ts: 'setup-thread',
          user: 'U_ADMIN',
          channel: 'CLOBBY',
        },
        say: setupSay,
      });

      expect(client.conversations.create).toHaveBeenNthCalledWith(1, { name: 'invoker-repo', is_private: false });
      expect(client.conversations.create).toHaveBeenNthCalledWith(2, { name: 'rips-clone-mobile-repo', is_private: false });
      expect(setupSay.mock.calls.map((call) => call[0].text).join('\n')).not.toContain('multiple repository URLs');
      expect(workflowChannelRepo.getByChannelId('C_INVOKER_REPO')?.repoUrl).toBe('https://github.com/Neko-Catpital-Labs/Invoker');
      expect(workflowChannelRepo.getByChannelId('C_RIPS_REPO')?.repoUrl).toBe('https://github.com/EdbertChan/notarepo');
      expect(planConversationConfigs).toHaveLength(0);

      await mentionHandler(surface)({
        event: { text: '<@BOT> plan: harden routing', ts: 'invoker-thread', user: 'U1', channel: 'C_INVOKER_REPO' },
        say: vi.fn().mockResolvedValue({ ts: 'invoker-reply' }),
      });
      await mentionHandler(surface)({
        event: { text: '<@BOT> plan: harden routing', ts: 'rips-thread', user: 'U1', channel: 'C_RIPS_REPO' },
        say: vi.fn().mockResolvedValue({ ts: 'rips-reply' }),
      });

      expect(planConversationConfigs.at(-2)).toEqual(expect.objectContaining({
        channelId: 'C_INVOKER_REPO',
        repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker',
      }));
      expect(planConversationConfigs.at(-1)).toEqual(expect.objectContaining({
        channelId: 'C_RIPS_REPO',
        repoUrl: 'https://github.com/EdbertChan/notarepo',
      }));
      expect(slackSessionRepo.getLaunchContext('invoker-thread')?.repoUrl).toBe('https://github.com/Neko-Catpital-Labs/Invoker');
      expect(slackSessionRepo.getLaunchContext('rips-thread')?.repoUrl).toBe('https://github.com/EdbertChan/notarepo');
    } finally {
      await surface.stop();
      adapter.close();
    }
  });

  it('denies channel repository setup from a non-admin before Slack channel creation', async () => {
    const { adapter, workflowChannelRepo, surface } = await persistentLobbySurface({ adminUserIds: ['U_ADMIN'] });
    const client = (surface.getApp() as any).client;
    try {
      await surface.start(async () => {});
      const say = vi.fn().mockResolvedValue({ ts: 'denied' });
      await mentionHandler(surface)({
        event: {
          text: '<@BOT> set up #invoker-repo https://github.com/Neko-Catpital-Labs/Invoker and #rips-clone-mobile-repo https://github.com/EdbertChan/notarepo',
          ts: 'setup-denied',
          user: 'U_INTRUDER',
          channel: 'CLOBBY',
        },
        say,
      });

      expect(client.conversations.create).not.toHaveBeenCalled();
      expect(workflowChannelRepo.list()).toHaveLength(0);
      expect(planConversationConfigs).toHaveLength(0);
      expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Permission denied') }));
      expect(say.mock.calls.map((call) => call[0].text).join('\n')).not.toContain('multiple repository URLs');
    } finally {
      await surface.stop();
      adapter.close();
    }
  });

  it('reuses an existing public channel ID on channel setup name_taken', async () => {
    const { adapter, workflowChannelRepo, surface } = await persistentLobbySurface({ adminUserIds: ['U_ADMIN'] });
    const client = (surface.getApp() as any).client;
    client.conversations.create.mockRejectedValueOnce({ data: { error: 'name_taken' } });
    client.conversations.list.mockResolvedValueOnce({ channels: [{ id: 'C_EXISTING', name: 'invoker-repo', is_private: false }] });

    try {
      await surface.start(async () => {});
      await mentionHandler(surface)({
        event: {
          text: '<@BOT> map #invoker-repo to https://github.com/Neko-Catpital-Labs/Invoker',
          ts: 'setup-name-taken',
          user: 'U_ADMIN',
          channel: 'CLOBBY',
        },
        say: vi.fn().mockResolvedValue({ ts: 'ok' }),
      });

      expect(client.conversations.list).toHaveBeenCalledWith({ types: 'public_channel', limit: 1000 });
      expect(workflowChannelRepo.getByChannelId('C_EXISTING')?.repoUrl).toBe('https://github.com/Neko-Catpital-Labs/Invoker');
    } finally {
      await surface.stop();
      adapter.close();
    }
  });

  it('keeps successful channel bindings when a later setup pair fails', async () => {
    const { adapter, workflowChannelRepo, surface } = await persistentLobbySurface({ adminUserIds: ['U_ADMIN'] });
    const client = (surface.getApp() as any).client;
    client.conversations.create
      .mockResolvedValueOnce({ channel: { id: 'C_OK' } })
      .mockRejectedValueOnce({ data: { error: 'missing_scope' } });

    try {
      await surface.start(async () => {});
      const say = vi.fn().mockResolvedValue({ ts: 'partial' });
      await mentionHandler(surface)({
        event: {
          text: '<@BOT> setup #invoker-repo https://github.com/Neko-Catpital-Labs/Invoker #rips-clone-mobile-repo https://github.com/EdbertChan/notarepo',
          ts: 'setup-partial',
          user: 'U_ADMIN',
          channel: 'CLOBBY',
        },
        say,
      });

      expect(workflowChannelRepo.getByChannelId('C_OK')?.repoUrl).toBe('https://github.com/Neko-Catpital-Labs/Invoker');
      expect(workflowChannelRepo.list()).toHaveLength(1);
      expect(say.mock.calls.map((call) => call[0].text).join('\n')).toContain('Failed to configure: #rips-clone-mobile-repo');
    } finally {
      await surface.stop();
      adapter.close();
    }
  });

  it('falls back to defaultRepoUrl in an unmapped channel', async () => {
    const surface = lobbySurface(true, { defaultRepoUrl: 'https://github.com/example/default' });
    await surface.start(async () => {});

    await mentionHandler(surface)({
      event: { text: '<@BOT> plan: add fallback behavior', ts: 'fallback-thread', user: 'U1', channel: 'C_UNMAPPED' },
      say: vi.fn().mockResolvedValue({ ts: 'fallback' }),
    });

    expect(planConversationConfigs.at(-1)).toEqual(expect.objectContaining({
      channelId: 'C_UNMAPPED',
      repoUrl: 'https://github.com/example/default',
    }));
  });

  it('lets an explicit repo selector win over a channel default with a visible notice', async () => {
    const { adapter, surface } = await persistentLobbySurface({
      defaultRepoUrl: 'https://github.com/example/default',
      channelRepoBindings: { C_INVOKER: 'https://github.com/Neko-Catpital-Labs/Invoker' },
      repoAliases: { mobile: 'https://github.com/EdbertChan/notarepo' },
    });
    try {
      await surface.start(async () => {});
      const say = vi.fn().mockResolvedValue({ ts: 'notice' });
      await mentionHandler(surface)({
        event: { text: '<@BOT> [repo:mobile] plan: add mobile behavior', ts: 'override-thread', user: 'U1', channel: 'C_INVOKER' },
        say,
      });

      expect(planConversationConfigs.at(-1)).toEqual(expect.objectContaining({
        channelId: 'C_INVOKER',
        repoUrl: 'https://github.com/EdbertChan/notarepo',
      }));
      expect(say.mock.calls.map((call) => call[0].text).join('\n')).toContain('instead of this channel\'s default');
    } finally {
      await surface.stop();
      adapter.close();
    }
  });

  it('keeps an existing thread pinned when the channel default changes', async () => {
    const { adapter, slackSessionRepo, surface } = await persistentLobbySurface({
      defaultRepoUrl: 'https://github.com/example/default',
      channelRepoBindings: { C_INVOKER: 'https://github.com/Neko-Catpital-Labs/Invoker' },
    });
    try {
      await surface.start(async () => {});
      await mentionHandler(surface)({
        event: { text: '<@BOT> plan: start here', ts: 'pinned-thread', user: 'U1', channel: 'C_INVOKER' },
        say: vi.fn().mockResolvedValue({ ts: 'start' }),
      });

      (surface as any).channelRepoBindings.C_INVOKER = 'https://github.com/EdbertChan/notarepo';

      await mentionHandler(surface)({
        event: { text: '<@BOT> continue planning', ts: 'pinned-thread-reply', thread_ts: 'pinned-thread', user: 'U1', channel: 'C_INVOKER' },
        say: vi.fn().mockResolvedValue({ ts: 'continue' }),
      });

      expect(slackSessionRepo.getLaunchContext('pinned-thread')?.repoUrl).toBe('https://github.com/Neko-Catpital-Labs/Invoker');
      expect(planConversationConfigs[0].repoUrl).toBe('https://github.com/Neko-Catpital-Labs/Invoker');
      expect(planConversationConfigs).toHaveLength(1);
    } finally {
      await surface.stop();
      adapter.close();
    }
  });

  it('routes by resolved channel ID after the setup channel is renamed', async () => {
    const { adapter, surface } = await persistentLobbySurface({ adminUserIds: ['U_ADMIN'] });
    const client = (surface.getApp() as any).client;
    client.conversations.create.mockRejectedValueOnce({ data: { error: 'name_taken' } });
    client.conversations.list.mockResolvedValueOnce({ channels: [{ id: 'C_STABLE', name: 'old-invoker-repo', is_private: false }] });

    try {
      await surface.start(async () => {});
      await mentionHandler(surface)({
        event: {
          text: '<@BOT> bind #old-invoker-repo to https://github.com/Neko-Catpital-Labs/Invoker',
          ts: 'setup-rename',
          user: 'U_ADMIN',
          channel: 'CLOBBY',
        },
        say: vi.fn().mockResolvedValue({ ts: 'setup' }),
      });

      await mentionHandler(surface)({
        event: { text: '<@BOT> plan: after rename', ts: 'renamed-thread', user: 'U1', channel: 'C_STABLE' },
        say: vi.fn().mockResolvedValue({ ts: 'renamed' }),
      });

      expect(planConversationConfigs.at(-1)).toEqual(expect.objectContaining({
        channelId: 'C_STABLE',
        repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker',
      }));
    } finally {
      await surface.stop();
      adapter.close();
    }
  });

  it('lets a [repo:] tag win over a repo URL in the same first plan message', async () => {
    const surface = lobbySurface(true, {
      defaultRepoUrl: 'git@github.com:default/repo.git',
      repoAliases: { foo: 'git@github.com:me/foo.git' },
    });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });

    await mentionHandler(surface)({
      event: {
        text: '<@BOT> [repo:foo] plan: add a /health endpoint to https://github.com/openai/invoker',
        ts: 't1',
        user: 'U1',
        channel: 'CLOBBY',
      },
      say,
    });

    expect(planConversationConfigs).toHaveLength(1);
    expect(planConversationConfigs[0].repoUrl).toBe('git@github.com:me/foo.git');
    expect(say.mock.calls.map((call) => call[0].text).join('\n')).not.toContain('from the URL in your message');
  });

  it('rejects an unsupported literal [repo:] URL before creating a planning session', async () => {
    const surface = lobbySurface(true, { defaultRepoUrl: 'git@github.com:default/repo.git' });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });

    await mentionHandler(surface)({
      event: {
        text: '<@BOT> [repo:https://www.onorca.dev] plan: add a /health endpoint',
        ts: 'invalid-literal-repo',
        user: 'U1',
        channel: 'CLOBBY',
      },
      say,
    });

    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Invalid repo URL "https://www.onorca.dev". Use a GitHub repo URL or a clone URL ending in .git.',
      thread_ts: 'invalid-literal-repo',
    }));
    expect(planConversationConfigs).toHaveLength(0);
  });

  it.each([
    ['generic website URL', 'https://www.onorca.dev'],
    ['GitHub deep link', 'https://github.com/openai/invoker/pull/123'],
  ])('keeps defaultRepoUrl when the first agent message contains a %s', async (_label, url) => {
    const defaultRepoUrl = 'git@github.com:default/repo.git';
    const surface = lobbySurface(true, { defaultRepoUrl });
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });

    await mentionHandler(surface)({
      event: {
        text: `<@BOT> plan: fix the issue at ${url}`,
        ts: 't1',
        user: 'U1',
        channel: 'CLOBBY',
      },
      say,
    });

    expect(planConversationConfigs).toHaveLength(1);
    expect(planConversationConfigs[0].mode).toBe('agent');
    expect(planConversationConfigs[0].repoUrl).toBe(defaultRepoUrl);
    expect(say.mock.calls.map((call) => call[0].text).join('\n')).not.toContain('from the URL in your message');
  });

  it('rebinds a follow-up repo-root URL, clears workingDir, and checks out the new repo on the next turn', async () => {
    const oldRepo = 'https://github.com/openai/old-repo';
    const newRepo = 'https://github.com/openai/new-repo';
    const prepareRepoCheckout = vi.fn().mockResolvedValue('/checkouts/new-repo');
    const { adapter, slackSessionRepo, surface } = await persistentLobbySurface({
      defaultRepoUrl: oldRepo,
      workingDir: '/checkouts/old-repo',
      prepareRepoCheckout,
    });

    try {
      await surface.start(async () => {});
      await mentionHandler(surface)({
        event: { text: '<@BOT> local: start in the current repo', ts: 't1', user: 'U1', channel: 'CLOBBY' },
        say: vi.fn().mockResolvedValue({ ts: 'a' }),
      });
      expect(slackSessionRepo.getLaunchContext('t1')).toEqual(expect.objectContaining({
        repoUrl: oldRepo,
        workingDir: '/checkouts/old-repo',
      }));

      const rebindSay = vi.fn().mockResolvedValue({ ts: 'b' });
      await messageHandler(surface)({
        event: { thread_ts: 't1', ts: 't2', user: 'U1', text: `Please use ${newRepo} instead`, channel: 'CLOBBY' },
        say: rebindSay,
      });

      expect(prepareRepoCheckout).not.toHaveBeenCalled();
      expect(slackSessionRepo.getLaunchContext('t1')).toEqual(expect.objectContaining({
        repoUrl: newRepo,
        workingDir: '',
      }));
      expect(rebindSay).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining('openai/new-repo'),
        thread_ts: 't1',
      }));
      expect(rebindSay.mock.calls[0][0].text).toContain('previous working state for this thread was discarded');
      expect(planConversationConfigs).toHaveLength(1);

      await messageHandler(surface)({
        event: { thread_ts: 't1', ts: 't3', user: 'U1', text: 'run local: make the update now', channel: 'CLOBBY' },
        say: vi.fn().mockResolvedValue({ ts: 'c' }),
      });

      expect(prepareRepoCheckout).toHaveBeenCalledWith(newRepo);
      expect(slackSessionRepo.getLaunchContext('t1')).toEqual(expect.objectContaining({
        repoUrl: newRepo,
        workingDir: '/checkouts/new-repo',
      }));
      expect(planConversationConfigs.at(-1)).toEqual(expect.objectContaining({
        mode: 'agent',
        repoUrl: newRepo,
        workingDir: '/checkouts/new-repo',
      }));
    } finally {
      await surface.stop();
      adapter.close();
    }
  });
  it('refuses a repo rebind from a different non-admin participant', async () => {
    const oldRepo = 'https://github.com/openai/old-repo';
    const newRepo = 'https://github.com/openai/new-repo';
    const prepareRepoCheckout = vi.fn().mockResolvedValue('/checkouts/new-repo');
    const { adapter, slackSessionRepo, surface } = await persistentLobbySurface({
      defaultRepoUrl: oldRepo,
      workingDir: '/checkouts/old-repo',
      adminUserIds: ['U_ADMIN'],
      prepareRepoCheckout,
    });

    try {
      await surface.start(async () => {});
      await mentionHandler(surface)({
        event: { text: '<@BOT> local: start in the current repo', ts: 't1', user: 'U1', channel: 'CLOBBY' },
        say: vi.fn().mockResolvedValue({ ts: 'a' }),
      });

      const deniedSay = vi.fn().mockResolvedValue({ ts: 'b' });
      await messageHandler(surface)({
        event: { thread_ts: 't1', ts: 't2', user: 'U2', text: `Please use ${newRepo} instead`, channel: 'CLOBBY' },
        say: deniedSay,
      });

      expect(prepareRepoCheckout).not.toHaveBeenCalled();
      expect(slackSessionRepo.getLaunchContext('t1')).toEqual(expect.objectContaining({
        repoUrl: oldRepo,
        workingDir: '/checkouts/old-repo',
      }));
      expect(deniedSay).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining('Permission denied'),
        thread_ts: 't1',
      }));
      expect(deniedSay.mock.calls.map((call) => call[0].text).join('\n')).not.toContain('switched this thread');
      expect(planConversationConfigs).toHaveLength(1);
    } finally {
      await surface.stop();
      adapter.close();
    }
  });

  it('treats a follow-up URL for the already-bound repo as a no-op', async () => {
    const boundRepo = 'git@github.com:openai/invoker.git';
    const prepareRepoCheckout = vi.fn().mockResolvedValue('/checkouts/unused');
    const { adapter, slackSessionRepo, surface } = await persistentLobbySurface({
      defaultRepoUrl: boundRepo,
      workingDir: '/checkouts/invoker',
      prepareRepoCheckout,
    });

    try {
      await surface.start(async () => {});
      await mentionHandler(surface)({
        event: { text: '<@BOT> local: start in invoker', ts: 't1', user: 'U1', channel: 'CLOBBY' },
        say: vi.fn().mockResolvedValue({ ts: 'a' }),
      });

      const sameRepoSay = vi.fn().mockResolvedValue({ ts: 'b' });
      await messageHandler(surface)({
        event: { thread_ts: 't1', ts: 't2', user: 'U1', text: 'run local: continue in https://github.com/openai/invoker', channel: 'CLOBBY' },
        say: sameRepoSay,
      });

      expect(prepareRepoCheckout).not.toHaveBeenCalled();
      expect(slackSessionRepo.getLaunchContext('t1')).toEqual(expect.objectContaining({
        repoUrl: boundRepo,
        workingDir: '/checkouts/invoker',
      }));
      expect(planConversationConfigs).toHaveLength(1);
      const texts = sameRepoSay.mock.calls.map((call) => call[0].text).join('\n');
      expect(texts).not.toContain('switched this thread');
      expect(texts).not.toContain('previous working state');
    } finally {
      await surface.stop();
      adapter.close();
    }
  });

  it('accepts an equivalent non-GitHub .git repo URL in a thread mention', async () => {
    const boundRepo = 'git@gitlab.com:openai/invoker.git';
    const prepareRepoCheckout = vi.fn().mockResolvedValue('/checkouts/unused');
    const { adapter, surface } = await persistentLobbySurface({
      defaultRepoUrl: boundRepo,
      workingDir: '/checkouts/invoker',
      prepareRepoCheckout,
    });

    try {
      await surface.start(async () => {});
      await mentionHandler(surface)({
        event: { text: '<@BOT> local: start in invoker', ts: 't1', user: 'U1', channel: 'CLOBBY' },
        say: vi.fn().mockResolvedValue({ ts: 'a' }),
      });

      const sameRepoSay = vi.fn().mockResolvedValue({ ts: 'b' });
      await mentionHandler(surface)({
        event: {
          text: '<@BOT> local: continue in https://gitlab.com/openai/invoker.git',
          thread_ts: 't1',
          ts: 't2',
          user: 'U1',
          channel: 'CLOBBY',
        },
        say: sameRepoSay,
      });

      expect(prepareRepoCheckout).not.toHaveBeenCalled();
      expect(planConversationConfigs).toHaveLength(1);
      expect(sameRepoSay.mock.calls.map((call) => call[0].text).join('\n')).not.toContain('already pinned to a different repository');
    } finally {
      await surface.stop();
      adapter.close();
    }
  });

  it('clears persisted conversation state when rebinding a thread repo', async () => {
    const oldRepo = 'https://github.com/openai/old-repo';
    const newRepo = 'https://github.com/openai/new-repo';
    const { adapter, conversationRepo, surface } = await persistentLobbySurface({
      defaultRepoUrl: oldRepo,
      workingDir: '/checkouts/old-repo',
    });

    try {
      await surface.start(async () => {});
      await mentionHandler(surface)({
        event: { text: '<@BOT> local: start in the current repo', ts: 't1', user: 'U1', channel: 'CLOBBY' },
        say: vi.fn().mockResolvedValue({ ts: 'a' }),
      });
      conversationRepo.saveConversation(
        't1',
        [
          { role: 'user', content: 'old repo question' },
          { role: 'assistant', content: 'old repo answer' },
        ],
        null,
        false,
        'CLOBBY',
        'U1',
        'agent',
      );
      expect(conversationRepo.loadConversation('t1')).not.toBeNull();

      const rebindSay = vi.fn().mockResolvedValue({ ts: 'b' });
      await messageHandler(surface)({
        event: { thread_ts: 't1', ts: 't2', user: 'U1', text: `Please use ${newRepo} instead`, channel: 'CLOBBY' },
        say: rebindSay,
      });

      expect(rebindSay).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining('openai/new-repo'),
        thread_ts: 't1',
      }));
      expect(conversationRepo.loadConversation('t1')).toBeNull();
    } finally {
      await surface.stop();
      adapter.close();
    }
  });

  it.each([
    ['generic website URL', 'https://www.onorca.dev'],
    ['GitHub deep link', 'https://github.com/openai/new-repo/pull/123'],
    ['non-GitHub root URL without .git', 'https://gitlab.com/openai/invoker'],
  ])('does not rebind a follow-up %s', async (_label, url) => {
    const boundRepo = 'https://github.com/openai/invoker';
    const prepareRepoCheckout = vi.fn().mockResolvedValue('/checkouts/unused');
    const { adapter, slackSessionRepo, surface } = await persistentLobbySurface({
      defaultRepoUrl: boundRepo,
      workingDir: '/checkouts/invoker',
      prepareRepoCheckout,
    });

    try {
      await surface.start(async () => {});
      await mentionHandler(surface)({
        event: { text: '<@BOT> local: start in invoker', ts: 't1', user: 'U1', channel: 'CLOBBY' },
        say: vi.fn().mockResolvedValue({ ts: 'a' }),
      });

      const followUpSay = vi.fn().mockResolvedValue({ ts: 'b' });
      await messageHandler(surface)({
        event: { thread_ts: 't1', ts: 't2', user: 'U1', text: `run local: inspect ${url}`, channel: 'CLOBBY' },
        say: followUpSay,
      });

      expect(prepareRepoCheckout).not.toHaveBeenCalled();
      expect(slackSessionRepo.getLaunchContext('t1')).toEqual(expect.objectContaining({
        repoUrl: boundRepo,
        workingDir: '/checkouts/invoker',
      }));
      expect(planConversationConfigs).toHaveLength(1);
      const texts = followUpSay.mock.calls.map((call) => call[0].text).join('\n');
      expect(texts).not.toContain('switched this thread');
      expect(texts).not.toContain('previous working state');
    } finally {
      await surface.stop();
      adapter.close();
    }
  });

  it('starts an agent conversation with no repo pinned when a mention has no tag, repo URL, or default', async () => {
    const surface = lobbySurface();
    await surface.start(async () => {});
    const say = vi.fn().mockResolvedValue({ ts: 'a' });

    await mentionHandler(surface)({
      event: { text: '<@BOT> plan: add a /health endpoint', ts: 't1', user: 'U1', channel: 'CLOBBY' },
      say,
    });

    // Agent-mode chat doesn't require a repo up front anymore — only the explicit
    // `/plan` action does, via handleExplicitPlanAction's own pinned-repo check.
    expect(planConversationConfigs).toHaveLength(1);
    expect(planConversationConfigs[0].mode).toBe('agent');
    expect(planConversationConfigs[0].repoUrl).toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
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
  // The old thread-keyed `submit`/PendingConfirm inline plan submission is gone.
  // Plan drafting + confirmation is now the explicit `/plan` -> PlanDraft card ->
  // plan_draft_approve flow. See:
  //  - slack-surface-immediate-response.integration.test.ts, "handles the explicit
  //    /plan draft-and-approve flow correctly" for the end-to-end flow.
  //  - slack-plan-draft-approve.test.ts for start_plan / workflowIds on approve.
  //  - plan-summary.test.ts for per-task plan summary rendering.

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
