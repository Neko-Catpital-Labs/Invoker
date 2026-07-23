import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { ConversationRepository, SlackSessionRepository, SQLiteAdapter, WorkflowChannelRepository } from '@invoker/data-store';
import { SlackSurface } from '../slack/slack-surface.js';
import type { SurfaceCommand } from '../surface.js';
import { SessionIdentifier } from '../slack/thread-session-manager.js';

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
const plan = `\`\`\`yaml
name: "Proof plan"
tasks:
  - id: proof
    description: "Exercise the submission flow"
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

function actionHandler(surface: SlackSurface, pattern: string): Function {
  const found = (surface.getApp() as any)._actionHandlers.find((entry: MockHandler) => entry.pattern === pattern);
  if (!found) throw new Error(`Missing ${pattern} action handler`);
  return found.handler;
}

function config(repo: ConversationRepository, extra: Partial<ConstructorParameters<typeof SlackSurface>[0]> = {}) {
  return {
    botToken: 'xoxb-proof',
    appToken: 'xapp-proof',
    signingSecret: 'proof',
    channelId: 'C_DEFAULT',
    defaultRepoUrl: 'https://github.com/example/repo.git',
    lobbyChannelId: 'C_LOBBY',
    conversationRepo: repo,
    enableImmediateAck: false,
    planningHeartbeatIntervalSeconds: 0,
    log: silentLog,
    ...extra,
  };
}

async function start(surface: SlackSurface, commands: SurfaceCommand[]) {
  await surface.start(async (command) => { commands.push(command); });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mention(surface: SlackSurface, text: string, ts: string, threadTs?: string) {
  const say = vi.fn().mockResolvedValue({ ts: `${ts}-reply` });
  await handler(surface, 'app_mention')({
    event: { text: `<@UBOT> ${text}`, ts, thread_ts: threadTs, user: 'U_PROOF', channel: 'C_LOBBY' },
    say,
  });
  return say;
}

async function reply(surface: SlackSurface, text: string, threadTs: string) {
  const say = vi.fn().mockResolvedValue({ ts: `${threadTs}-reply` });
  await handler(surface, 'message')({
    event: { text, ts: `${threadTs}-child`, thread_ts: threadTs, user: 'U_PROOF', channel: 'C_LOBBY' },
    say,
  });
  return say;
}

describe('Slack plan submission restart repro contracts', () => {
  let adapter: SQLiteAdapter;
  let repo: ConversationRepository;
  let slackSessions: SlackSessionRepository;
  let workflowChannels: WorkflowChannelRepository;
  let surfaces: SlackSurface[];

  beforeEach(async () => {
    mockSpawn.mockReset();
    sharedSlack.client.auth.test.mockClear();
    sharedSlack.client.chat.postMessage.mockClear();
    sharedSlack.client.chat.update.mockClear();
    sharedSlack.client.chat.delete.mockClear();
    sharedSlack.client.conversations.replies.mockReset();
    sharedSlack.client.conversations.replies.mockResolvedValue({ messages: [] });
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new ConversationRepository(adapter, { info: silentLog, warn: silentLog, error: silentLog });
    slackSessions = new SlackSessionRepository(adapter);
    workflowChannels = new WorkflowChannelRepository(adapter);
    surfaces = [];
  });

  afterEach(async () => {
    await Promise.all(surfaces.map((surface) => surface.stop()));
    adapter.close();
  });

  function surface(commands: SurfaceCommand[], extra: Partial<ConstructorParameters<typeof SlackSurface>[0]> = {}) {
    const created = new SlackSurface(config(repo, { slackSessionRepo: slackSessions, ...extra }));
    surfaces.push(created);
    return created;
  }

  it('promotes an agent thread when a tagged plan reply requests an Invoker plan', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    await start(slack, commands);
    mockSpawn.mockImplementationOnce(() => processWith('Agent response'));
    await mention(slack, 'fix the agent routing', 'thread-agent');
    mockSpawn.mockImplementationOnce(() => processWith(`${plan}\n\nInternal planner prose that must not reach Slack.`));
    const say = await mention(slack, 'plan: draft a real migration plan', 'thread-agent-plan', 'thread-agent');
    const current = (slack as any).sessionManager.findSession(new SessionIdentifier('C_LOBBY', 'thread-agent'));
    expect(current?.conversationMode).toBe('plan');
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Drafted *Proof plan* (1 task). Delivery order: 1) Exercise the submission flow.'),
    }));
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Approve to execute'),
    }));
    expect(say.mock.calls[0][0].text.split(/\s+/).length).toBeLessThan(100);
    expect(say.mock.calls[0][0].text).not.toContain('• Exercise the submission flow');
    expect(say.mock.calls[0][0].text).not.toContain('Internal planner prose');
    expect(say.mock.calls[0][0].blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'actions' }),
    ]));
    await actionHandler(slack, 'lobby_confirm')({
      action: { type: 'button', value: 'thread-agent' },
      body: { channel: { id: 'C_LOBBY' }, message: { thread_ts: 'thread-agent' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });
    expect(commands).toContainEqual(expect.objectContaining({ type: 'start_plan' }));
  });

  it('drafts a submittable plan from the exact live-thread wording and its source thread context', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    sharedSlack.client.conversations.replies.mockResolvedValue({
      messages: [
        { text: 'Please prioritize the Orca-inspired reply: attention inbox, workflow cards, gates, batch review notes, presets, mobile polish, and usage chips.' },
        { text: '@Invoker please draft a plan for this' },
      ],
    });
    await start(slack, commands);
    mockSpawn.mockImplementationOnce(() => processWith(plan));

    const say = await mention(
      slack,
      'please draft a plan for this',
      'incident-thread',
    );

    expect((slack as any).sessionManager.findSession(new SessionIdentifier('C_LOBBY', 'incident-thread'))?.conversationMode).toBe('plan');
    expect(JSON.stringify(mockSpawn.mock.calls[0])).toContain('attention inbox');
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Approve to execute'),
    }));
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Drafted *Proof plan* (1 task). Delivery order: 1) Exercise the submission flow.'),
    }));
    expect(say.mock.calls[0][0].blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        elements: expect.arrayContaining([
          expect.objectContaining({ action_id: 'lobby_confirm', text: expect.objectContaining({ text: 'Approve' }) }),
          expect.objectContaining({ action_id: 'lobby_cancel', text: expect.objectContaining({ text: 'Reject' }) }),
        ]),
      }),
    ]));
  });

  it('uses untagged replies as context only when Invoker is tagged again', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    await start(slack, commands);
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await mention(slack, 'plan: draft the first version', 'passive-context-thread');

    const passiveSay = await reply(slack, 'Please also include the mobile workflow.', 'passive-context-thread');
    expect(passiveSay).not.toHaveBeenCalled();

    sharedSlack.client.conversations.replies.mockResolvedValue({
      messages: [
        { text: 'plan: draft the first version' },
        { text: 'Please also include the mobile workflow.' },
        { text: '@Invoker plan: revise the draft' },
      ],
    });
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await mention(slack, 'plan: revise the draft', 'passive-context-mention', 'passive-context-thread');

    expect(JSON.stringify(mockSpawn.mock.calls.at(-1))).toContain('Please also include the mobile workflow.');
  });

  it('stages the drafted plan for approval without routing another message to the planner', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    await start(slack, commands);
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    const say = await mention(slack, 'plan: create a proof', 'thread-submit');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Approve to execute') }));
    expect((slack as any).pendingConfirms.get('thread-submit')).toEqual(expect.objectContaining({ kind: 'submit' }));
  });

  it('cancels an inline plan approval without starting the plan', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    await start(slack, commands);
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await mention(slack, 'plan: cancel this draft', 'thread-cancel');

    const respond = vi.fn().mockResolvedValue(undefined);
    await actionHandler(slack, 'lobby_cancel')({
      action: { type: 'button', value: 'thread-cancel' },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });

    expect(respond).toHaveBeenCalledWith({ text: '❌ Cancelled.', replace_original: true });
    expect((slack as any).pendingConfirms.get('thread-cancel')).toBeUndefined();
    expect(commands).not.toContainEqual(expect.objectContaining({ type: 'start_plan' }));
  });

  it('restores non-default repo and preset context after a SlackSurface restart', async () => {
    const commands: SurfaceCommand[] = [];
    const first = surface(commands, {
      repoAliases: { proof: 'https://example.test/proof.git' },
      harnessPresets: { special: { tool: 'special-tool', model: 'special-model' } },
      defaultHarnessPreset: 'special',
    });
    await start(first, commands);
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await mention(first, '[special] [repo:proof] plan: preserve context', 'thread-context');
    expect((first as any).planningContexts.get('thread-context')).toEqual(expect.objectContaining({
      repoUrl: 'https://example.test/proof.git',
      presetKey: 'special',
    }));
    await first.stop();
    surfaces = surfaces.filter((candidate) => candidate !== first);

    const second = surface(commands, {
      repoAliases: { proof: 'https://example.test/proof.git' },
      harnessPresets: { special: { tool: 'special-tool', model: 'special-model' } },
      defaultRepoUrl: 'https://example.test/default.git',
    });
    await start(second, commands);
    const restored = (second as any).sessionManager.findSession(new SessionIdentifier('C_LOBBY', 'thread-context'));
    expect(restored?.conversationMode).toBe('plan');
    expect((restored?.conversation as any).tool).toBe('special-tool');
    expect((restored?.conversation as any).model).toBe('special-model');
    await mention(second, 'yes', 'confirm-context', 'thread-context');
    expect(commands).toContainEqual(expect.objectContaining({
      type: 'start_plan',
      repoUrl: 'https://example.test/proof.git',
      harnessPreset: 'special',
    }));
  });

  it('reacquires an external repository checkout before restoring its thread', async () => {
    const commands: SurfaceCommand[] = [];
    const firstCheckout = vi.fn().mockResolvedValue('/planning-clones/proof-first');
    const first = surface(commands, {
      repoAliases: { proof: 'https://example.test/proof.git' },
      defaultRepoUrl: 'https://example.test/default.git',
      prepareRepoCheckout: firstCheckout,
    });
    await start(first, commands);
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await mention(first, '[repo:proof] plan: preserve checkout', 'thread-reacquire');
    expect(firstCheckout).toHaveBeenCalledWith('https://example.test/proof.git');
    await first.stop();
    surfaces = surfaces.filter((candidate) => candidate !== first);

    const restoredCheckout = vi.fn().mockResolvedValue('/planning-clones/proof-restored');
    const second = surface(commands, {
      repoAliases: { proof: 'https://example.test/proof.git' },
      defaultRepoUrl: 'https://example.test/default.git',
      prepareRepoCheckout: restoredCheckout,
    });
    await start(second, commands);

    expect(restoredCheckout).toHaveBeenCalledWith('https://example.test/proof.git');
    expect((second as any).planningContexts.get('thread-reacquire')).toEqual(expect.objectContaining({
      workingDir: '/planning-clones/proof-restored',
    }));
  });

  it('refuses an owned thread retarget to a different repository', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands, {
      repoAliases: {
        proof: 'https://example.test/proof.git',
        other: 'https://example.test/other.git',
      },
      defaultRepoUrl: 'https://example.test/default.git',
    });
    await start(slack, commands);
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await mention(slack, '[repo:proof] plan: pin this repository', 'thread-retarget');

    const say = await mention(slack, '[repo:other] plan: switch repositories', 'retarget-turn', 'thread-retarget');
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('already pinned to a different repository'),
    }));
    expect((slack as any).planningContexts.get('thread-retarget')).toEqual(expect.objectContaining({
      repoUrl: 'https://example.test/proof.git',
    }));
  });

  it('restores a staged submit confirmation after a SlackSurface restart', async () => {
    const commands: SurfaceCommand[] = [];
    const first = surface(commands);
    await start(first, commands);
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await mention(first, 'plan: stage a submission', 'thread-confirm');
    expect((first as any).pendingConfirms.get('thread-confirm')).toEqual(expect.objectContaining({ kind: 'submit' }));
    await first.stop();
    surfaces = surfaces.filter((candidate) => candidate !== first);

    const second = surface(commands);
    await start(second, commands);
    const say = await mention(second, 'yes', 'confirm-thread', 'thread-confirm');
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Starting plan execution') }));
    expect(commands).toContainEqual(expect.objectContaining({ type: 'start_plan' }));
  });

  it('restores a staged submit confirmation for an approval button after restart', async () => {
    const commands: SurfaceCommand[] = [];
    const first = surface(commands);
    await start(first, commands);
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await mention(first, 'plan: stage a button submission', 'thread-button-confirm');
    await first.stop();
    surfaces = surfaces.filter((candidate) => candidate !== first);

    const second = surface(commands);
    await start(second, commands);
    const respond = vi.fn().mockResolvedValue(undefined);
    await actionHandler(second, 'lobby_confirm')({
      action: { type: 'button', value: 'thread-button-confirm' },
      body: {
        channel: { id: 'C_LOBBY' },
        message: { ts: 'submitted-plan-message', thread_ts: 'thread-button-confirm' },
      },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });
    expect(sharedSlack.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C_LOBBY',
      ts: 'submitted-plan-message',
      text: expect.stringContaining('✅ Plan submitted.'),
      blocks: [],
    }));
    expect(sharedSlack.client.chat.update.mock.calls[0][0].text).toContain('Drafted *Proof plan* (1 task).');
    expect(commands).toContainEqual(expect.objectContaining({ type: 'start_plan' }));
  });

  it('recovers a plan submission from its thread when the pending confirmation is unavailable', async () => {
    const commands: SurfaceCommand[] = [];
    const first = surface(commands);
    await start(first, commands);
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await mention(first, 'plan: recover a missing confirmation', 'thread-recover-confirm');
    slackSessions.deletePendingConfirmation('thread-recover-confirm');
    await first.stop();
    surfaces = surfaces.filter((candidate) => candidate !== first);

    const second = surface(commands);
    await start(second, commands);
    await actionHandler(second, 'lobby_confirm')({
      action: { type: 'button', value: 'thread-recover-confirm' },
      body: {
        channel: { id: 'C_LOBBY' },
        message: { ts: 'recovered-plan-message', thread_ts: 'thread-recover-confirm' },
        user: { id: 'U_PROOF' },
      },
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });

    expect(sharedSlack.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C_LOBBY',
      ts: 'recovered-plan-message',
      text: expect.stringContaining('✅ Plan submitted.'),
      blocks: [],
    }));
    expect(commands).toContainEqual(expect.objectContaining({ type: 'start_plan' }));
  });

  it('retains an untagged thread reply as passive context without invoking Invoker', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    await start(slack, commands);
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await mention(slack, 'plan: recover me', 'thread-evicted');
    const manager = (slack as any).sessionManager;
    const id = new SessionIdentifier('C_LOBBY', 'thread-evicted');
    expect(repo.loadConversation('thread-evicted')?.messages).toHaveLength(2);
    expect(manager.evictSession(id)).toBe(true);
    expect(manager.findSession(id)).toBeNull();
    const replySay = await reply(slack, 'continue', 'thread-evicted');
    expect(replySay).not.toHaveBeenCalled();
  });

  it('cleans up a submitted session using its actual channel ID', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    await start(slack, commands);
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await mention(slack, 'plan: clean up in the lobby', 'thread-cleanup');
    await mention(slack, 'yes', 'confirm-cleanup', 'thread-cleanup');
    const manager = (slack as any).sessionManager;
    const actualId = new SessionIdentifier('C_LOBBY', 'thread-cleanup');
    expect(manager.findSession(new SessionIdentifier('C_DEFAULT', 'thread-cleanup'))).toBeNull();
    expect(manager.getMetrics().submitted).toBe(1);
    expect(manager.findSession(actualId)).not.toBeNull();
  });

  it('preserves a staged submit after a non-confirmation reply', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    await start(slack, commands);
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await mention(slack, 'plan: keep my confirmation', 'thread-reply');
    expect((slack as any).pendingConfirms.get('thread-reply')).toEqual(expect.objectContaining({ kind: 'submit' }));
    const nonConfirmationSay = await reply(slack, 'add a note before submitting', 'thread-reply');
    expect((slack as any).pendingConfirms.get('thread-reply')).toEqual(expect.objectContaining({ kind: 'submit' }));
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(nonConfirmationSay).not.toHaveBeenCalled();
    const yesSay = await mention(slack, 'yes', 'confirm-reply', 'thread-reply');
    expect(yesSay).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Starting plan execution') }));
    expect(commands).toContainEqual(expect.objectContaining({ type: 'start_plan' }));
  });

  it('preserves explicit repo and preset when an agent thread is promoted to plan mode', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands, {
      repoAliases: { proof: 'https://example.test/proof.git' },
      harnessPresets: { special: { tool: 'special-tool', model: 'special-model' } },
      defaultHarnessPreset: 'default',
      defaultRepoUrl: 'https://example.test/default.git',
    });
    await start(slack, commands);
    mockSpawn.mockImplementationOnce(() => processWith('Agent response'));
    await mention(slack, '[special] [repo:proof] local: fix this first', 'thread-promotion');
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await mention(slack, 'plan: preserve the explicit target context', 'promote-thread', 'thread-promotion');
    expect((slack as any).sessionManager.findSession(new SessionIdentifier('C_LOBBY', 'thread-promotion'))?.conversationMode).toBe('plan');
    expect((slack as any).planningContexts.get('thread-promotion')).toEqual(expect.objectContaining({ presetKey: 'special' }));
    await mention(slack, 'yes', 'confirm-promotion', 'thread-promotion');
    expect(commands).toContainEqual(expect.objectContaining({
      type: 'start_plan',
      repoUrl: 'https://example.test/proof.git',
      harnessPreset: 'special',
    }));
  });

  it('updates the existing progress card after SlackSurface restart', async () => {
    const commands: SurfaceCommand[] = [];
    workflowChannels.save({
      workflowId: 'wf-proof',
      channelId: 'C_PRIVATE_PROOF',
      createdAt: new Date().toISOString(),
    });
    const first = surface(commands, { workflowChannelRepo: workflowChannels });
    await start(first, commands);
    const progress = {
      workflowId: 'wf-proof',
      name: 'Proof workflow',
      percentComplete: 50,
      counts: { total: 2, completed: 1, failed: 0, closed: 0, running: 1, pending: 0 },
      tasks: [],
    };
    await first.handleEvent({ type: 'workflow_progress', progress });
    expect(sharedSlack.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C_PRIVATE_PROOF',
    }));
    await first.stop();
    surfaces = surfaces.filter((candidate) => candidate !== first);

    const second = surface(commands, { workflowChannelRepo: workflowChannels });
    await start(second, commands);
    await second.handleEvent({ type: 'workflow_progress', progress });
    expect(sharedSlack.client.chat.postMessage).toHaveBeenCalledOnce();
    expect(sharedSlack.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C_PRIVATE_PROOF',
      ts: 'posted',
    }));
    expect(sharedSlack.client.chat.postMessage.mock.calls.every(([message]: any[]) => message.channel === 'C_PRIVATE_PROOF')).toBe(true);
  });
});
