import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { summarizePlanText } from '@invoker/planning-core';
import { SQLiteAdapter, SlackPlanDraftRepository } from '@invoker/data-store';
import { DiscordSurface } from '../discord-surface.js';
import { DISCORD_MESSAGE_LIMIT } from '../gateway.js';
import { chunkMessage, fitMessage, renderReviewBody } from '../discord-rendering.js';
import { BOT_ID, FakeGateway, createFakeHost, fakeSessionFactory, largePlanYaml } from './support/fake-discord.js';

const mention = (text: string) => `<@${BOT_ID}> ${text}`;

describe('Discord message budget', () => {
  it('renders a review body for an oversized plan within 2000 characters', () => {
    const summary = summarizePlanText(largePlanYaml(200))!;

    for (const state of ['ready', 'kept'] as const) {
      const body = renderReviewBody(summary, state, DISCORD_MESSAGE_LIMIT);
      expect(body.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
      expect(body.startsWith('**Very large plan**\n• Step 0 ')).toBe(true);
      expect(body).toMatch(/… \d+ more steps in the attached YAML/);
    }
    expect(renderReviewBody(summary, 'kept', DISCORD_MESSAGE_LIMIT).endsWith('Plan not submitted. Draft kept.')).toBe(true);
  });

  it('keeps short text untouched and cuts an unbroken line to the limit', () => {
    expect(fitMessage('short', 10)).toBe('short');
    const cut = fitMessage('x'.repeat(50), 20);
    expect(cut.length).toBeLessThanOrEqual(20);
  });

  it('chunks at the transport limit rather than the Slack chunk size, including a single unbroken line', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${'word '.repeat(80)}`).join('\n\n');
    const unbroken = 'y'.repeat(4500);

    for (const text of [paragraphs, unbroken]) {
      const chunks = chunkMessage(text, DISCORD_MESSAGE_LIMIT);
      expect(chunks.length).toBeGreaterThan(1);
      expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
      expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
    }
  });
});

describe('DiscordSurface rendering over a fake gateway', () => {
  let adapter: SQLiteAdapter;
  let surface: DiscordSurface;
  let gateway: FakeGateway;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    gateway = new FakeGateway();
    surface = new DiscordSurface({
      gateway,
      planDraftRepo: new SlackPlanDraftRepository(adapter),
      createPlanningSession: fakeSessionFactory(largePlanYaml(200), () => `${'A long answer line. '.repeat(40)}\n\n`.repeat(10)).factory,
      defaultRepoUrl: 'https://github.com/acme/web',
      workingDir: '/tmp/checkout',
      log: () => {},
    });
    await surface.start(createFakeHost(() => surface).handler);
  });

  afterEach(async () => {
    await surface.stop();
    adapter.close();
  });

  it('posts a review message whose body is at most 2000 characters with the full YAML attached', async () => {
    const messageId = await gateway.userMessage({ channelId: 'general', content: mention('migrate everything'), authorId: 'U1' });
    const threadId = gateway.threads.get(messageId)!;

    await gateway.runCommand('plan', { channelId: threadId, parentChannelId: 'general', userId: 'U1' });

    const review = gateway.in(threadId).find((message) => message.payload.files?.length)!;
    expect(review.payload.content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(review.payload.content).toMatch(/more steps in the attached YAML$/);
    expect(review.payload.files?.[0].content).toContain('id: task-199');
    expect(review.payload.buttons?.map((button) => button.label)).toEqual(['Approve', 'Cancel']);
  });

  it('keeps oversized core-produced text inside the limit on posts, card edits and notices', async () => {
    const plannerOutput = `${'The planner explains why it could not draft yet. '.repeat(30)}\n\n`.repeat(5);
    const longError = `upstream rejected the plan: ${'detail '.repeat(600)}`;
    const localGateway = new FakeGateway();
    const localSurface = new DiscordSurface({
      gateway: localGateway,
      planDraftRepo: new SlackPlanDraftRepository(adapter),
      createPlanningSession: fakeSessionFactory('', undefined, plannerOutput).factory,
      defaultRepoUrl: 'https://github.com/acme/web',
      workingDir: '/tmp/checkout',
      log: () => {},
    });
    await localSurface.start(async () => {});
    const messageId = await localGateway.userMessage({ channelId: 'general', content: mention('scope it'), authorId: 'U1' });
    const threadId = localGateway.threads.get(messageId)!;
    const before = localGateway.in(threadId).length;

    await localGateway.runCommand('plan', { channelId: threadId, parentChannelId: 'general', userId: 'U1' });

    const notReady = localGateway.in(threadId).slice(before).map((message) => message.payload.content);
    expect(notReady.length).toBeGreaterThan(1);
    expect(Math.max(...notReady.map((content) => content.length))).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(notReady.join('').replace(/\s/g, '')).toBe(plannerOutput.replace(/\s/g, ''));
    await localSurface.stop();

    const failingSurface = new DiscordSurface({
      gateway: localGateway,
      planDraftRepo: new SlackPlanDraftRepository(adapter),
      createPlanningSession: fakeSessionFactory(largePlanYaml(3)).factory,
      defaultRepoUrl: 'https://github.com/acme/web',
      workingDir: '/tmp/checkout',
      log: () => {},
    });
    await failingSurface.start(async (command) => {
      if (command.type === 'start_plan') throw new Error(longError);
    });
    const secondId = await localGateway.userMessage({ channelId: 'general', content: mention('try again'), authorId: 'U1' });
    const secondThread = localGateway.threads.get(secondId)!;
    await localGateway.runCommand('plan', { channelId: secondThread, parentChannelId: 'general', userId: 'U1' });
    const review = localGateway.in(secondThread).find((message) => message.payload.files?.length)!;

    const notices = await localGateway.clickButton(review.payload.buttons![0].customId, {
      channelId: secondThread,
      parentChannelId: 'general',
      messageId: review.id,
      userId: 'U1',
    });

    const edited = localGateway.current(review.id).payload.content;
    expect(edited.startsWith('Plan execution failed: upstream rejected the plan:')).toBe(true);
    expect(edited.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(notices).toHaveLength(1);
    expect(notices[0].length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    await failingSurface.stop();
  });

  it('splits a long conversation reply into several messages under the Discord limit', async () => {
    const messageId = await gateway.userMessage({ channelId: 'general', content: mention('explain the plan'), authorId: 'U1' });
    const threadId = gateway.threads.get(messageId)!;

    const replies = gateway.in(threadId);
    expect(replies.length).toBeGreaterThan(1);
    for (const reply of replies) expect(reply.payload.content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
  });
});
