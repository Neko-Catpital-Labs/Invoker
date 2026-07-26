/**
 * Repro contracts for issue 1: a drafted plan must always arrive with an
 * Approve button.
 *
 * Root cause under test: `PlanConversation.getDraftedPlan()` returns the
 * plan-draft file unvalidated. When the planner writes a parseable-but-
 * unsummarizable draft file while the chat reply carries a valid fenced plan,
 * the surface sees `draftedPlan != null` but `summary == null` and posts the
 * reply with no Approve button and no staged confirmation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRepository, SlackSessionRepository, SQLiteAdapter } from '@invoker/data-store';
import { SlackSurface } from '../slack/slack-surface.js';
import type { SurfaceCommand } from '../surface.js';

type MockHandlerFn = (args: Record<string, unknown>) => Promise<void> | void;

interface MockHandler {
  pattern: string | RegExp;
  handler: MockHandlerFn;
}

interface MockAppInternals {
  _eventHandlers: MockHandler[];
  _actionHandlers: MockHandler[];
}

interface SlackButtonElement {
  action_id?: string;
  value?: string;
}

interface SlackBlock {
  type?: string;
  elements?: SlackButtonElement[];
}

interface SaidMessage {
  text?: string;
  blocks?: SlackBlock[];
  thread_ts?: string;
}

interface PendingSubmitLike {
  kind: string;
  planText?: string;
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
  },
}));

vi.mock('@slack/bolt', () => {
  class MockApp {
    _eventHandlers: MockHandler[] = [];
    _actionHandlers: MockHandler[] = [];
    command = vi.fn();
    event = vi.fn((pattern: string, handler: MockHandlerFn) => this._eventHandlers.push({ pattern, handler }));
    action = vi.fn((pattern: string | RegExp, handler: MockHandlerFn) => this._actionHandlers.push({ pattern, handler }));
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = sharedSlack.client;
  }
  return { App: MockApp };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(childProcess.spawn);
const silentLog = (): void => {};

const goodPlanReply = `\`\`\`yaml
name: "Good"
tasks:
  - id: good-task
    description: "Prove the approve button survives a bad draft file"
    command: "pnpm test"
    dependencies: []
\`\`\``;

/** A draft file that parses as YAML but cannot be summarized (task has no description). */
const unsummarizableDraft = 'name: Bad\ntasks:\n  - id: t1\n';

function processWith(stdout: string): ChildProcess {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: Mock };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  queueMicrotask(() => {
    proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  });
  // The planner only touches stdout/stderr/kill/close, so this stub stands in for a real ChildProcess.
  return proc as unknown as ChildProcess;
}

function handler(surface: SlackSurface, pattern: string): MockHandlerFn {
  const app = surface.getApp() as unknown as MockAppInternals;
  const found = app._eventHandlers.find((entry) => entry.pattern === pattern);
  if (!found) throw new Error(`Missing ${pattern} handler`);
  return found.handler;
}

async function mention(surface: SlackSurface, text: string, ts: string, threadTs?: string): Promise<Mock> {
  const say = vi.fn().mockResolvedValue({ ts: `${ts}-reply` });
  await handler(surface, 'app_mention')({
    event: { text: `<@UBOT> ${text}`, ts, thread_ts: threadTs, user: 'U_PROOF', channel: 'C_LOBBY' },
    say,
  });
  return say;
}

function confirmButtonValue(say: Mock): string | null {
  for (const call of say.mock.calls) {
    const message = call[0] as SaidMessage | undefined;
    for (const block of message?.blocks ?? []) {
      for (const element of block.elements ?? []) {
        if (element.action_id === 'lobby_confirm' && typeof element.value === 'string') {
          return element.value;
        }
      }
    }
  }
  return null;
}

function pendingSubmits(surface: SlackSurface): PendingSubmitLike[] {
  // Test-only reach into a private field to observe confirmation staging.
  const map = (surface as unknown as { pendingConfirms: Map<string, PendingSubmitLike> }).pendingConfirms;
  return [...map.values()].filter((pending) => pending.kind === 'submit');
}

describe('Slack approve-button repro contracts', () => {
  let adapter: SQLiteAdapter;
  let repo: ConversationRepository;
  let slackSessions: SlackSessionRepository;
  let surfaces: SlackSurface[];
  let tempDirs: string[];

  beforeEach(async () => {
    mockSpawn.mockReset();
    sharedSlack.client.chat.postMessage.mockClear();
    sharedSlack.client.chat.update.mockClear();
    sharedSlack.client.chat.delete.mockClear();
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new ConversationRepository(adapter, { info: silentLog, warn: silentLog, error: silentLog });
    slackSessions = new SlackSessionRepository(adapter);
    surfaces = [];
    tempDirs = [];
  });

  afterEach(async () => {
    await Promise.all(surfaces.map((surface) => surface.stop()));
    adapter.close();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function surface(commands: SurfaceCommand[], workingDir: string): SlackSurface {
    const created = new SlackSurface({
      botToken: 'xoxb-proof',
      appToken: 'xapp-proof',
      signingSecret: 'proof',
      channelId: 'C_DEFAULT',
      defaultRepoUrl: 'https://github.com/example/repo.git',
      lobbyChannelId: 'C_LOBBY',
      conversationRepo: repo,
      slackSessionRepo: slackSessions,
      enableImmediateAck: false,
      planningHeartbeatIntervalSeconds: 0,
      workingDir,
      log: silentLog,
    });
    surfaces.push(created);
    return created;
  }

  function newWorkingDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-draft-repro-'));
    tempDirs.push(dir);
    return dir;
  }

  it('stages an Approve button when the draft file is unsummarizable but the reply has a valid plan', async () => {
    const commands: SurfaceCommand[] = [];
    const workingDir = newWorkingDir();
    const slack = surface(commands, workingDir);
    await slack.start(async (command) => { commands.push(command); });

    mockSpawn.mockImplementationOnce(() => {
      // The planner writes a truncated draft file (parses, but cannot be
      // summarized), while its chat reply still carries a complete plan.
      // This runs after resetPlanDraftFile() because spawn happens inside
      // sendMessage, after the reset.
      const draftDir = join(workingDir, '.invoker', 'plan-drafts');
      mkdirSync(draftDir, { recursive: true });
      writeFileSync(join(draftDir, 'thread-a1.yaml'), unsummarizableDraft);
      return processWith(goodPlanReply);
    });

    const say = await mention(slack, 'plan: draft it', 'thread-a1');

    expect(confirmButtonValue(say)).not.toBeNull();
    const submits = pendingSubmits(slack);
    expect(submits.some((pending) => pending.planText?.includes('name: Good'))).toBe(true);
  });

  it('carries the Approve/Reject actions on the same message as the drafted plan brief', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands, newWorkingDir());
    await slack.start(async (command) => { commands.push(command); });

    mockSpawn.mockImplementationOnce(() => processWith(goodPlanReply));
    const say = await mention(slack, 'plan: draft it cleanly', 'thread-a2');

    const briefed = say.mock.calls
      .map((call) => call[0] as SaidMessage)
      .find((message) => message.text?.includes('Drafted *'));
    expect(briefed).toBeDefined();
    const actions = briefed?.blocks?.find((block) => block.type === 'actions');
    expect(actions?.elements?.some((element) => element.action_id === 'lobby_confirm')).toBe(true);
  });
});
