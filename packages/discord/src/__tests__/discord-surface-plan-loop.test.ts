import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter, SlackPlanDraftRepository, WorkflowChannelRepository } from '@invoker/data-store';
import type { WorkflowContext } from '@invoker/surfaces';
import { DiscordSurface } from '../discord-surface.js';
import type { WorkflowQuestion } from '../planning-session.js';
import { BOT_ID, FakeGateway, PLAN_YAML, createFakeHost, fakeSessionFactory } from './support/fake-discord.js';

vi.mock('@slack/bolt', () => {
  throw new Error('@slack/bolt was loaded by the Discord surface');
});

const REPO_URL = 'https://github.com/acme/web';
const mention = (text: string) => `<@${BOT_ID}> ${text}`;

describe('DiscordSurface plan loop over a fake gateway', () => {
  let adapter: SQLiteAdapter;
  let drafts: SlackPlanDraftRepository;
  let workflowChannels: WorkflowChannelRepository;
  let gateway: FakeGateway;
  let sessions: ReturnType<typeof fakeSessionFactory>;
  let host: ReturnType<typeof createFakeHost>;
  let surface: DiscordSurface;
  let questions: WorkflowQuestion[];
  let gatheredWorkflowIds: string[];

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    drafts = new SlackPlanDraftRepository(adapter);
    workflowChannels = new WorkflowChannelRepository(adapter);
    gateway = new FakeGateway();
    sessions = fakeSessionFactory(PLAN_YAML);
    questions = [];
    gatheredWorkflowIds = [];
    surface = new DiscordSurface({
      gateway,
      planDraftRepo: drafts,
      workflowChannelRepo: workflowChannels,
      createPlanningSession: sessions.factory,
      defaultRepoUrl: REPO_URL,
      workingDir: '/tmp/checkout',
      gatherWorkflowContext: async (workflowId): Promise<WorkflowContext> => {
        gatheredWorkflowIds.push(workflowId);
        return { workflowId, planning: [{ role: 'user', content: 'add rate limiting' }], tasks: [] };
      },
      answerWorkflowQuestion: async (question) => {
        questions.push(question);
        return 'The limiter task is still running.';
      },
      log: () => {},
    });
    host = createFakeHost(() => surface);
    await surface.start(host.handler);
  });

  afterEach(async () => {
    await surface.stop();
    adapter.close();
  });

  async function openPlanningThread(): Promise<{ threadId: string; messageId: string }> {
    const messageId = await gateway.userMessage({ channelId: 'general', content: mention('add rate limiting to the API'), authorId: 'U1' });
    const threadId = gateway.threads.get(messageId)!;
    return { threadId, messageId };
  }

  async function postReview(threadId: string) {
    const opsBefore = gateway.ops.length;
    const responses = await gateway.runCommand('plan', { channelId: threadId, parentChannelId: 'general', userId: 'U1' });
    const review = gateway.in(threadId).find((message) => message.payload.files?.length)!;
    return { responses, review, firstOp: gateway.ops[opsBefore] };
  }

  it('drives mention, thread, /plan review, Approve and workflow channel creation end to end', async () => {
    const { threadId, messageId } = await openPlanningThread();

    expect(gateway.ops).toContain(`startThread:general/${messageId}`);
    expect(threadId).toBeTruthy();
    expect(sessions.requests.map((request) => request.key)).toEqual([{ surface: 'discord', channelId: 'general', threadId }]);
    expect(gateway.in(threadId).map((message) => message.payload.content)).toEqual(['Understood: add rate limiting to the API']);
    expect(gateway.in('general')).toEqual([]);

    await gateway.userMessage({ channelId: threadId, parentChannelId: 'general', content: mention('also cover the admin API'), authorId: 'U1' });

    expect(gateway.ops.filter((op) => op.startsWith('startThread'))).toHaveLength(1);
    expect(sessions.requests).toHaveLength(1);
    expect(sessions.sessions[0].turns).toEqual(['add rate limiting to the API', 'also cover the admin API']);

    const { responses, review, firstOp } = await postReview(threadId);

    expect(firstOp).toBe('ack:/plan');
    expect(responses).toEqual(['Posted the plan review in this thread.']);
    const draft = drafts.getReady(threadId, threadId, 'discord')!;
    expect(draft.surface).toBe('discord');
    expect(draft.messageTs).toBe(review.id);
    expect(review.payload.content).toBe([
      '**Rate limiting**',
      '• Add a token bucket limiter to the API gateway',
      '• Verify the limiter rejects bursts',
    ].join('\n'));
    expect(review.payload.buttons).toEqual([
      { customId: `plan_draft_approve:${draft.draftId}:${draft.version}`, label: 'Approve', style: 'primary' },
      { customId: `plan_draft_cancel:${draft.draftId}:${draft.version}`, label: 'Cancel', style: 'secondary' },
    ]);
    expect(review.payload.files).toEqual([{ name: `${draft.draftId}.yaml`, content: draft.planText }]);
    expect(draft.planText).toContain(`repoUrl: ${REPO_URL}`);
    expect(host.loadedWorkflows).toEqual([]);

    const opsBeforeClick = gateway.ops.length;
    const notifications = await gateway.clickButton(review.payload.buttons![0].customId, {
      channelId: threadId,
      parentChannelId: 'general',
      messageId: review.id,
      userId: 'U1',
    });

    expect(gateway.ops[opsBeforeClick]).toBe(`ack:${review.payload.buttons![0].customId}`);
    expect(notifications).toEqual([]);
    expect(host.loadedWorkflows).toEqual([{ workflowId: 'wf-101', planText: draft.planText }]);
    expect(host.commands).toEqual([expect.objectContaining({
      type: 'start_plan',
      requestedBy: 'U1',
      lobbyChannel: threadId,
      lobbyThreadTs: threadId,
      executionKey: `${draft.draftId}:${draft.version}`,
    })]);
    expect(drafts.get(draft.draftId, draft.version)?.status).toBe('submitted');
    expect(gateway.current(review.id).payload).toEqual({ content: 'Starting plan execution…', buttons: [], files: review.payload.files });

    expect(gateway.privateChannels).toEqual([expect.objectContaining({ name: 'workflow-101', memberIds: ['U1'], nearChannelId: threadId })]);
    const workflowChannelId = gateway.privateChannels[0].id;
    expect(workflowChannels.getByWorkflowId('wf-101')).toEqual(expect.objectContaining({ channelId: workflowChannelId, requestedBy: 'U1', lobbyChannelId: threadId }));
    const [intro, summary] = gateway.in(workflowChannelId);
    expect(intro.payload.content).toContain('Workflow `wf-101` is running here.');
    expect(summary.payload.content).toContain('**Rate limiting**');
    expect(summary.payload.files).toEqual([{ name: 'workflow-wf-101-plan.yaml', content: draft.planText }]);
    expect(gateway.in(threadId).at(-1)?.payload.content).toBe(`Created <#${workflowChannelId}> for workflow \`wf-101\`.`);
  });

  it('accepts an inline @mention /plan in the thread as the same review trigger', async () => {
    const { threadId } = await openPlanningThread();

    await gateway.userMessage({ channelId: threadId, parentChannelId: 'general', content: mention('/plan'), authorId: 'U1' });

    const review = gateway.in(threadId).find((message) => message.payload.files?.length);
    expect(review?.payload.buttons?.map((button) => button.label)).toEqual(['Approve', 'Cancel']);
    expect(sessions.sessions[0].conversions).toBe(1);
  });

  it('refuses /plan in a thread that has no planning session yet', async () => {
    const opsBefore = gateway.ops.length;
    const responses = await gateway.runCommand('plan', { channelId: 'thread-orphan', parentChannelId: 'general', userId: 'U1' });

    expect(gateway.ops[opsBefore]).toBe('ack:/plan');
    expect(responses).toEqual(['No plan review was posted; see the thread for details.']);
    expect(gateway.in('thread-orphan').map((message) => message.payload.content)).toEqual(['Start a conversation in this thread before asking me to create a plan.']);
  });

  it('keeps a cancelled review approvable and discards it on request', async () => {
    const { threadId } = await openPlanningThread();
    const { review } = await postReview(threadId);
    const [, cancel] = review.payload.buttons!;
    const target = { channelId: threadId, parentChannelId: 'general', messageId: review.id, userId: 'U1' };

    await gateway.clickButton(cancel.customId, target);

    const kept = gateway.current(review.id).payload;
    expect(kept.content).toContain('Plan not submitted. Draft kept.');
    expect(kept.buttons?.map((button) => button.label)).toEqual(['Approve', 'Discard draft']);

    await gateway.clickButton(kept.buttons![1].customId, target);

    expect(gateway.current(review.id).payload.content).toBe('Plan draft discarded.');
    expect(host.loadedWorkflows).toEqual([]);
  });

  it('operates only on the mapped workflow inside its workflow channel', async () => {
    await surface.handleEvent({ type: 'workflow_created', workflowId: 'wf-7', requestedBy: 'U1', lobbyChannel: 'thread-x' });
    await surface.handleEvent({ type: 'workflow_created', workflowId: 'wf-8', requestedBy: 'U2', lobbyChannel: 'thread-y' });
    const channel = gateway.privateChannels.find((request) => request.name === 'workflow-7')!.id;
    const say = (text: string) => gateway.userMessage({ channelId: channel, content: mention(text), authorId: 'U1' });

    await say('status');
    await say('approve build');
    await say('reject build');
    await say('retry build');
    await say('input build: use v2');

    expect(host.commands).toEqual([
      { type: 'get_status', workflowId: 'wf-7' },
      { type: 'approve', taskId: 'wf-7/build' },
      { type: 'reject', taskId: 'wf-7/build' },
      { type: 'retry', taskId: 'wf-7/build' },
      { type: 'provide_input', taskId: 'wf-7/build', input: 'use v2' },
    ]);

    await say('why is the limiter slow?');

    expect(gatheredWorkflowIds).toEqual(['wf-7']);
    expect(questions).toHaveLength(1);
    expect(questions[0].prompt).toContain('Invoker workflow `wf-7`');
    expect(questions[0].prompt).toContain('why is the limiter slow?');
    expect(questions[0].prompt).not.toContain('wf-8');
    expect(gateway.in(channel).at(-1)?.payload.content).toBe('The limiter task is still running.');
    expect(sessions.requests).toEqual([]);
    expect(gateway.ops.filter((op) => op.startsWith('startThread'))).toEqual([]);

    await surface.handleEvent({ type: 'workflow_status', workflowId: 'wf-7', status: { total: 2, completed: 1, failed: 0, closed: 0, running: 1, pending: 0 } });
    expect(gateway.in(channel).at(-1)?.payload.content).toContain('Completed: 1 · Running: 1');
  });
});
