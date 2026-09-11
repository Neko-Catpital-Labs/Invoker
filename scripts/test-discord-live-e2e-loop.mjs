#!/usr/bin/env node
import assert from 'node:assert/strict';
import { loadRuntime, main } from './discord-live-e2e.mjs';

const BOT = '100000000000000001';
const OWNER = '100000000000000002';
const GUILD = '200000000000000001';
const FOREIGN_GUILD = '200000000000000009';
const CHANNEL = '300000000000000001';
const FOREIGN_CHANNEL = '300000000000000009';
const PREEXISTING_CHANNEL = '300000000000000005';
const ENV = { DISCORD_BOT_TOKEN: 'fake-token', DISCORD_TEST_GUILD_ID: GUILD, DISCORD_TEST_CHANNEL_ID: CHANNEL };

class FakeDiscord {
  constructor({ interactive = false } = {}) {
    this.interactive = interactive;
    this.channels = new Map([
      [CHANNEL, { guildId: GUILD, name: 'e2e' }],
      [FOREIGN_CHANNEL, { guildId: FOREIGN_GUILD, name: 'general' }],
    ]);
    this.messages = new Map();
    this.deleted = [];
    this.acks = [];
    this.seq = 400000000000000000n;
    this.failDeleteChannel = new Set();
    this.failCreatePrivateChannel = false;
  }

  nextId() {
    this.seq += 1n;
    return String(this.seq);
  }

  post(channelId, authorId, payload) {
    if (!this.channels.has(channelId)) throw new Error(`Unknown Channel ${channelId}`);
    const id = this.nextId();
    this.messages.set(id, { id, channelId, authorId, content: payload.content, files: payload.files ?? [], buttons: payload.buttons ?? [] });
    setImmediate(() => {
      if (this.messages.has(id)) this.handlers?.onMessage(this.toEvent(id)).catch(() => {});
    });
    return id;
  }

  toEvent(messageId) {
    const message = this.messages.get(messageId);
    const channel = this.channels.get(message.channelId);
    return {
      id: message.id,
      channelId: message.channelId,
      parentChannelId: channel.parentId,
      guildId: channel.guildId,
      authorId: message.authorId,
      authorIsBot: message.authorId === BOT,
      content: message.content,
      mentionsBot: message.content.includes(`<@${BOT}>`),
    };
  }

  inbound(kind, fields) {
    const handler = kind === 'command' ? this.handlers.onCommand : this.handlers.onButton;
    setImmediate(() => handler({
      ...fields,
      acknowledge: async () => { this.acks.push(kind); },
      respond: async () => {},
      notify: async () => {},
    }).catch(() => {}));
  }

  actAsOperator(channelId, content) {
    if (content.includes('Mention the bot')) this.post(channelId, OWNER, { content: `<@${BOT}> add a greeting to the README` });
    if (content.includes('Run /plan')) this.inbound('command', { name: 'plan', channelId, parentChannelId: this.channels.get(channelId).parentId, userId: OWNER });
    if (content.includes('Click Approve')) {
      const review = [...this.messages.values()].find((message) => message.channelId === channelId && message.files.length);
      const approve = review.buttons.find((button) => button.label === 'Approve');
      this.inbound('button', { customId: approve.customId, channelId, parentChannelId: this.channels.get(channelId).parentId, messageId: review.id, userId: OWNER });
    }
  }

  gateway() {
    return {
      maxMessageLength: 2000,
      connect: async (handlers) => {
        this.handlers = handlers;
        return { botUserId: BOT };
      },
      disconnect: async () => { this.disconnected = true; },
      startThread: async (channelId, messageId, name) => {
        const message = this.messages.get(messageId);
        if (message.threadId) return message.threadId;
        this.channels.set(messageId, { guildId: this.channels.get(channelId).guildId, parentId: channelId, name });
        message.threadId = messageId;
        return messageId;
      },
      send: async (channelId, payload) => {
        const id = this.post(channelId, BOT, payload);
        if (this.interactive && payload.content.startsWith('[discord-live-e2e]')) this.actAsOperator(channelId, payload.content);
        return { id };
      },
      edit: async (channelId, messageId, payload) => {
        const message = this.messages.get(messageId);
        if (!message || message.channelId !== channelId) throw new Error('Unknown Message');
        Object.assign(message, { content: payload.content, buttons: payload.buttons ?? [] });
      },
      react: async () => {},
      unreact: async () => {},
      createPrivateChannel: async (request) => {
        if (this.failCreatePrivateChannel) throw new Error('Missing Permissions');
        const existing = [...this.channels].find(([, channel]) => channel.name === request.name);
        if (existing) return existing[0];
        const id = this.nextId();
        this.channels.set(id, { guildId: this.channels.get(request.nearChannelId)?.guildId ?? request.guildId, name: request.name, everyoneDenied: true, members: request.memberIds });
        return id;
      },
      registerCommands: async (commands) => { this.commands = commands; },
    };
  }

  platform() {
    const channel = (id) => {
      const found = this.channels.get(id);
      if (!found) throw new Error(`Unknown Channel ${id}`);
      return found;
    };
    return {
      channelGuildId: async (id) => channel(id).guildId,
      threadParentId: async (id) => channel(id).parentId,
      existingThreadId: async (_channelId, messageId) => this.messages.get(messageId)?.threadId,
      postSeed: async (channelId, content) => this.post(channelId, BOT, { content }),
      fetchMessage: async (_channelId, messageId) => {
        const message = this.messages.get(messageId);
        return { attachmentNames: message.files.map((file) => file.name), buttonLabels: message.buttons.map((button) => button.label) };
      },
      guildOwnerId: async () => OWNER,
      guildChannelIds: async () => new Set([...this.channels].filter(([, found]) => found.guildId === GUILD && !found.parentId).map(([id]) => id)),
      channelAccess: async (id, userId) => ({ guildId: channel(id).guildId, everyoneDenied: channel(id).everyoneDenied === true, memberAllowed: (channel(id).members ?? []).includes(userId) }),
      deleteChannel: async (id) => {
        if (this.failDeleteChannel.has(channel(id).name?.startsWith('workflow-') ? 'workflow' : 'thread')) throw new Error('Missing Permissions');
        this.channels.delete(id);
        for (const [messageId, message] of this.messages) if (message.channelId === id) this.messages.delete(messageId);
        this.deleted.push(`channel:${id}`);
      },
      deleteMessage: async (channelId, messageId) => {
        channel(channelId);
        this.messages.delete(messageId);
        this.deleted.push(`message:${messageId}`);
      },
    };
  }
}

const realRuntime = await loadRuntime().catch((error) => {
  console.error(`not ok - load the DiscordSurface runtime: ${error.reason ?? 'ERROR'} ${error.detail ?? error.message}`);
  process.exit(1);
});

async function run(discord, { argv = [], env = ENV } = {}) {
  const lines = [];
  const out = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  const result = await main({
    argv,
    env,
    out,
    deps: {
      loadRuntime: async () => ({
        ...realRuntime,
        createGateway: () => discord.gateway(),
        createClient: () => ({}),
        createPlatform: () => discord.platform(),
      }),
    },
  });
  return { result, lines };
}

let passed = 0;
async function test(name, body) {
  await body();
  passed += 1;
  console.log(`ok - ${name}`);
}

const createdChannelIds = (discord) => [...discord.channels.keys()].filter((id) => id !== CHANNEL && id !== FOREIGN_CHANNEL);

await test('a driven run passes every step and removes everything it created', async () => {
  const discord = new FakeDiscord();
  const { result, lines } = await run(discord);
  assert.equal(result.outcome, 'pass', `${result.reason}: ${result.detail}\n${lines.join('\n')}`);
  assert.equal(result.reason, 'LIVE_LOOP_OK');
  assert.equal(lines.filter((line) => line.startsWith('ok - ')).length, 7);
  assert.deepEqual(createdChannelIds(discord), []);
  assert.deepEqual([...discord.messages.values()], []);
  assert.ok(discord.channels.has(CHANNEL) && discord.channels.has(FOREIGN_CHANNEL), 'the harness deleted a channel it did not create');
  assert.equal(discord.acks.length, 0, 'driven mode acknowledged a real interaction');
  assert.equal(discord.disconnected, true);
});

await test('an interactive run forwards real operator actions and leaves the operator message in place', async () => {
  const discord = new FakeDiscord({ interactive: true });
  const { result, lines } = await run(discord, { argv: ['--interactive'] });
  assert.equal(result.outcome, 'pass', `${result.reason}: ${result.detail}\n${lines.join('\n')}`);
  assert.deepEqual(discord.acks, ['command', 'button']);
  assert.deepEqual(discord.commands.map((command) => command.name), ['plan']);
  const remaining = [...discord.messages.values()];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].authorId, OWNER);
  assert.ok(lines.some((line) => line.startsWith(`cleanup: left in place operator message ${remaining[0].id}`)));
  assert.deepEqual(createdChannelIds(discord), []);
});

await test('a channel outside DISCORD_TEST_GUILD_ID is refused before any write', async () => {
  const discord = new FakeDiscord();
  const { result, lines } = await run(discord, { env: { ...ENV, DISCORD_TEST_CHANNEL_ID: FOREIGN_CHANNEL } });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'GUILD_GUARD_REFUSED');
  assert.match(result.detail, new RegExp(`guild ${FOREIGN_GUILD} \\(from DISCORD_TEST_CHANNEL_ID ${FOREIGN_CHANNEL}\\)`));
  assert.match(result.detail, new RegExp(GUILD));
  assert.ok(lines.some((line) => line.startsWith('not ok - connect as the bot')), lines.join('\n'));
  assert.deepEqual(lines.filter((line) => line.startsWith('ok - ')), []);
  assert.deepEqual([...discord.messages.values()], []);
  assert.deepEqual(createdChannelIds(discord), []);
  assert.equal(discord.disconnected, true);
});

await test('a guard refusal the surface swallows still fails the run, and the foreign channel is never touched', async () => {
  const discord = new FakeDiscord();
  const gateway = discord.gateway();
  discord.gateway = () => ({ ...gateway, createPrivateChannel: async () => FOREIGN_CHANNEL });
  const { result } = await run(discord);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'GUILD_GUARD_REFUSED');
  assert.match(result.detail, new RegExp(`guild ${FOREIGN_GUILD} \\(from workflow channel ${FOREIGN_CHANNEL}\\)`));
  assert.ok(discord.channels.has(FOREIGN_CHANNEL));
  assert.deepEqual([...discord.messages.values()].filter((message) => message.channelId === FOREIGN_CHANNEL), []);
  assert.ok(!discord.deleted.some((entry) => entry.includes(FOREIGN_CHANNEL)));
  assert.deepEqual(createdChannelIds(discord), []);
});

await test('a workflow channel that existed before the run is reported and never deleted', async () => {
  const discord = new FakeDiscord();
  discord.channels.set(PREEXISTING_CHANNEL, { guildId: GUILD, name: 'ops' });
  const gateway = discord.gateway();
  discord.gateway = () => ({ ...gateway, createPrivateChannel: async () => PREEXISTING_CHANNEL });
  const { result, lines } = await run(discord);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'STEP_FAILED');
  assert.ok(discord.channels.has(PREEXISTING_CHANNEL), 'the harness deleted a channel it did not create');
  assert.ok(!discord.deleted.includes(`channel:${PREEXISTING_CHANNEL}`));
  assert.ok(lines.some((line) => line.startsWith(`cleanup: left in place channel ${PREEXISTING_CHANNEL}`)), lines.join('\n'));
  assert.deepEqual(createdChannelIds(discord), [PREEXISTING_CHANNEL]);
});

await test('a failed step still cleans up and names the step', async () => {
  const discord = new FakeDiscord();
  discord.failCreatePrivateChannel = true;
  const { result } = await run(discord);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'STEP_FAILED');
  assert.match(result.detail, /step "\(d\) Approve/);
  assert.deepEqual(createdChannelIds(discord), []);
  assert.deepEqual([...discord.messages.values()], []);
});

await test('a resource the harness cannot delete fails the run and is named', async () => {
  const discord = new FakeDiscord();
  discord.failDeleteChannel.add('workflow');
  const { result, lines } = await run(discord);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'CLEANUP_INCOMPLETE');
  const [leftover] = createdChannelIds(discord);
  assert.match(result.detail, new RegExp(`channel ${leftover} \\(workflow-e2e-`));
  assert.ok(lines.some((line) => line.startsWith(`cleanup: COULD NOT REMOVE channel ${leftover}`)));
});

console.log(`\n${passed} discord-live-e2e loop tests passed`);
