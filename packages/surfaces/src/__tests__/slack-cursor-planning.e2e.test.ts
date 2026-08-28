import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationRepository,
  SlackPlanDraftRepository,
  SlackSessionRepository,
  SQLiteAdapter,
} from '@invoker/data-store';
import { registerBuiltinAgents } from '@invoker/execution-engine';
import { SlackSurface } from '../slack/slack-surface.js';
import { selectHarnessSessionDriver } from '../slack/harness-session-driver-select.js';
import type { SurfaceCommand } from '../surface.js';

/**
 * End-to-end proof that Slack planning with the real slack-manager wiring
 * (`registerBuiltinAgents` + `selectHarnessSessionDriver`) can start and
 * append a Cursor session without throwing, and that `/plan` YAML stages
 * Approve/Cancel. Spawn is mocked; Bolt is mocked; the harness argv path is real.
 */

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

const sharedSlack = vi.hoisted(() => ({
  client: {
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }) },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted' }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    reactions: { add: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({}) },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    files: { uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [{ ok: true, files: [{ id: 'F-CURSOR' }] }] }) },
  },
}));

vi.mock('@slack/bolt', () => {
  class MockApp {
    _eventHandlers: MockHandler[] = [];
    _actionHandlers: MockHandler[] = [];
    command = vi.fn();
    event = vi.fn((pattern: string, handler: Function) => this._eventHandlers.push({ pattern, handler }));
    action = vi.fn((pattern: string | RegExp, handler: Function) => this._actionHandlers.push({ pattern, handler }));
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = sharedSlack.client;
  }
  return { App: MockApp };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(childProcess.spawn);
const silentLog = () => {};

const PLAN_YAML = `\`\`\`yaml
name: "Cursor planning proof"
repoUrl: "https://github.com/example/repo.git"
onFinish: pull_request
mergeMode: none
tasks:
  - id: prove-cursor
    description: "Prove Slack cursor append works"
    command: "pnpm test"
    dependencies: []
\`\`\``;

function processWith(stdout: string): any {
  const process = new EventEmitter() as any;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = vi.fn();
  queueMicrotask(() => {
    process.stdout.emit('data', Buffer.from(stdout));
    process.emit('close', 0);
  });
  return process;
}

function handler(surface: SlackSurface, pattern: string): Function {
  const found = (surface.getApp() as any)._eventHandlers.find((entry: MockHandler) => entry.pattern === pattern);
  if (!found) throw new Error(`Missing ${pattern} handler`);
  return found.handler;
}

async function start(surface: SlackSurface, commands: SurfaceCommand[]) {
  await surface.start(async (command) => { commands.push(command); });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mention(surface: SlackSurface, text: string, ts: string, threadTs?: string) {
  const say = vi.fn().mockResolvedValue({ ts: `${ts}-reply` });
  await handler(surface, 'app_mention')({
    event: { text: `<@UBOT> ${text}`, ts, thread_ts: threadTs, user: 'U_CURSOR', channel: 'C_LOBBY' },
    say,
  });
  return say;
}

function spawnArgv(): string[] {
  const call = mockSpawn.mock.calls.at(-1);
  if (!call) throw new Error('expected a spawn call');
  const [command, args] = call as [string, string[]];
  return [command, ...args];
}

describe('Slack cursor+grok planning e2e', () => {
  let adapter: SQLiteAdapter;
  let repo: ConversationRepository;
  let slackSessions: SlackSessionRepository;
  let slackPlanDrafts: SlackPlanDraftRepository;
  let workingDir: string;
  let surfaces: SlackSurface[];

  beforeEach(async () => {
    mockSpawn.mockReset();
    sharedSlack.client.auth.test.mockClear();
    sharedSlack.client.chat.postMessage.mockClear();
    sharedSlack.client.files.uploadV2.mockClear();
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new ConversationRepository(adapter, { info: silentLog, warn: silentLog, error: silentLog });
    slackSessions = new SlackSessionRepository(adapter);
    slackPlanDrafts = new SlackPlanDraftRepository(adapter);
    workingDir = mkdtempSync(join(tmpdir(), 'invoker-slack-cursor-'));
    surfaces = [];
  });

  afterEach(async () => {
    await Promise.all(surfaces.map((surface) => surface.stop()));
    adapter.close();
    rmSync(workingDir, { recursive: true, force: true });
  });

  function surface(commands: SurfaceCommand[]) {
    // Same seams slack-manager uses on DO1 for cursor+grok planning.
    const executionAgentRegistry = registerBuiltinAgents({
      cursorExecution: { command: 'cursor-test' },
    });
    const planningCommandBuilder = (opts: { tool: string; model?: string; prompt: string }) =>
      executionAgentRegistry.getPlanningOrThrow(opts.tool).buildPlanningCommand(opts.prompt, { model: opts.model });
    const harnessSessionDriverFactory = (preset: { tool: string; model?: string }) =>
      selectHarnessSessionDriver(preset, { executionAgentRegistry, planningCommandBuilder });

    const created = new SlackSurface({
      botToken: 'xoxb-cursor',
      appToken: 'xapp-cursor',
      signingSecret: 'cursor',
      channelId: 'C_DEFAULT',
      defaultRepoUrl: 'https://github.com/example/repo.git',
      lobbyChannelId: 'C_LOBBY',
      conversationRepo: repo,
      slackSessionRepo: slackSessions,
      slackPlanDraftRepo: slackPlanDrafts,
      workingDir,
      enableImmediateAck: false,
      planningHeartbeatIntervalSeconds: 0,
      log: silentLog,
      harnessPresets: {
        'cursor+grok': { tool: 'cursor', model: 'grok-4.5' },
      },
      defaultHarnessPreset: 'cursor+grok',
      harnessSessionDriverFactory,
      planningCommandBuilder,
    });
    surfaces.push(created);
    return created;
  }

  it('starts with cursor agent --print --trust --model grok-4.5, resumes on /plan, and stages Approve/Cancel', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    await start(slack, commands);

    mockSpawn.mockImplementationOnce(() => processWith('Looking at the request now.'));
    await mention(slack, 'Please scope a small proof plan for cursor append.', 'cursor-thread');

    const startArgv = spawnArgv();
    expect(startArgv[0]).toBe('cursor-test');
    expect(startArgv).toEqual(expect.arrayContaining(['agent', '--print', '--trust', '--model', 'grok-4.5']));
    expect(startArgv).not.toContain('--resume');
    const sessionIdIndex = startArgv.indexOf('--resume');
    expect(sessionIdIndex).toBe(-1);
    const startPrompt = startArgv.at(-1) ?? '';
    expect(startPrompt).toContain('Please scope a small proof plan for cursor append.');

    const planningContext = (slack as any).planningContexts.get('cursor-thread');
    expect(planningContext?.harnessSessionId).toBeTruthy();
    const sessionId = planningContext.harnessSessionId as string;

    mockSpawn.mockImplementationOnce(() => processWith(PLAN_YAML));
    const say = await mention(slack, '/plan', 'plan-turn', 'cursor-thread');

    const appendArgv = spawnArgv();
    expect(appendArgv.slice(0, 8)).toEqual([
      'cursor-test',
      'agent',
      '--resume',
      sessionId,
      '--print',
      '--trust',
      '--model',
      'grok-4.5',
    ]);
    expect(appendArgv).toHaveLength(9);

    const draft = slackPlanDrafts.getReady('C_LOBBY', 'cursor-thread');
    expect(draft).toEqual(expect.objectContaining({
      status: 'ready',
      planText: expect.stringContaining('name: Cursor planning proof'),
    }));
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      thread_ts: 'cursor-thread',
      blocks: expect.arrayContaining([
        expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({ action_id: 'plan_draft_approve', text: expect.objectContaining({ text: 'Approve' }) }),
            expect.objectContaining({ action_id: 'plan_draft_cancel', text: expect.objectContaining({ text: 'Cancel' }) }),
          ]),
        }),
      ]),
    }));
    expect(commands).not.toContainEqual(expect.objectContaining({ type: 'start_plan' }));
  });
});
