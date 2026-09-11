import { describe, expect, it } from 'vitest';
import { SQLiteAdapter, SlackPlanDraftRepository } from '@invoker/data-store';
import { DiscordSurface, PLAN_SLASH_COMMAND } from '../discord-surface.js';
import { BOT_ID, FakeGateway, PLAN_YAML, fakeSessionFactory } from './support/fake-discord.js';

function build(overrides: { registerSlashCommands?: boolean } = {}) {
  const gateway = new FakeGateway();
  const logs: Array<{ level: string; message: string }> = [];
  const sessions = fakeSessionFactory(PLAN_YAML);
  const surface = new DiscordSurface({
    gateway,
    createPlanningSession: sessions.factory,
    defaultRepoUrl: 'https://github.com/acme/web',
    workingDir: '/tmp/checkout',
    log: (_source, level, message) => logs.push({ level, message }),
    ...overrides,
  });
  return { gateway, logs, sessions, surface };
}

describe('DiscordSurface lifecycle', () => {
  it('connects its handlers, registers only the /plan command, and disconnects on stop', async () => {
    const { gateway, surface } = build();

    await surface.start(async () => {});
    expect(gateway.ops[0]).toBe('connect');
    expect(gateway.commands).toEqual([PLAN_SLASH_COMMAND]);

    await surface.stop();
    expect(gateway.ops.at(-1)).toBe('disconnect');
  });

  it('can skip slash-command registration', async () => {
    const { gateway, surface } = build({ registerSlashCommands: false });
    await surface.start(async () => {});
    expect(gateway.commands).toEqual([]);
  });

  it('logs a mention that arrives with empty content instead of treating it as an empty request', async () => {
    const { gateway, logs, sessions, surface } = build();
    await surface.start(async () => {});

    await gateway.userMessage({ channelId: 'general', content: '', mentionsBot: true, authorId: 'U1', id: 'm-empty' });

    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', message: expect.stringContaining('[DISCORD_EMPTY_CONTENT] message=m-empty') }));
    expect(gateway.sent).toEqual([]);
    expect(gateway.threads.size).toBe(0);
    expect(sessions.requests).toEqual([]);
  });

  it('answers a bare mention with a greeting inside a new thread rather than logging it as empty', async () => {
    const { gateway, logs, surface } = build();
    await surface.start(async () => {});

    const messageId = await gateway.userMessage({ channelId: 'general', content: `<@${BOT_ID}>`, authorId: 'U1' });

    const threadId = gateway.threads.get(messageId)!;
    expect(gateway.in(threadId)[0].payload.content).toMatch(/^Hi!/);
    expect(logs.some((entry) => entry.message.includes('[DISCORD_EMPTY_CONTENT]'))).toBe(false);
  });

  it('tells the channel when it cannot open a planning thread instead of failing silently', async () => {
    const { gateway, sessions, surface } = build();
    await surface.start(async () => {});
    gateway.startThreadError = new Error('Missing Permissions');

    await gateway.userMessage({ channelId: 'general', content: `<@${BOT_ID}> add rate limiting`, authorId: 'U1' });

    expect(gateway.in('general').map((message) => message.payload.content)).toEqual(['I could not open a planning thread here: Missing Permissions']);
    expect(sessions.requests).toEqual([]);
  });

  it('ignores messages from bots and messages that do not mention the bot', async () => {
    const { gateway, surface } = build();
    await surface.start(async () => {});

    await gateway.userMessage({ channelId: 'general', content: `<@${BOT_ID}> hi`, authorId: 'B1', authorIsBot: true });
    await gateway.userMessage({ channelId: 'general', content: 'plan something', authorId: 'U1' });

    expect(gateway.ops).toEqual(['connect']);
  });

  it('acknowledges a component interaction before doing any other work, even for an unknown action', async () => {
    const { gateway, surface } = build();
    await surface.start(async () => {});

    const notifications = await gateway.clickButton('lobby_confirm:thread-1', { channelId: 'thread-1', messageId: 'msg-x', userId: 'U1' });

    expect(gateway.ops.slice(1)).toEqual(['ack:lobby_confirm:thread-1']);
    expect(notifications).toEqual(['This action is no longer available.']);
  });

  it('stages /plan <request> as a plan-intent choice and drafts only after its button is clicked', async () => {
    const { gateway, sessions, surface } = build();
    await surface.start(async () => {});
    const messageId = await gateway.userMessage({ channelId: 'general', content: `<@${BOT_ID}> hello`, authorId: 'U1' });
    const threadId = gateway.threads.get(messageId)!;

    await gateway.userMessage({ channelId: threadId, parentChannelId: 'general', content: `<@${BOT_ID}> /plan add rate limiting`, authorId: 'U1' });

    const prompt = gateway.in(threadId).at(-1)!;
    expect(prompt.payload.buttons?.map((button) => button.customId)).toEqual([
      `lobby_plan_for_execution:${threadId}`,
      `lobby_continue_conversation:${threadId}`,
    ]);
    expect(sessions.sessions[0].turns).toEqual(['hello']);

    await gateway.clickButton(`lobby_continue_conversation:${threadId}`, { channelId: threadId, parentChannelId: 'general', messageId: prompt.id, userId: 'U1' });

    expect(gateway.current(prompt.id).payload).toEqual(expect.objectContaining({ content: '✅ Continuing the conversation without planning.', buttons: [] }));
    expect(sessions.sessions[0].turns).toEqual(['hello', 'add rate limiting']);
    expect(sessions.sessions[0].conversions).toBe(0);
  });

  it('drafts a review only after the Plan for execution button, and that choice cannot be replayed', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    const gateway = new FakeGateway();
    const sessions = fakeSessionFactory(PLAN_YAML);
    const withDrafts = new DiscordSurface({
      gateway,
      planDraftRepo: new SlackPlanDraftRepository(adapter),
      createPlanningSession: sessions.factory,
      defaultRepoUrl: 'https://github.com/acme/web',
      workingDir: '/tmp/checkout',
      log: () => {},
    });
    await withDrafts.start(async () => {});
    const messageId = await gateway.userMessage({ channelId: 'general', content: `<@${BOT_ID}> /plan add rate limiting`, authorId: 'U1' });
    const threadId = gateway.threads.get(messageId)!;
    const prompt = gateway.in(threadId).at(-1)!;
    expect(sessions.requests).toEqual([]);

    const target = { channelId: threadId, parentChannelId: 'general', messageId: prompt.id, userId: 'U1' };
    await gateway.clickButton(`lobby_plan_for_execution:${threadId}`, target);

    expect(sessions.sessions[0].turns).toEqual(['add rate limiting']);
    expect(sessions.sessions[0].conversions).toBe(1);
    expect(gateway.in(threadId).some((message) => message.payload.files?.length)).toBe(true);

    await gateway.clickButton(`lobby_plan_for_execution:${threadId}`, target);
    expect(gateway.current(prompt.id).payload.content).toBe('This planning choice has expired.');
    expect(sessions.sessions[0].conversions).toBe(1);
    await withDrafts.stop();
    adapter.close();
  });
});
