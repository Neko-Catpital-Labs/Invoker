import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter, SlackPlanDraftRepository, WorkflowChannelRepository } from '@invoker/data-store';
import { DiscordSurface } from '../discord-surface.js';
import { BOT_ID, FakeGateway, PLAN_YAML, createFakeHost, fakeSessionFactory, type FakeMessage } from './support/fake-discord.js';

const mention = (text: string) => `<@${BOT_ID}> ${text}`;

describe('DiscordSurface approval guard', () => {
  let adapter: SQLiteAdapter;
  let drafts: SlackPlanDraftRepository;
  let gateway: FakeGateway;
  let host: ReturnType<typeof createFakeHost>;
  let surface: DiscordSurface;
  let threadId: string;
  let review: FakeMessage;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    drafts = new SlackPlanDraftRepository(adapter);
    gateway = new FakeGateway();
    surface = new DiscordSurface({
      gateway,
      planDraftRepo: drafts,
      workflowChannelRepo: new WorkflowChannelRepository(adapter),
      createPlanningSession: fakeSessionFactory(PLAN_YAML).factory,
      defaultRepoUrl: 'https://github.com/acme/web',
      workingDir: '/tmp/checkout',
      log: () => {},
    });
    host = createFakeHost(() => surface);
    await surface.start(host.handler);

    const messageId = await gateway.userMessage({ channelId: 'general', content: mention('add rate limiting'), authorId: 'U1' });
    threadId = gateway.threads.get(messageId)!;
    await gateway.runCommand('plan', { channelId: threadId, parentChannelId: 'general', userId: 'U1' });
    review = gateway.in(threadId).find((message) => message.payload.files?.length)!;
  });

  afterEach(async () => {
    await surface.stop();
    adapter.close();
  });

  function readyDraft() {
    return drafts.getReady(threadId, threadId, 'discord');
  }

  function expectNoWorkflow(): void {
    expect(host.loadedWorkflows).toEqual([]);
    expect(host.commands.filter((command) => command.type === 'start_plan')).toEqual([]);
    expect(gateway.privateChannels).toEqual([]);
    expect(readyDraft()?.status).toBe('ready');
  }

  it('creates no workflow from a forged message carrying approve intent without a component interaction', async () => {
    const approveId = review.payload.buttons![0].customId;
    expect(readyDraft()).toBeDefined();

    for (const forged of ['approve', 'submit', 'Submit it!', 'submit to invoker.', 'yes', 'go', approveId]) {
      await gateway.userMessage({ channelId: threadId, parentChannelId: 'general', content: mention(forged), authorId: 'U1' });
    }
    await gateway.userMessage({ channelId: threadId, parentChannelId: 'general', content: 'approve', authorId: 'U1', mentionsBot: false });
    await gateway.userMessage({ channelId: 'general', content: mention(`approve ${approveId}`), authorId: 'U1' });

    expectNoWorkflow();
    expect(gateway.in(threadId).map((message) => message.payload.content)).toContain('Plans only start from the **Approve** button on the review message.');
  });

  it('creates no workflow when the Approve interaction comes from anyone but the requester or another thread', async () => {
    const approveId = review.payload.buttons![0].customId;

    const fromOtherUser = await gateway.clickButton(approveId, { channelId: threadId, parentChannelId: 'general', messageId: review.id, userId: 'U2' });
    const fromOtherThread = await gateway.clickButton(approveId, { channelId: 'thread-elsewhere', parentChannelId: 'general', messageId: review.id, userId: 'U1' });

    expect(fromOtherUser).toEqual(['This plan review is no longer available.']);
    expect(fromOtherThread).toEqual(['This plan review is no longer available.']);
    expect(gateway.current(review.id).payload.buttons?.map((button) => button.label)).toEqual(['Approve', 'Cancel']);
    expectNoWorkflow();
  });

  it('submits exactly once when the requester clicks the real Approve button, even twice', async () => {
    const approveId = review.payload.buttons![0].customId;
    const target = { channelId: threadId, parentChannelId: 'general', messageId: review.id, userId: 'U1' };

    await gateway.clickButton(approveId, target);
    const second = await gateway.clickButton(approveId, target);

    expect(host.loadedWorkflows.map((workflow) => workflow.workflowId)).toEqual(['wf-101']);
    expect(second).toEqual(['This plan review is submitted.']);
    expect(gateway.privateChannels).toHaveLength(1);
  });

  it('does not let a Discord button approve a draft staged by another surface', async () => {
    const slackDraft = drafts.create({
      channelId: threadId,
      threadTs: threadId,
      planText: PLAN_YAML,
      summaryJson: JSON.stringify({ name: 'Rate limiting', steps: [], taskCount: 2, taskGroups: [] }),
      repoUrl: 'https://github.com/acme/web',
      harnessPreset: 'codex',
      workingDir: '/tmp/checkout',
      requestedBy: 'U1',
      confirmationMode: 'require',
    });
    drafts.bindAttachment(slackDraft, 'F1');
    drafts.bindMessage(slackDraft, 'slack-ts');
    drafts.markReady(slackDraft);

    const notifications = await gateway.clickButton(`plan_draft_approve:${slackDraft.draftId}:${slackDraft.version}`, {
      channelId: threadId,
      parentChannelId: 'general',
      messageId: review.id,
      userId: 'U1',
    });

    expect(notifications).toEqual(['This plan review is no longer available.']);
    expect(drafts.get(slackDraft.draftId, slackDraft.version)?.status).toBe('ready');
    expectNoWorkflow();
  });
});
