import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import { PlanConversation } from '../slack/plan-conversation.js';
import { SQLiteAdapter, ConversationRepository, SlackPlanDraftRepository, SlackSessionRepository, WorkflowChannelRepository } from '@invoker/data-store';
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

vi.mock('@slack/bolt', () => {
  class MockApp {
    _commandHandlers: MockHandler[] = [];
    _actionHandlers: MockHandler[] = [];
    _eventHandlers: MockHandler[] = [];
    command = vi.fn((name: string, handler: Function) => {
      this._commandHandlers.push({ pattern: name, handler });
    });
    action = vi.fn((pattern: string | RegExp, handler: Function) => {
      this._actionHandlers.push({ pattern, handler });
    });
    event = vi.fn((name: string, handler: Function) => {
      this._eventHandlers.push({ pattern: name, handler });
    });
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.123456' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue({ files: [{ id: 'F1' }] }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      },
    };
  }
  return { App: MockApp };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const mockSpawn = vi.mocked(child_process.spawn);

const capturedPrompts: string[] = [];

function plannerTurn(stdout: string, sideEffect?: () => void): void {
  mockSpawn.mockImplementationOnce((_cmd: any, args: any) => {
    const stringArgs = (args as string[]).filter((a) => typeof a === 'string');
    capturedPrompts.push(stringArgs.reduce((longest, arg) => (arg.length > longest.length ? arg : longest), ''));
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    setTimeout(() => {
      sideEffect?.();
      proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('close', 0);
    }, 0);
    return proc;
  });
}

function initSandboxRepo(prefix: string): string {
  const workingDir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init'], { cwd: workingDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workingDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workingDir });
  writeFileSync(join(workingDir, 'index.css'), ':root { --background: 10 10 10; }\n');
  execFileSync('git', ['add', '.'], { cwd: workingDir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: workingDir });
  return workingDir;
}

function trackedChanges(workingDir: string): string[] {
  return execFileSync('git', ['status', '--porcelain'], { cwd: workingDir, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.startsWith('??'));
}

const PINK_REQUEST = 'lets change the theme of the app from black to pink';
const SCOPING_REPLY = 'The colors live in packages/ui/src/index.css as CSS variables. Do you want me to draft the YAML plan?';
const DRAFT_REPLY = 'Draft ready — pink retheme in 2 steps.';

const VALID_PLAN_YAML = `name: "Pink Theme Retheme"
repoUrl: "https://github.com/example/repo.git"
onFinish: pull_request
mergeMode: external_review
baseBranch: master
tasks:
  - id: retheme-tokens
    description: "Swap theme tokens to pink"
    prompt: "Edit index.css"
    dependencies: []
  - id: verify-tokens
    description: "Verify"
    command: "cd packages/ui && pnpm test"
    dependencies: [retheme-tokens]
`;

function writeDraftFile(workingDir: string, threadTs: string): void {
  const path = join(workingDir, '.invoker', 'plan-drafts', `${threadTs}.yaml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, VALID_PLAN_YAML);
}

function normalizePrompt(prompt: string, workingDir: string): string {
  return prompt.split(workingDir).join('<worktree>');
}

describe('Slack and planning-terminal parity for the same request (real surface, real conversation engine)', () => {
  let slackDir: string;
  let terminalDir: string;

  beforeEach(() => {
    mockSpawn.mockReset();
    capturedPrompts.length = 0;
    slackDir = initSandboxRepo('invoker-parity-slack-');
    terminalDir = initSandboxRepo('invoker-parity-terminal-');
  });

  afterEach(() => {
    rmSync(slackDir, { recursive: true, force: true });
    rmSync(terminalDir, { recursive: true, force: true });
  });

  it('the pink request gets the identical scoping-then-gated-draft experience on both surfaces', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    const surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      cursorCommand: 'cursor',
      workingDir: slackDir,
      defaultRepoUrl: 'https://github.com/example/repo.git',
      conversationalPlanning: true,
      conversationRepo: new ConversationRepository(adapter),
      slackSessionRepo: new SlackSessionRepository(adapter),
      slackPlanDraftRepo: new SlackPlanDraftRepository(adapter),
      workflowChannelRepo: new WorkflowChannelRepository(adapter),
    });
    await surface.start(async () => {});
    const app = surface.getApp() as any;
    const mentionHandler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')!.handler;
    const say = vi.fn().mockResolvedValue({ ts: 'reply-ts' });

    const terminal = new PlanConversation({
      cursorCommand: 'cursor',
      mode: 'plan',
      conversationalPlanning: true,
      workingDir: terminalDir,
      threadTs: 'thread-pink',
    });

    plannerTurn(SCOPING_REPLY);
    await mentionHandler({ event: { text: `<@UBOT> ${PINK_REQUEST}`, ts: 'thread-pink', user: 'U1' }, say });

    plannerTurn(SCOPING_REPLY);
    const terminalScopingReply = await terminal.sendMessage(PINK_REQUEST);

    expect(capturedPrompts).toHaveLength(2);
    const slackScopingPrompt = normalizePrompt(capturedPrompts[0], slackDir);
    const terminalScopingPrompt = normalizePrompt(capturedPrompts[1], terminalDir);
    expect(slackScopingPrompt).toBe(terminalScopingPrompt);
    expect(slackScopingPrompt).toContain('conversational planning mode');
    expect(slackScopingPrompt).toContain('Drafting is not authorized yet');
    expect(slackScopingPrompt).not.toContain('edit code');
    expect(terminalScopingReply).toBe(SCOPING_REPLY);
    expect(app.client.files.uploadV2).not.toHaveBeenCalled();
    expect(trackedChanges(slackDir)).toEqual([]);
    expect(trackedChanges(terminalDir)).toEqual([]);

    plannerTurn(DRAFT_REPLY, () => writeDraftFile(slackDir, 'thread-pink'));
    await mentionHandler({
      event: { text: '<@UBOT> yes', ts: 'msg-2', thread_ts: 'thread-pink', user: 'U1', channel: 'C-test' },
      say,
    });

    plannerTurn(DRAFT_REPLY, () => writeDraftFile(terminalDir, 'thread-pink'));
    await terminal.sendMessage('yes');

    expect(capturedPrompts).toHaveLength(4);
    const slackDraftPrompt = normalizePrompt(capturedPrompts[2], slackDir);
    const terminalDraftPrompt = normalizePrompt(capturedPrompts[3], terminalDir);
    expect(slackDraftPrompt).toBe(terminalDraftPrompt);
    expect(slackDraftPrompt).toContain('Only the hosting surface (the Slack orchestrator or the in-app planner) may submit the plan');
    expect(slackDraftPrompt).toContain(join('<worktree>', '.invoker', 'plan-drafts', 'thread-pink.yaml'));

    const cardCall = say.mock.calls.find(([msg]) => typeof msg?.text === 'string' && msg.text.includes('Pink Theme Retheme'));
    expect(cardCall).toBeDefined();
    expect(app.client.files.uploadV2).toHaveBeenCalledTimes(1);

    expect(terminal.lastTurnDraftPlanText).toBe(VALID_PLAN_YAML.trim());
    expect(terminal.planSubmitted).toBe(false);

    expect(mockSpawn.mock.calls.map((call) => call[0])).toEqual(['cursor', 'cursor', 'cursor', 'cursor']);
    expect(trackedChanges(slackDir)).toEqual([]);
    expect(trackedChanges(terminalDir)).toEqual([]);
  });
});
