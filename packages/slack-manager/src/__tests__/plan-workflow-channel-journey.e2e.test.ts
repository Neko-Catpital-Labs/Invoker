import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SQLiteAdapter, SlackPlanDraftRepository, WorkflowChannelRepository } from '@invoker/data-store';
import { Channels } from '@invoker/transport';
import type { SurfaceEvent } from '@invoker/surfaces';
import { SlackSurface } from '../../../surfaces/src/slack/slack-surface.js';
import { createCommandHandler } from '../command-handler.js';
import { startEventSubscription } from '../event-subscription.js';
import type { InvokerClient } from '../invoker-client.js';
import {
  JOURNEY,
  maybeUpdateJourneyArtifact,
  readJourneyArtifact,
  renderJourneyArtifact,
  type JourneyLedgerEntry,
} from './fixtures/plan-workflow-channel-experience.js';

interface RegisteredHandler {
  pattern: string | RegExp;
  handler: Function;
}

const slackFake = vi.hoisted(() => ({
  ledger: [] as Array<Record<string, unknown>>,
  channelIds: [] as string[],
  inviteFailures: new Map<string, string>(),
  postSequence: 0,
  actionHandlers: [] as RegisteredHandler[],
}));

vi.mock('@slack/bolt', () => {
  class DeterministicSlackApp {
    _actionHandlers = slackFake.actionHandlers;
    command = vi.fn();
    event = vi.fn();
    action = vi.fn((pattern: string | RegExp, handler: Function) => {
      this._actionHandlers.push({ pattern, handler });
    });
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_INVOKER_BOT' }) },
      chat: {
        postMessage: vi.fn(async (message: { channel: string; text?: string; thread_ts?: string }) => {
          const messageTs = `M${String(++slackFake.postSequence).padStart(3, '0')}`;
          slackFake.ledger.push({
            operation: 'post',
            channelId: message.channel,
            ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
            messageTs,
            text: message.text ?? '',
          });
          return { ts: messageTs };
        }),
        update: vi.fn(async (message: { channel: string; ts: string; text?: string }) => {
          slackFake.ledger.push({
            operation: 'update',
            channelId: message.channel,
            messageTs: message.ts,
            text: message.text ?? '',
          });
          return {};
        }),
        delete: vi.fn().mockResolvedValue({}),
      },
      conversations: {
        create: vi.fn(async (request: { name: string; is_private: boolean }) => {
          const channelId = slackFake.channelIds.shift();
          if (!channelId) throw new Error(`No deterministic channel configured for ${request.name}`);
          slackFake.ledger.push({
            operation: 'create',
            channelId,
            name: request.name,
            isPrivate: request.is_private,
          });
          return { channel: { id: channelId } };
        }),
        invite: vi.fn(async (request: { channel: string; users: string }) => {
          const errorCode = slackFake.inviteFailures.get(request.channel);
          slackFake.ledger.push({
            operation: 'invite',
            channelId: request.channel,
            userId: request.users,
            outcome: errorCode ? `error:${errorCode}` : 'ok',
          });
          if (errorCode) throw { data: { error: errorCode } };
          return {};
        }),
        list: vi.fn().mockResolvedValue({ channels: [] }),
        replies: vi.fn().mockResolvedValue({ messages: [{ files: [{ id: 'F_DRAFT_YAML' }] }] }),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue({ files: [{ files: [{ id: 'F_DRAFT_YAML' }] }] }),
      },
      pins: { add: vi.fn().mockResolvedValue({}) },
      reactions: { add: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({}) },
    };
  }
  return { App: DeterministicSlackApp };
});

const SLACK_PLAN = [
  'name: Slack approved plan',
  'repoUrl: https://github.com/invoker/slack-proof.git',
  'onFinish: none',
  'tasks:',
  '  - id: prove-slack',
  '    description: Prove the Slack-originated path',
  '    command: pnpm test',
  '    dependencies: []',
  '',
].join('\n');

const IN_APP_PLAN = [
  'name: Configured in-app plan',
  'repoUrl: https://github.com/invoker/in-app-proof.git',
  'onFinish: none',
  'tasks:',
  '  - id: prove-in-app',
  '    description: Prove the configured in-app path',
  '    command: pnpm test',
  '    dependencies: []',
  '',
].join('\n');

function makeInvokerClient(): InvokerClient {
  return {
    ping: vi.fn(async () => true),
    isHealthy: vi.fn(async () => true),
    listWorkflows: vi.fn(async () => []),
    getWorkflowBundle: vi.fn(async () => ({ workflow: undefined, tasks: [] })),
    getWorkflowStatus: vi.fn(async () => ({ total: 0, completed: 0, failed: 0, closed: 0, running: 0, pending: 0 })),
    getTaskOutput: vi.fn(async () => ''),
    exec: vi.fn(async () => {}),
    run: vi.fn(async (planFile: string) => {
      expect(readFileSync(planFile, 'utf8')).toBe(SLACK_PLAN);
      return { workflowId: JOURNEY.slack.workflowId, workflowIds: [JOURNEY.slack.workflowId] };
    }),
    launch: vi.fn(async () => ({ healthy: true })),
    withRecovery: vi.fn(async (fn: () => Promise<unknown>) => fn()) as InvokerClient['withRecovery'],
    subscribe: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
    disconnect: vi.fn(),
  };
}

function progress(workflowId: string, percentComplete: number): SurfaceEvent {
  return {
    type: 'workflow_progress',
    progress: {
      workflowId,
      name: workflowId,
      percentComplete,
      counts: { total: 2, completed: percentComplete === 50 ? 1 : 0, failed: 0, closed: 0, running: 1, pending: percentComplete === 50 ? 0 : 1 },
      tasks: [{ id: `${workflowId}/proof`, name: 'Proof', status: 'running', phase: 'executing' }],
    },
  };
}

describe('plan → workflow channel journey', () => {
  let adapter: SQLiteAdapter | undefined;
  let tempDir: string | undefined;
  let surface: SlackSurface | undefined;

  afterEach(async () => {
    await surface?.stop();
    adapter?.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    slackFake.ledger.splice(0);
    slackFake.channelIds.splice(0);
    slackFake.inviteFailures.clear();
    slackFake.actionHandlers.splice(0);
    slackFake.postSequence = 0;
  });

  it('literally proves Slack approval, configured in-app entry, routing isolation, invite failure, and duplicate delivery in one trace', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'plan-workflow-channel-journey-'));
    adapter = await SQLiteAdapter.create(':memory:');
    const drafts = new SlackPlanDraftRepository(adapter);
    const mappings = new WorkflowChannelRepository(adapter);
    const realSave = mappings.save.bind(mappings);
    mappings.save = (record) => {
      (slackFake.ledger as JourneyLedgerEntry[]).push({
        operation: 'mapping',
        workflowId: record.workflowId,
        channelId: record.channelId,
        requestedBy: record.requestedBy,
        lobbyChannelId: record.lobbyChannelId,
        lobbyThreadTs: record.lobbyThreadTs,
      });
      realSave(record);
    };

    slackFake.channelIds.push(
      JOURNEY.slack.workflowChannelId,
      JOURNEY.inApp.workflowChannelId,
      JOURNEY.inviteFailure.workflowChannelId,
      JOURNEY.duplicateChannelId,
    );

    surface = new SlackSurface({
      botToken: 'xoxb-deterministic',
      appToken: 'xapp-deterministic',
      signingSecret: 'deterministic',
      channelId: JOURNEY.slack.lobbyChannelId,
      lobbyChannelId: JOURNEY.slack.lobbyChannelId,
      slackPlanDraftRepo: drafts,
      workflowChannelRepo: mappings,
      enableImmediateAck: false,
      planningHeartbeatIntervalSeconds: 0,
      log: () => {},
    });

    const deliveredEvents: SurfaceEvent[] = [];
    let lastSurfaceDelivery = Promise.resolve();
    const managerHandoff = {
      handleEvent: (event: SurfaceEvent): Promise<void> => {
        deliveredEvents.push(event);
        lastSurfaceDelivery = surface!.handleEvent(event);
        return lastSurfaceDelivery;
      },
    };
    const invokerClient = makeInvokerClient();
    const commandHandler = createCommandHandler({
      client: invokerClient,
      slack: managerHandoff,
      plansDir: path.join(tempDir, 'manager-plans'),
      log: () => {},
    });
    await surface.start(commandHandler);

    // Slack-originated approval: real draft repository → real action handler →
    // real manager command handler → real SlackSurface channel handoff.
    const staged = await surface.stageSlackPlanDraftForReview({
      channelId: JOURNEY.slack.lobbyChannelId,
      threadTs: JOURNEY.slack.lobbyThreadTs,
      planText: SLACK_PLAN,
      repoUrl: 'https://github.com/invoker/slack-proof.git',
      harnessPreset: 'codex',
      workingDir: tempDir,
      requestedBy: JOURNEY.slack.userId,
    });
    expect(staged.status).toBe('ready');
    const approve = slackFake.actionHandlers.find((entry) => entry.pattern === 'plan_draft_approve')?.handler;
    expect(approve).toBeDefined();
    const ack = vi.fn().mockResolvedValue(undefined);
    await approve!({
      action: { type: 'button', value: `${staged.draftId}:${staged.version}` },
      body: {
        channel: { id: JOURNEY.slack.lobbyChannelId },
        message: { thread_ts: JOURNEY.slack.lobbyThreadTs },
        user: { id: JOURNEY.slack.userId },
      },
      ack,
      respond: vi.fn().mockResolvedValue(undefined),
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(deliveredEvents[0]).toEqual(expect.objectContaining({
      type: 'workflow_created',
      workflowId: JOURNEY.slack.workflowId,
      requestedBy: JOURNEY.slack.userId,
      lobbyChannel: JOURNEY.slack.lobbyChannelId,
      lobbyThreadTs: JOURNEY.slack.lobbyThreadTs,
    }));

    const ledger = slackFake.ledger as JourneyLedgerEntry[];
    expect(ledger).toContainEqual({
      operation: 'create', channelId: JOURNEY.slack.workflowChannelId,
      name: 'workflow-slack-101', isPrivate: true,
    });
    expect(ledger).toContainEqual({
      operation: 'invite', channelId: JOURNEY.slack.workflowChannelId,
      userId: JOURNEY.slack.userId, outcome: 'ok',
    });
    expect(ledger).toContainEqual({
      operation: 'mapping', workflowId: JOURNEY.slack.workflowId,
      channelId: JOURNEY.slack.workflowChannelId, requestedBy: JOURNEY.slack.userId,
      lobbyChannelId: JOURNEY.slack.lobbyChannelId, lobbyThreadTs: JOURNEY.slack.lobbyThreadTs,
    });
    expect(ledger).toContainEqual(expect.objectContaining({
      operation: 'post', channelId: JOURNEY.slack.lobbyChannelId,
      threadTs: JOURNEY.slack.lobbyThreadTs,
      text: `Created <#${JOURNEY.slack.workflowChannelId}> for workflow \`${JOURNEY.slack.workflowId}\`.`,
    }));
    expect(ledger).toContainEqual(expect.objectContaining({
      operation: 'post', channelId: JOURNEY.slack.workflowChannelId,
      text: expect.stringContaining(`Workflow \`${JOURNEY.slack.workflowId}\` is running here.`),
    }));
    expect(ledger).toContainEqual(expect.objectContaining({
      operation: 'update', channelId: JOURNEY.slack.lobbyChannelId,
      text: 'Starting plan execution…',
    }));

    // Configured in-app entry: an owner-published surface event crosses the
    // real slack-manager subscription before reaching the same surface.
    const subscribers = new Map<string, (message: unknown) => void>();
    const subscriptionClient = {
      subscribe: vi.fn((channel: string, handler: (message: unknown) => void) => {
        subscribers.set(channel, handler);
        return () => subscribers.delete(channel);
      }),
    };
    const stopSubscription = startEventSubscription({ client: subscriptionClient, slack: managerHandoff, log: () => {} });
    const inAppPlanFile = path.join(tempDir, 'configured-in-app-plan.yaml');
    writeFileSync(inAppPlanFile, IN_APP_PLAN, 'utf8');
    const inAppCreated: SurfaceEvent = {
      type: 'workflow_created',
      workflowId: JOURNEY.inApp.workflowId,
      requestedBy: JOURNEY.inApp.userId,
      lobbyChannel: JOURNEY.inApp.lobbyChannelId,
      lobbyThreadTs: JOURNEY.inApp.lobbyThreadTs,
      harnessPreset: 'codex',
      repoUrl: 'https://github.com/invoker/in-app-proof.git',
      planFile: inAppPlanFile,
    };
    subscribers.get(Channels.SURFACE_EVENT)!(inAppCreated);
    await lastSurfaceDelivery;

    expect(deliveredEvents.at(-1)).toEqual(inAppCreated);
    expect(ledger).toContainEqual({
      operation: 'create', channelId: JOURNEY.inApp.workflowChannelId,
      name: 'workflow-in-app-202', isPrivate: true,
    });
    expect(ledger).toContainEqual({
      operation: 'invite', channelId: JOURNEY.inApp.workflowChannelId,
      userId: JOURNEY.inApp.userId, outcome: 'ok',
    });
    expect(ledger).toContainEqual(expect.objectContaining({
      operation: 'post', channelId: JOURNEY.inApp.lobbyChannelId,
      threadTs: JOURNEY.inApp.lobbyThreadTs,
      text: `Created <#${JOURNEY.inApp.workflowChannelId}> for workflow \`${JOURNEY.inApp.workflowId}\`.`,
    }));
    expect(mappings.list().map(({ workflowId, channelId, requestedBy }) => ({ workflowId, channelId, requestedBy }))).toEqual([
      { workflowId: JOURNEY.inApp.workflowId, channelId: JOURNEY.inApp.workflowChannelId, requestedBy: JOURNEY.inApp.userId },
      { workflowId: JOURNEY.slack.workflowId, channelId: JOURNEY.slack.workflowChannelId, requestedBy: JOURNEY.slack.userId },
    ]);

    // Negative isolation and positive routing for exactly two mapped workflows.
    const beforeUnmapped = ledger.length;
    subscribers.get(Channels.SURFACE_EVENT)!(progress(JOURNEY.unmappedWorkflowId, 0));
    await lastSurfaceDelivery;
    expect(mappings.getByWorkflowId(JOURNEY.unmappedWorkflowId)).toBeNull();
    expect(ledger.slice(beforeUnmapped).filter((entry) => entry.operation === 'post' || entry.operation === 'update')).toEqual([]);

    const firstProgressStart = ledger.length;
    subscribers.get(Channels.SURFACE_EVENT)!(progress(JOURNEY.slack.workflowId, 0));
    await lastSurfaceDelivery;
    subscribers.get(Channels.SURFACE_EVENT)!(progress(JOURNEY.inApp.workflowId, 0));
    await lastSurfaceDelivery;
    const firstProgressPosts = ledger.slice(firstProgressStart)
      .filter((entry): entry is Extract<JourneyLedgerEntry, { operation: 'post' }> => entry.operation === 'post');
    expect(firstProgressPosts.map(({ channelId }) => channelId)).toEqual([
      JOURNEY.slack.workflowChannelId,
      JOURNEY.inApp.workflowChannelId,
    ]);
    expect(firstProgressPosts.map(({ channelId }) => channelId)).not.toContain(JOURNEY.slack.lobbyChannelId);

    const progressUpdateStart = ledger.length;
    subscribers.get(Channels.SURFACE_EVENT)!(progress(JOURNEY.slack.workflowId, 50));
    await lastSurfaceDelivery;
    subscribers.get(Channels.SURFACE_EVENT)!(progress(JOURNEY.inApp.workflowId, 50));
    await lastSurfaceDelivery;
    expect(ledger.slice(progressUpdateStart).filter((entry) => entry.operation === 'update')).toEqual([
      expect.objectContaining({ operation: 'update', channelId: JOURNEY.slack.workflowChannelId, messageTs: firstProgressPosts[0].messageTs }),
      expect.objectContaining({ operation: 'update', channelId: JOURNEY.inApp.workflowChannelId, messageTs: firstProgressPosts[1].messageTs }),
    ]);

    // Invite failure must preserve the exact requester, destination, Slack link,
    // and operator-facing failure wording.
    slackFake.inviteFailures.set(JOURNEY.inviteFailure.workflowChannelId, JOURNEY.inviteFailure.errorCode);
    const inviteFailureCreated: SurfaceEvent = {
      type: 'workflow_created',
      workflowId: JOURNEY.inviteFailure.workflowId,
      requestedBy: JOURNEY.inviteFailure.userId,
      lobbyChannel: JOURNEY.inviteFailure.lobbyChannelId,
      lobbyThreadTs: JOURNEY.inviteFailure.lobbyThreadTs,
    };
    subscribers.get(Channels.SURFACE_EVENT)!(inviteFailureCreated);
    await lastSurfaceDelivery;
    expect(ledger).toContainEqual({
      operation: 'invite', channelId: JOURNEY.inviteFailure.workflowChannelId,
      userId: JOURNEY.inviteFailure.userId, outcome: `error:${JOURNEY.inviteFailure.errorCode}`,
    });
    expect(mappings.getByWorkflowId(JOURNEY.inviteFailure.workflowId)?.channelId)
      .toBe(JOURNEY.inviteFailure.workflowChannelId);
    expect(ledger).toContainEqual(expect.objectContaining({
      operation: 'post',
      channelId: JOURNEY.inviteFailure.lobbyChannelId,
      threadTs: JOURNEY.inviteFailure.lobbyThreadTs,
      text: `Created private <#${JOURNEY.inviteFailure.workflowChannelId}> for workflow \`${JOURNEY.inviteFailure.workflowId}\`, but I could not invite you (${JOURNEY.inviteFailure.errorCode}). Ask a workspace admin to invite you, or check the bot has \`groups:write\` and was reinstalled after adding scopes.`,
    }));

    // Replay the exact workflow_created event emitted by the Slack approval.
    // The current production baseline is expected to fail these idempotency
    // assertions; they are deliberately last so the full ledger is preserved.
    const duplicateStart = ledger.length;
    subscribers.get(Channels.SURFACE_EVENT)!(deliveredEvents[0]);
    await lastSurfaceDelivery;

    const regeneratedArtifact = renderJourneyArtifact(ledger);
    maybeUpdateJourneyArtifact(regeneratedArtifact);
    expect(readJourneyArtifact()).toBe(regeneratedArtifact);

    expect({
      duplicateOperations: ledger.slice(duplicateStart),
      persistedChannelId: mappings.getByWorkflowId(JOURNEY.slack.workflowId)?.channelId,
    }).toEqual({
      duplicateOperations: [],
      persistedChannelId: JOURNEY.slack.workflowChannelId,
    });
    stopSubscription();
  });
});
