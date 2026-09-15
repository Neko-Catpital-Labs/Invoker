#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const EXIT_CODES = Object.freeze({ pass: 0, fail: 1, unconfigured: 2 });
export const REQUIRED_ENV = Object.freeze(['DISCORD_BOT_TOKEN', 'DISCORD_TEST_GUILD_ID', 'DISCORD_TEST_CHANNEL_ID']);
export const ACK_DEADLINE_MS = 3000;

const SNOWFLAKE = /^\d{17,20}$/;
const INBOUND_TIMEOUT_MS = 60_000;
const OPERATOR_TIMEOUT_MS = 300_000;
const DEFAULT_REPO_URL = 'https://github.com/Neko-Catpital-Labs/Invoker.git';
const REPLY_PREFIX = 'Scripted planner reply:';
const RUNTIME_BUNDLES = ['packages/discord/dist/index.js', 'packages/data-store/dist/index.js'];

export const USAGE = `Usage: node scripts/discord-live-e2e.mjs [--check-config] [--interactive] [--guild <id>] [--verbose]

Drives mention, thread, /plan, review message, Approve, workflow start and
progress against a real Discord test guild, then deletes what it created.

Environment:
  DISCORD_BOT_TOKEN        bot token for a bot that is a member of the test guild
  DISCORD_TEST_GUILD_ID    the only guild the harness will touch
  DISCORD_TEST_CHANNEL_ID  a text channel inside that guild

Options:
  --check-config  validate configuration and the guild guard without any network call
  --interactive   wait for a human in the test guild to mention the bot, run /plan and click Approve,
                  so the mention content and the three-second acknowledgement are Discord's own
  --guild <id>    guild to target; refused unless it equals DISCORD_TEST_GUILD_ID
  --verbose       print the surface's info logs

Bot permissions in the test guild: View Channels, Send Messages, Send Messages in Threads,
Create Public Threads, Manage Threads, Manage Channels, Attach Files, Read Message History.

Exit codes: 0 pass, 1 fail, 2 unchecked because unconfigured (never a pass).`;

export class HarnessStop extends Error {
  constructor(outcome, reason, detail) {
    super(`${reason}: ${detail}`);
    this.outcome = outcome;
    this.reason = reason;
    this.detail = detail;
  }
}

const failure = (reason, detail) => new HarnessStop('fail', reason, detail);

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function parseArgs(argv) {
  const options = { checkConfig: false, interactive: false, verbose: false, guild: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check-config') options.checkConfig = true;
    else if (arg === '--interactive') options.interactive = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--guild') {
      options.guild = argv[index + 1];
      index += 1;
      if (!options.guild) throw failure('USAGE', '--guild requires a guild id');
    } else if (arg.startsWith('--guild=')) options.guild = arg.slice('--guild='.length);
    else throw failure('USAGE', `unknown argument ${arg}; run with --help for usage`);
  }
  return options;
}

export function readConfig(env, options = {}) {
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new HarnessStop('unconfigured', 'UNCONFIGURED', `missing ${missing.join(', ')}; the live Discord loop was not checked, and this is not a pass`);
  }
  const testGuildId = env.DISCORD_TEST_GUILD_ID.trim();
  const testChannelId = env.DISCORD_TEST_CHANNEL_ID.trim();
  const malformed = [['DISCORD_TEST_GUILD_ID', testGuildId], ['DISCORD_TEST_CHANNEL_ID', testChannelId]]
    .filter(([, value]) => !SNOWFLAKE.test(value))
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`);
  if (malformed.length) throw failure('INVALID_CONFIG', `not a Discord snowflake id: ${malformed.join(', ')}`);
  return {
    token: env.DISCORD_BOT_TOKEN.trim(),
    testGuildId,
    testChannelId,
    targetGuildId: options.guild === undefined ? testGuildId : options.guild.trim(),
    guildSource: options.guild === undefined ? 'DISCORD_TEST_GUILD_ID' : '--guild',
  };
}

export function assertTestGuild(resolvedGuildId, testGuildId, source) {
  if (resolvedGuildId === testGuildId) return;
  throw failure('GUILD_GUARD_REFUSED', `refusing to act on guild ${resolvedGuildId ?? '(unresolved)'} (from ${source}); only DISCORD_TEST_GUILD_ID=${testGuildId} is allowed`);
}

function differentGuildId(guildId) {
  return `${guildId.slice(0, -1)}${(Number(guildId.at(-1)) + 1) % 10}`;
}

export function checkConfig(config) {
  assertTestGuild(config.targetGuildId, config.testGuildId, config.guildSource);
  const foreignGuildId = differentGuildId(config.testGuildId);
  let refused = false;
  try {
    assertTestGuild(foreignGuildId, config.testGuildId, 'guard self-check');
  } catch (error) {
    refused = error instanceof HarnessStop && error.reason === 'GUILD_GUARD_REFUSED';
  }
  if (!refused) throw failure('GUARD_SELF_CHECK_FAILED', `the guild guard accepted foreign guild ${foreignGuildId}`);
  return {
    outcome: 'pass',
    reason: 'CONFIG_OK',
    detail: `DISCORD_BOT_TOKEN is set (value not shown), DISCORD_TEST_GUILD_ID=${config.testGuildId}, DISCORD_TEST_CHANNEL_ID=${config.testChannelId}; the guard accepts ${config.testGuildId} and refuses ${foreignGuildId}; no network call was made`,
  };
}

export async function main({ argv = [], env = {}, deps = {}, out = console } = {}) {
  try {
    const options = parseArgs(argv);
    const config = readConfig(env, options);
    if (options.checkConfig) return checkConfig(config);
    assertTestGuild(config.targetGuildId, config.testGuildId, config.guildSource);
    const runtime = await (deps.loadRuntime ?? loadRuntime)();
    return await runLiveLoop(config, options, runtime, out);
  } catch (error) {
    if (error instanceof HarnessStop) return { outcome: error.outcome, reason: error.reason, detail: error.detail };
    return { outcome: 'fail', reason: 'HARNESS_ERROR', detail: error instanceof Error ? error.stack ?? error.message : String(error) };
  }
}

export function formatResult(result) {
  const label = { pass: 'PASS', fail: 'FAIL', unconfigured: 'UNCHECKED' }[result.outcome] ?? 'FAIL';
  return `discord-live-e2e: ${label} [${result.reason}] ${result.detail}`;
}

export async function loadRuntime() {
  const missing = RUNTIME_BUNDLES.filter((bundle) => !existsSync(join(repoRoot, bundle)));
  if (missing.length) {
    throw failure('BUILD_MISSING', `${missing.join(', ')} not built; run: pnpm install && pnpm --filter "@invoker/discord..." build`);
  }
  const requireFromDiscord = createRequire(join(repoRoot, 'packages/discord/package.json'));
  const discordJs = requireFromDiscord('discord.js');
  const discord = requireFromDiscord(join(repoRoot, RUNTIME_BUNDLES[0]));
  const dataStore = await import(pathToFileURL(join(repoRoot, RUNTIME_BUNDLES[1])).href);
  return {
    DiscordSurface: discord.DiscordSurface,
    createGateway: (options) => new discord.DiscordJsGateway(options),
    createClient: () => new discordJs.Client({ intents: [discordJs.GatewayIntentBits.Guilds, discordJs.GatewayIntentBits.GuildMessages] }),
    createPlatform: (client, config) => createDiscordPlatform(client, discordJs, config),
    createStores: async () => {
      const adapter = await dataStore.SQLiteAdapter.create(':memory:');
      return {
        adapter,
        planDraftRepo: new dataStore.SlackPlanDraftRepository(adapter),
        workflowChannelRepo: new dataStore.WorkflowChannelRepository(adapter),
      };
    },
  };
}

function createDiscordPlatform(client, discordJs, config) {
  const { PermissionFlagsBits } = discordJs;
  const channel = async (id) => {
    const found = await client.channels.fetch(id);
    if (!found) throw new Error(`Unknown channel ${id}`);
    return found;
  };
  const guild = () => client.guilds.fetch(config.testGuildId);
  return {
    async channelGuildId(id) {
      return (await channel(id)).guildId ?? undefined;
    },
    async threadParentId(id) {
      const found = await channel(id);
      return found.isThread() ? found.parentId ?? undefined : undefined;
    },
    async existingThreadId(channelId, messageId) {
      const message = await (await channel(channelId)).messages.fetch(messageId);
      return message.hasThread ? message.thread?.id : undefined;
    },
    async postSeed(channelId, content) {
      const sent = await (await channel(channelId)).send({ content, allowedMentions: { users: [client.user.id] } });
      return sent.id;
    },
    async fetchMessage(channelId, messageId) {
      const message = await (await channel(channelId)).messages.fetch({ message: messageId, force: true });
      return {
        attachmentNames: [...message.attachments.values()].map((attachment) => attachment.name),
        buttonLabels: message.components.flatMap((row) => (row.components ?? []).map((component) => component.label)),
      };
    },
    async guildOwnerId() {
      return (await guild()).ownerId;
    },
    async guildChannelIds() {
      return new Set((await (await guild()).channels.fetch()).keys());
    },
    async channelAccess(channelId, userId) {
      const found = await client.channels.fetch(channelId, { force: true });
      const everyone = found.permissionOverwrites.cache.get(found.guild.roles.everyone.id);
      const member = found.permissionOverwrites.cache.get(userId);
      return {
        guildId: found.guildId,
        everyoneDenied: everyone?.deny.has(PermissionFlagsBits.ViewChannel) ?? false,
        memberAllowed: member?.allow.has(PermissionFlagsBits.ViewChannel) ?? false,
      };
    },
    async deleteChannel(id) {
      await (await channel(id)).delete('discord-live-e2e cleanup');
    },
    async deleteMessage(channelId, messageId) {
      await (await channel(channelId)).messages.delete(messageId);
    },
  };
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function deferred() {
  let settle;
  const promise = new Promise((resolvePromise) => {
    settle = resolvePromise;
  });
  return { promise, resolve: settle };
}

class ResourceLedger {
  constructor() {
    this.threads = [];
    this.channels = [];
    this.messages = new Map();
    this.retained = [];
    this.writes = 0;
  }

  recordMessage(message) {
    this.messages.set(message.id, message);
  }

  recordEdit(messageId, payload) {
    const message = this.messages.get(messageId);
    if (message) message.payload = { ...payload, files: message.payload.files };
  }

  surfaceMessagesIn(channelId) {
    return [...this.messages.values()].filter((message) => message.channelId === channelId && message.origin === 'surface');
  }

  contentsIn(channelId) {
    return this.surfaceMessagesIn(channelId).map((message) => message.payload.content);
  }
}

class HarnessGateway {
  constructor({ inner, platform, config, ledger, interactive }) {
    this.inner = inner;
    this.platform = platform;
    this.config = config;
    this.ledger = ledger;
    this.interactive = interactive;
    this.maxMessageLength = inner.maxMessageLength;
    this.botUserId = '';
    this.operatorId = undefined;
    this.scopeVerified = false;
    this.guardViolations = [];
    this.inbound = new Map();
    this.operatorWaiters = [];
  }

  async connect(handlers) {
    this.handlers = handlers;
    const connected = await this.inner.connect({
      onMessage: (event) => this.receiveMessage(event),
      onButton: (event) => this.receiveInteraction('button', event),
      onCommand: (event) => this.receiveInteraction('command', event),
    });
    this.botUserId = connected.botUserId;
    await this.guardChannel(this.config.testChannelId, 'DISCORD_TEST_CHANNEL_ID');
    this.scopeVerified = true;
    return connected;
  }

  disconnect() {
    return this.inner.disconnect();
  }

  async guardChannel(channelId, label) {
    let guildId;
    let lookup = '';
    try {
      guildId = await this.platform.channelGuildId(channelId);
    } catch (error) {
      lookup = ` (lookup failed: ${errorText(error)})`;
    }
    try {
      assertTestGuild(guildId, this.config.testGuildId, `${label} ${channelId}${lookup}`);
    } catch (error) {
      this.guardViolations.push(error);
      throw error;
    }
  }

  async startThread(channelId, messageId, name) {
    await this.guardChannel(channelId, 'thread parent channel');
    this.ledger.writes += 1;
    const existing = await this.platform.existingThreadId(channelId, messageId);
    const threadId = await this.inner.startThread(channelId, messageId, name);
    this.ledger.threads.push({ id: threadId, channelId, messageId, created: existing === undefined && threadId === messageId });
    return threadId;
  }

  async send(channelId, payload) {
    return this.sendAs('surface', channelId, payload);
  }

  async sendAs(origin, channelId, payload) {
    await this.guardChannel(channelId, 'send target channel');
    this.ledger.writes += 1;
    const sent = await this.inner.send(channelId, payload);
    this.ledger.recordMessage({ id: sent.id, channelId, payload, origin });
    return sent;
  }

  async edit(channelId, messageId, payload) {
    await this.guardChannel(channelId, 'edit target channel');
    this.ledger.writes += 1;
    await this.inner.edit(channelId, messageId, payload);
    this.ledger.recordEdit(messageId, payload);
  }

  async react(channelId, messageId, emoji) {
    await this.guardChannel(channelId, 'reaction target channel');
    this.ledger.writes += 1;
    await this.inner.react(channelId, messageId, emoji);
  }

  async unreact(channelId, messageId, emoji) {
    await this.guardChannel(channelId, 'reaction target channel');
    this.ledger.writes += 1;
    await this.inner.unreact(channelId, messageId, emoji);
  }

  async createPrivateChannel(request) {
    if (request.nearChannelId) await this.guardChannel(request.nearChannelId, 'workflow channel anchor');
    this.ledger.writes += 1;
    const channelsBefore = await this.platform.guildChannelIds();
    const id = await this.inner.createPrivateChannel({ ...request, guildId: this.config.testGuildId });
    await this.guardChannel(id, 'workflow channel');
    this.ledger.channels.push({ id, name: request.name, memberIds: request.memberIds, created: !channelsBefore.has(id) });
    return id;
  }

  async registerCommands(commands) {
    await this.inner.registerCommands(commands);
    for (const command of commands) {
      this.ledger.retained.push(`guild command /${command.name} in ${this.config.testGuildId} (an upsert that may predate this run, so it is left in place)`);
    }
  }

  async seed(channelId, text) {
    await this.guardChannel(channelId, 'seed target channel');
    const id = await this.platform.postSeed(channelId, `<@${this.botUserId}> ${text}`);
    this.ledger.recordMessage({ id, channelId, payload: { content: text }, origin: 'seed' });
    return id;
  }

  async instruct(channelId, text) {
    return this.sendAs('instruction', channelId, { content: `[discord-live-e2e] ${text}` });
  }

  async inboundDone(messageId, timeoutMs = INBOUND_TIMEOUT_MS) {
    const result = await withTimeout(this.inboundFor(messageId).promise, timeoutMs, `message ${messageId} did not arrive through the Discord gateway within ${timeoutMs / 1000}s`);
    if (result.error) throw result.error;
    return result.event;
  }

  inboundFor(messageId) {
    if (!this.inbound.has(messageId)) this.inbound.set(messageId, deferred());
    return this.inbound.get(messageId);
  }

  isSeed(event) {
    return event.authorId === this.botUserId && event.mentionsBot && event.content.startsWith(`<@${this.botUserId}>`);
  }

  takeOperatorWaiter(kind, channelId) {
    const index = this.operatorWaiters.findIndex((waiter) => waiter.kind === kind && waiter.channelId === channelId);
    return index === -1 ? undefined : this.operatorWaiters.splice(index, 1)[0];
  }

  receiveMessage(event) {
    if (!this.scopeVerified || event.guildId !== this.config.testGuildId) return Promise.resolve();
    let forwarded;
    if (this.isSeed(event)) {
      forwarded = { ...event, authorIsBot: false, authorId: this.operatorId };
    } else if (this.interactive && !event.authorIsBot && event.mentionsBot) {
      const waiter = this.takeOperatorWaiter('mention', event.channelId);
      if (!waiter) return Promise.resolve();
      this.operatorId = event.authorId;
      this.ledger.retained.push(`operator message ${event.id} in ${event.channelId} (not created by the harness)`);
      waiter.resolve(event.id);
      forwarded = event;
    } else {
      return Promise.resolve();
    }
    const handled = this.handlers.onMessage(forwarded).then(
      () => ({ event: forwarded }),
      (error) => ({ event: forwarded, error }),
    );
    this.inboundFor(event.id).resolve(handled);
    return handled.then((result) => {
      if (result.error) throw result.error;
    });
  }

  receiveInteraction(kind, event) {
    const waiter = this.interactive ? this.takeOperatorWaiter(kind, event.channelId) : undefined;
    if (!waiter) return Promise.resolve();
    return this.forwardInteraction(kind, event).then(waiter.resolve, (error) => {
      waiter.reject(error);
      throw error;
    });
  }

  async forwardInteraction(kind, event) {
    const receivedAt = performance.now();
    const writesAtReceipt = this.ledger.writes;
    const record = { kind, userId: event.userId, customId: event.customId, name: event.name, ackMs: undefined, writesBeforeAck: undefined, replies: [] };
    const acknowledge = async () => {
      record.ackMs = performance.now() - receivedAt;
      record.writesBeforeAck = this.ledger.writes - writesAtReceipt;
      await event.acknowledge();
    };
    if (kind === 'command') {
      await this.handlers.onCommand({ ...event, acknowledge, respond: async (text) => { record.replies.push(text); await event.respond(text); } });
    } else {
      await this.handlers.onButton({ ...event, acknowledge, notify: async (text) => { record.replies.push(text); await event.notify(text); } });
    }
    return record;
  }

  synthesize(kind, fields) {
    const noop = async () => {};
    return this.forwardInteraction(kind, { ...fields, acknowledge: noop, respond: noop, notify: noop });
  }

  async awaitOperator(kind, channelId, instruction, timeoutMs = OPERATOR_TIMEOUT_MS) {
    const arrived = new Promise((resolvePromise, reject) => this.operatorWaiters.push({ kind, channelId, resolve: resolvePromise, reject }));
    await this.instruct(channelId, instruction);
    return withTimeout(arrived, timeoutMs, `no operator ${kind} arrived in ${channelId} within ${timeoutMs / 1000}s`);
  }
}

function createScriptedPlanner(runId) {
  const title = `Discord live e2e ${runId}`;
  const taskDescriptions = ['Write the e2e greeting file', 'Verify the e2e greeting file'];
  const planText = [
    `name: ${title}`,
    `repoUrl: ${DEFAULT_REPO_URL}`,
    'onFinish: none',
    'tasks:',
    '  - id: write-greeting',
    `    description: ${taskDescriptions[0]}`,
    '    command: echo hello',
    '    dependencies: []',
    '  - id: verify-greeting',
    `    description: ${taskDescriptions[1]}`,
    '    command: test -n hello',
    '    dependencies: [write-greeting]',
    '',
  ].join('\n');
  const keys = [];
  const sessions = [];
  const factory = (request) => {
    keys.push(request.key);
    const session = {
      turns: [],
      lastTurnDraftPlanText: null,
      approvedPlanningDraft: null,
      draftDoctorEnabled: false,
      async sendMessage(text) {
        session.turns.push(text);
        return `${REPLY_PREFIX} ${text}`;
      },
      async runPlanConversion() {
        session.lastTurnDraftPlanText = planText;
        return 'Drafted the plan.';
      },
    };
    sessions.push(session);
    return session;
  };
  return { title, taskDescriptions, keys, sessions, factory };
}

function createScriptedHost(workDir, runId, surface) {
  const workflowId = `wf-e2e-${runId}`;
  const commands = [];
  const started = [];
  const gathered = [];
  const questions = [];
  const answer = `Scripted answer about ${workflowId}.`;
  return {
    workflowId,
    commands,
    started,
    gathered,
    questions,
    answer,
    handler: async (command) => {
      commands.push(command);
      if (command.type !== 'start_plan') return undefined;
      if (started.length) throw new Error(`refusing a second start_plan in one run (already started ${workflowId})`);
      const planFile = join(workDir, `${workflowId}.yaml`);
      writeFileSync(planFile, command.planText, 'utf8');
      started.push({ workflowId, command });
      await surface().handleEvent({
        type: 'workflow_created',
        workflowId,
        requestedBy: command.requestedBy,
        lobbyChannel: command.lobbyChannel,
        lobbyThreadTs: command.lobbyThreadTs,
        harnessPreset: command.harnessPreset,
        repoUrl: command.repoUrl,
        planFile,
      });
      return { workflowIds: [workflowId] };
    },
    gatherContext: async (id) => {
      gathered.push(id);
      return { workflowId: id, planning: [{ role: 'user', content: 'add an e2e greeting' }], tasks: [] };
    },
    answerQuestion: async (question) => {
      questions.push(question);
      return answer;
    },
  };
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function checkAck(interaction) {
  check(interaction.ackMs !== undefined, `the ${interaction.kind} interaction was never acknowledged`);
  check(interaction.ackMs <= ACK_DEADLINE_MS, `the ${interaction.kind} interaction was acknowledged after ${Math.round(interaction.ackMs)}ms, past the ${ACK_DEADLINE_MS}ms deadline`);
  check(interaction.writesBeforeAck === 0, `the surface made ${interaction.writesBeforeAck} Discord write(s) before acknowledging the ${interaction.kind} interaction`);
}

const sameList = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function cleanUp(ledger, platform, config) {
  const report = { removed: [], leftovers: [], retained: [...ledger.retained] };
  const deletedChannels = new Set();
  const remove = async (label, channelId, action) => {
    try {
      assertTestGuild(await platform.channelGuildId(channelId), config.testGuildId, `cleanup of ${label}`);
      await action();
      report.removed.push(label);
      return true;
    } catch (error) {
      report.leftovers.push(`${label}: ${errorText(error)}`);
      return false;
    }
  };
  for (const resource of [...ledger.threads.map((thread) => ({ ...thread, kind: 'thread' })), ...ledger.channels.map((channel) => ({ ...channel, kind: 'channel' }))]) {
    const label = `${resource.kind} ${resource.id}${resource.name ? ` (${resource.name})` : ''}`;
    if (!resource.created) {
      report.retained.push(`${label} existed before this run`);
      continue;
    }
    if (await remove(label, resource.id, () => platform.deleteChannel(resource.id))) deletedChannels.add(resource.id);
  }
  for (const message of ledger.messages.values()) {
    if (deletedChannels.has(message.channelId)) continue;
    await remove(`message ${message.id} in ${message.channelId}`, message.channelId, () => platform.deleteMessage(message.channelId, message.id));
  }
  return report;
}

async function runLiveLoop(config, options, runtime, out) {
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const workDir = mkdtempSync(join(tmpdir(), 'discord-live-e2e-'));
  const stores = await runtime.createStores();
  const client = runtime.createClient();
  const platform = runtime.createPlatform(client, config);
  const ledger = new ResourceLedger();
  const handlerErrors = [];
  const gateway = new HarnessGateway({
    inner: runtime.createGateway({ token: config.token, commandGuildIds: [config.testGuildId], client, onHandlerError: (error) => handlerErrors.push(error) }),
    platform,
    config,
    ledger,
    interactive: options.interactive,
  });
  const planner = createScriptedPlanner(runId);
  let surface;
  const host = createScriptedHost(workDir, runId, () => surface);
  surface = new runtime.DiscordSurface({
    gateway,
    planDraftRepo: stores.planDraftRepo,
    workflowChannelRepo: stores.workflowChannelRepo,
    createPlanningSession: planner.factory,
    gatherWorkflowContext: host.gatherContext,
    answerWorkflowQuestion: host.answerQuestion,
    defaultRepoUrl: DEFAULT_REPO_URL,
    workingDir: workDir,
    guildId: config.testGuildId,
    registerSlashCommands: options.interactive,
    log: (source, level, message) => {
      if (level !== 'info' || options.verbose) out.error(`[${source}] ${level}: ${message}`);
    },
  });

  let interrupt;
  const interrupted = new Promise((_, reject) => {
    interrupt = reject;
  });
  interrupted.catch(() => {});
  const onSignal = () => interrupt(failure('INTERRUPTED', 'received SIGINT; cleaned up before exiting'));
  process.once('SIGINT', onSignal);

  const passed = [];
  const step = async (name, body) => {
    const errorsBefore = handlerErrors.length;
    try {
      await Promise.race([body(), interrupted]);
      const raised = handlerErrors.slice(errorsBefore);
      if (raised.length) throw new Error(`a gateway handler failed: ${raised.map(errorText).join('; ')}`);
    } catch (error) {
      out.error(`not ok - ${name}: ${errorText(error)}`);
      if (error instanceof HarnessStop) throw error;
      throw failure('STEP_FAILED', `step "${name}": ${errorText(error)}`);
    }
    passed.push(name);
    out.log(`ok - ${name}`);
  };
  const state = {};
  let stop;
  let report = { removed: [], leftovers: [], retained: [] };
  let connected = false;

  try {
    await step('connect as the bot and confirm DISCORD_TEST_CHANNEL_ID is inside DISCORD_TEST_GUILD_ID', async () => {
      await surface.start(host.handler);
      connected = true;
      check(gateway.scopeVerified, 'the channel guild guard did not run');
      if (!options.interactive) {
        gateway.operatorId = await platform.guildOwnerId();
        check(gateway.operatorId && gateway.operatorId !== gateway.botUserId, 'the test guild owner is the bot itself, so there is no human operator to request the plan');
      }
    });

    await step('(a) a channel mention opens a thread on that message and a session keyed by (surface, channelId, threadId)', async () => {
      const mentionId = options.interactive
        ? await gateway.awaitOperator('mention', config.testChannelId, `Mention the bot in this channel with any request (run ${runId}).`)
        : await gateway.seed(config.testChannelId, `e2e ${runId}: add a greeting to the README`);
      const event = await gateway.inboundDone(mentionId);
      check(event.content.trim(), `mention ${mentionId} arrived with empty content`);
      check(ledger.threads.length === 1, `expected one thread, got ${ledger.threads.length}`);
      const [thread] = ledger.threads;
      check(thread.channelId === config.testChannelId && thread.messageId === mentionId, `the thread was opened on ${thread.channelId}/${thread.messageId}, not on the mention ${config.testChannelId}/${mentionId}`);
      state.threadId = thread.id;
      check(await platform.threadParentId(thread.id) === config.testChannelId, `Discord does not report thread ${thread.id} under ${config.testChannelId}`);
      check(sameList(planner.keys, [{ surface: 'discord', channelId: config.testChannelId, threadId: thread.id }]), `unexpected planning session keys ${JSON.stringify(planner.keys)}`);
      check(ledger.contentsIn(thread.id).some((content) => content.startsWith(REPLY_PREFIX)), 'the planner reply was not posted in the thread');
      check(ledger.contentsIn(config.testChannelId).length === 0, 'the surface posted into the parent channel instead of the thread');
    });

    await step('(b) a mention inside the thread continues its session and never nests a thread', async () => {
      const event = await gateway.inboundDone(await gateway.seed(state.threadId, 'also mention the run id in the greeting'));
      check(event.parentChannelId === config.testChannelId, `the thread mention arrived with parent ${event.parentChannelId}, expected ${config.testChannelId}`);
      check(ledger.threads.length === 1, 'a second thread was opened for a mention inside the thread');
      check(planner.keys.length === 1, 'a second planning session was created for the same thread');
      check(planner.sessions[0].turns.length === 2, `the session saw ${planner.sessions[0].turns.length} turns, expected 2`);
    });

    await step('(c) /plan posts a durable review message with ordered steps, a YAML attachment, and Approve and Cancel', async () => {
      const interaction = options.interactive
        ? await gateway.awaitOperator('command', state.threadId, `Run /plan in this thread (run ${runId}).`)
        : await gateway.synthesize('command', { name: 'plan', channelId: state.threadId, parentChannelId: config.testChannelId, userId: gateway.operatorId });
      checkAck(interaction);
      check(interaction.replies.includes('Posted the plan review in this thread.'), `/plan replied ${JSON.stringify(interaction.replies)}`);
      state.requesterId = interaction.userId;
      const review = ledger.surfaceMessagesIn(state.threadId).find((message) => message.payload.files?.length);
      check(review, 'no review message with a file attachment was posted in the thread');
      state.review = review;
      const [first, second] = planner.taskDescriptions.map((description) => review.payload.content.indexOf(description));
      check(first !== -1 && second > first, 'the review message does not list the plan steps in order');
      check(review.payload.files.some((file) => file.name.endsWith('.yaml') && file.content.includes('write-greeting')), 'the review attachment is not the plan YAML');
      check(sameList((review.payload.buttons ?? []).map((button) => button.label), ['Approve', 'Cancel']), 'the review message does not carry Approve and Cancel');
      const live = await platform.fetchMessage(state.threadId, review.id);
      check(live.attachmentNames.some((name) => name.endsWith('.yaml')), `Discord stored attachments ${JSON.stringify(live.attachmentNames)}, not the YAML`);
      check(sameList(live.buttonLabels, ['Approve', 'Cancel']), `Discord stored buttons ${JSON.stringify(live.buttonLabels)}`);
    });

    await step('(d) Approve creates a private workflow channel for the requester, posts the summary and links it back', async () => {
      const approve = state.review.payload.buttons.find((button) => button.label === 'Approve');
      const interaction = options.interactive
        ? await gateway.awaitOperator('button', state.threadId, `Click Approve on the review message above (run ${runId}).`)
        : await gateway.synthesize('button', { customId: approve.customId, channelId: state.threadId, parentChannelId: config.testChannelId, messageId: state.review.id, userId: state.requesterId });
      checkAck(interaction);
      check(interaction.customId === approve.customId, `expected the Approve button, got ${interaction.customId}`);
      check(host.started.length === 1, 'Approve did not start a workflow');
      check(host.started[0].command.requestedBy === state.requesterId, `the workflow was requested by ${host.started[0].command.requestedBy}, not ${state.requesterId}`);
      check(ledger.channels.length === 1, `expected one workflow channel, got ${ledger.channels.length}`);
      const [channel] = ledger.channels;
      check(channel.name === `workflow-e2e-${runId}`, `the workflow channel is named ${channel.name}`);
      check(sameList(channel.memberIds, [state.requesterId]), `the workflow channel grants ${JSON.stringify(channel.memberIds)}`);
      state.workflowChannelId = channel.id;
      const access = await platform.channelAccess(channel.id, state.requesterId);
      check(access.guildId === config.testGuildId, `the workflow channel lives in guild ${access.guildId}`);
      check(access.everyoneDenied, 'the workflow channel is visible to @everyone');
      check(access.memberAllowed, 'the requester was not granted access to the workflow channel');
      check(ledger.contentsIn(channel.id).some((content) => content.includes(planner.title)), 'the workflow summary was not posted in the workflow channel');
      check(ledger.contentsIn(state.threadId).some((content) => content.includes(`<#${channel.id}>`)), 'the plan thread does not link to the workflow channel');
    });

    await step('workflow progress is posted and then edited in place in the workflow channel', async () => {
      const progress = (completed, running, percentComplete) => ({
        type: 'workflow_progress',
        progress: {
          workflowId: host.workflowId,
          name: planner.title,
          counts: { total: 2, completed, failed: 0, closed: 0, running, pending: 2 - completed - running },
          percentComplete,
          tasks: [
            { id: `${host.workflowId}/write-greeting`, name: 'write-greeting', status: completed >= 1 ? 'completed' : 'running' },
            { id: `${host.workflowId}/verify-greeting`, name: 'verify-greeting', status: completed >= 2 ? 'completed' : completed >= 1 ? 'running' : 'pending' },
          ],
        },
      });
      const before = ledger.surfaceMessagesIn(state.workflowChannelId).length;
      await surface.handleEvent(progress(0, 1, 0));
      const cards = ledger.surfaceMessagesIn(state.workflowChannelId).slice(before);
      check(cards.length === 1 && cards[0].payload.content.includes('0%'), 'the first progress update was not posted');
      await surface.handleEvent(progress(2, 0, 100));
      check(ledger.surfaceMessagesIn(state.workflowChannelId).length === before + 1, 'a later progress update posted a new message instead of editing the card');
      check(ledger.messages.get(cards[0].id).payload.content.includes('100%'), 'the progress card was not edited to 100%');
    });

    await step('(e) workflow-channel controls and questions operate on that workflow only', async () => {
      const say = async (text) => gateway.inboundDone(await gateway.seed(state.workflowChannelId, text));
      const before = host.commands.length;
      for (const text of ['status', 'approve write-greeting', 'reject write-greeting', 'retry write-greeting', 'input write-greeting: use v2']) await say(text);
      const task = `${host.workflowId}/write-greeting`;
      check(sameList(host.commands.slice(before), [
        { type: 'get_status', workflowId: host.workflowId },
        { type: 'approve', taskId: task },
        { type: 'reject', taskId: task },
        { type: 'retry', taskId: task },
        { type: 'provide_input', taskId: task, input: 'use v2' },
      ]), `unexpected workflow commands ${JSON.stringify(host.commands.slice(before))}`);
      await say('why is the greeting task slow?');
      check(sameList(host.gathered, [host.workflowId]), `workflow context was gathered for ${JSON.stringify(host.gathered)}`);
      check(host.questions.length === 1 && host.questions[0].prompt.includes(host.workflowId) && host.questions[0].prompt.includes('why is the greeting task slow?'), 'the question was not answered from this workflow\'s context');
      check(ledger.contentsIn(state.workflowChannelId).includes(host.answer), 'the answer was not posted in the workflow channel');
      check(ledger.threads.length === 1 && planner.keys.length === 1, 'a workflow-channel mention opened a planning thread or session');
    });
  } catch (error) {
    stop = error instanceof HarnessStop ? error : failure('HARNESS_ERROR', errorText(error));
  } finally {
    if (connected) report = await cleanUp(ledger, platform, config);
    try {
      await surface.stop();
    } catch (error) {
      report.leftovers.push(`disconnect: ${errorText(error)}`);
    }
    process.off('SIGINT', onSignal);
    stores.adapter.close();
    rmSync(workDir, { recursive: true, force: true });
  }

  for (const label of report.removed) out.log(`cleanup: removed ${label}`);
  for (const label of report.retained) out.log(`cleanup: left in place ${label}`);
  for (const label of report.leftovers) out.error(`cleanup: COULD NOT REMOVE ${label}`);

  if (gateway.guardViolations.length && stop?.reason !== 'GUILD_GUARD_REFUSED') {
    stop = failure('GUILD_GUARD_REFUSED', [...gateway.guardViolations.map((error) => error.detail), stop?.detail].filter(Boolean).join('; '));
  }
  const leftoverNote = report.leftovers.length ? `; could not remove: ${report.leftovers.join('; ')}` : '';
  if (stop) return { outcome: 'fail', reason: stop.reason, detail: `${stop.detail}${leftoverNote}` };
  if (report.leftovers.length) return { outcome: 'fail', reason: 'CLEANUP_INCOMPLETE', detail: `all ${passed.length} steps passed but ${report.leftovers.length} resource(s) remain${leftoverNote}` };
  return { outcome: 'pass', reason: 'LIVE_LOOP_OK', detail: `${passed.length} steps passed against guild ${config.testGuildId} (${options.interactive ? 'interactive' : 'driven'} mode, run ${runId}); removed ${report.removed.length} resource(s)` };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const result = await main({ argv, env: process.env });
  (result.outcome === 'pass' ? console.log : console.error)(formatResult(result));
  process.exitCode = EXIT_CODES[result.outcome] ?? EXIT_CODES.fail;
  setTimeout(() => process.exit(), 2000).unref();
}
