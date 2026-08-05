/**
 * Repro contracts for issue 1: an explicit Slack PlanDraft review must always
 * arrive with an Approve button once its YAML attachment is ready.
 *
 * Root cause under test: a parseable-but-unsummarizable plan-draft file must
 * not shadow a valid fenced plan in the planner reply, or the review card would
 * be posted without a usable Approve action.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRepository, SlackPlanDraftRepository, SlackSessionRepository, SQLiteAdapter } from '@invoker/data-store';
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

const sharedSlack = vi.hoisted(() => ({
  client: {
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }) },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted' }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    files: { uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [{ ok: true, files: [{ id: 'F-proof' }] }] }) },
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

function actionValueFromUpdatedCard(actionId: string): string | null {
  for (const call of [...sharedSlack.client.chat.update.mock.calls].reverse()) {
    const message = call[0] as SaidMessage | undefined;
    for (const block of message?.blocks ?? []) {
      for (const element of block.elements ?? []) {
        if (element.action_id === actionId && typeof element.value === 'string') {
          return element.value;
        }
      }
    }
  }
  return null;
}

function updatedCardWithAction(actionId: string): SaidMessage | undefined {
  return [...sharedSlack.client.chat.update.mock.calls]
    .map((call) => call[0] as SaidMessage)
    .find((message) => message.blocks?.some((block) =>
      block.elements?.some((element) => element.action_id === actionId)));
}

describe('Slack approve-button repro contracts', () => {
  let adapter: SQLiteAdapter;
  let repo: ConversationRepository;
  let slackSessions: SlackSessionRepository;
  let slackPlanDrafts: SlackPlanDraftRepository;
  let surfaces: SlackSurface[];
  let tempDirs: string[];

  beforeEach(async () => {
    mockSpawn.mockReset();
    sharedSlack.client.chat.postMessage.mockClear();
    sharedSlack.client.chat.update.mockClear();
    sharedSlack.client.chat.delete.mockClear();
    sharedSlack.client.files.uploadV2.mockClear();
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new ConversationRepository(adapter, { info: silentLog, warn: silentLog, error: silentLog });
    slackSessions = new SlackSessionRepository(adapter);
    slackPlanDrafts = new SlackPlanDraftRepository(adapter);
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
      slackPlanDraftRepo: slackPlanDrafts,
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

    mockSpawn.mockImplementationOnce(() => processWith('Scope captured.'));
    await mention(slack, 'build this feature', 'thread-a1');
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

    await mention(slack, '/plan', 'thread-a1-plan', 'thread-a1');

    const draft = slackPlanDrafts.getReady('C_LOBBY', 'thread-a1');
    expect(draft?.planText).toContain('name: Good');
    expect(actionValueFromUpdatedCard('plan_draft_approve')).toBe(`${draft?.draftId}:${draft?.version}`);
  });

  it('carries the Approve/Cancel actions on the same message as the drafted plan brief', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands, newWorkingDir());
    await slack.start(async (command) => { commands.push(command); });

    mockSpawn.mockImplementationOnce(() => processWith('Scope captured.'));
    await mention(slack, 'build it cleanly', 'thread-a2');
    mockSpawn.mockImplementationOnce(() => processWith(goodPlanReply));
    await mention(slack, '/plan', 'thread-a2-plan', 'thread-a2');

    const briefed = updatedCardWithAction('plan_draft_approve');
    expect(briefed).toBeDefined();
    const actions = briefed?.blocks?.find((block) => block.type === 'actions');
    expect(briefed?.text).toContain('Good');
    expect(actions?.elements?.some((element) => element.action_id === 'plan_draft_approve')).toBe(true);
    expect(actions?.elements?.some((element) => element.action_id === 'plan_draft_cancel')).toBe(true);
  });
});
