import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandHandler, SurfaceCommand, SurfaceEvent } from '@invoker/surfaces';
import {
  DISCORD_MESSAGE_LIMIT,
  type DiscordGateway,
  type DiscordGatewayHandlers,
  type DiscordMessageEvent,
  type DiscordMessagePayload,
  type PrivateChannelRequest,
  type SlashCommandDefinition,
} from '../../gateway.js';
import type { PlanningSession, PlanningSessionRequest } from '../../planning-session.js';

export const BOT_ID = '900000000000000001';

export interface FakeMessage {
  id: string;
  channelId: string;
  payload: DiscordMessagePayload;
}

export class FakeGateway implements DiscordGateway {
  readonly maxMessageLength = DISCORD_MESSAGE_LIMIT;
  readonly ops: string[] = [];
  readonly sent: FakeMessage[] = [];
  readonly messages = new Map<string, FakeMessage>();
  readonly threads = new Map<string, string>();
  readonly privateChannels: Array<PrivateChannelRequest & { id: string }> = [];
  readonly commands: SlashCommandDefinition[] = [];
  startThreadError?: Error;
  private handlers?: DiscordGatewayHandlers;
  private seq = 1000;

  async connect(handlers: DiscordGatewayHandlers): Promise<{ botUserId: string }> {
    this.handlers = handlers;
    this.ops.push('connect');
    return { botUserId: BOT_ID };
  }

  async disconnect(): Promise<void> {
    this.ops.push('disconnect');
  }

  async startThread(channelId: string, messageId: string): Promise<string> {
    this.ops.push(`startThread:${channelId}/${messageId}`);
    if (this.startThreadError) throw this.startThreadError;
    const existing = this.threads.get(messageId);
    if (existing) return existing;
    const threadId = this.nextId('thread');
    this.threads.set(messageId, threadId);
    return threadId;
  }

  async send(channelId: string, payload: DiscordMessagePayload): Promise<{ id: string }> {
    if (payload.content.length > this.maxMessageLength) throw new Error(`Invalid Form Body: content exceeds ${this.maxMessageLength}`);
    const message = { id: this.nextId('msg'), channelId, payload };
    this.sent.push(message);
    this.messages.set(message.id, message);
    this.ops.push(`send:${channelId}`);
    return { id: message.id };
  }

  async edit(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<void> {
    if (payload.content.length > this.maxMessageLength) throw new Error(`Invalid Form Body: content exceeds ${this.maxMessageLength}`);
    const current = this.messages.get(messageId);
    if (!current || current.channelId !== channelId) throw new Error('Unknown Message');
    this.messages.set(messageId, { ...current, payload: { ...payload, files: current.payload.files } });
    this.ops.push(`edit:${channelId}/${messageId}`);
  }

  async react(): Promise<void> {}

  async unreact(): Promise<void> {}

  async createPrivateChannel(request: PrivateChannelRequest): Promise<string> {
    const id = this.nextId('chan');
    this.privateChannels.push({ ...request, id });
    this.ops.push(`createPrivateChannel:${request.name}`);
    return id;
  }

  async registerCommands(commands: SlashCommandDefinition[]): Promise<void> {
    this.commands.push(...commands);
  }

  async userMessage(event: Partial<DiscordMessageEvent> & { channelId: string; content: string; authorId: string }): Promise<string> {
    const id = event.id ?? this.nextId('user-msg');
    await this.requireHandlers().onMessage({
      guildId: 'guild-1',
      authorIsBot: false,
      mentionsBot: event.content.includes(`<@${BOT_ID}>`),
      ...event,
      id,
    });
    return id;
  }

  async clickButton(
    customId: string,
    target: { channelId: string; messageId: string; userId: string; parentChannelId?: string },
  ): Promise<string[]> {
    const notifications: string[] = [];
    await this.requireHandlers().onButton({
      customId,
      ...target,
      acknowledge: async () => { this.ops.push(`ack:${customId}`); },
      notify: async (text) => { notifications.push(text); },
    });
    return notifications;
  }

  async runCommand(name: string, target: { channelId: string; userId: string; parentChannelId?: string }): Promise<string[]> {
    const responses: string[] = [];
    await this.requireHandlers().onCommand({
      name,
      ...target,
      acknowledge: async () => { this.ops.push(`ack:/${name}`); },
      respond: async (text) => { responses.push(text); },
    });
    return responses;
  }

  in(channelId: string): FakeMessage[] {
    return this.sent.filter((message) => message.channelId === channelId).map((message) => this.messages.get(message.id)!);
  }

  current(messageId: string): FakeMessage {
    return this.messages.get(messageId)!;
  }

  private requireHandlers(): DiscordGatewayHandlers {
    if (!this.handlers) throw new Error('surface has not connected to the gateway');
    return this.handlers;
  }

  private nextId(prefix: string): string {
    return `${prefix}-${this.seq++}`;
  }
}

export class FakePlanningSession implements PlanningSession {
  readonly turns: string[] = [];
  conversions = 0;
  lastTurnDraftPlanText: string | null = null;
  readonly approvedPlanningDraft = null;
  readonly draftDoctorEnabled = false;

  constructor(
    private readonly planText: string,
    private readonly replyFor: (text: string) => string = (text) => `Understood: ${text}`,
    private readonly conversionOutput = 'Drafted the plan.',
  ) {}

  async sendMessage(text: string): Promise<string> {
    this.turns.push(text);
    return this.replyFor(text);
  }

  async runPlanConversion(): Promise<string> {
    this.conversions++;
    this.lastTurnDraftPlanText = this.planText;
    return this.conversionOutput;
  }
}

export function fakeSessionFactory(planText: string, replyFor?: (text: string) => string, conversionOutput?: string) {
  const requests: PlanningSessionRequest[] = [];
  const sessions: FakePlanningSession[] = [];
  const factory = (request: PlanningSessionRequest): PlanningSession => {
    requests.push(request);
    const session = new FakePlanningSession(planText, replyFor, conversionOutput);
    sessions.push(session);
    return session;
  };
  return { factory, requests, sessions };
}

export interface LoadedWorkflow {
  workflowId: string;
  planText: string;
}

export function createFakeHost(surface: () => { handleEvent(event: SurfaceEvent): Promise<void> }) {
  const plansDir = mkdtempSync(join(tmpdir(), 'invoker-discord-host-'));
  const commands: SurfaceCommand[] = [];
  const loadedWorkflows: LoadedWorkflow[] = [];
  const handler: CommandHandler = async (command) => {
    commands.push(command);
    if (command.type !== 'start_plan') return;
    const workflowId = `wf-${101 + loadedWorkflows.length}`;
    const planFile = join(plansDir, `${workflowId}.yaml`);
    writeFileSync(planFile, command.planText, 'utf8');
    loadedWorkflows.push({ workflowId, planText: command.planText });
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
  };
  return { handler, commands, loadedWorkflows };
}

export const PLAN_YAML = [
  'name: Rate limiting',
  'repoUrl: https://github.com/acme/unrelated.git',
  'onFinish: pull_request',
  'tasks:',
  '  - id: add-limiter',
  '    description: Add a token bucket limiter to the API gateway',
  '    prompt: Implement the limiter',
  '    dependencies: []',
  '  - id: test-limiter',
  '    description: Verify the limiter rejects bursts',
  '    command: pnpm test',
  '    dependencies: [add-limiter]',
  '',
].join('\n');

export function largePlanYaml(taskCount: number): string {
  const lines = ['name: Very large plan', 'tasks:'];
  for (let i = 0; i < taskCount; i++) {
    lines.push(`  - id: task-${i}`);
    lines.push(`    description: Step ${i} ${'does a long and detailed piece of the migration '.repeat(3).trim()}`);
    lines.push('    command: pnpm test');
    lines.push('    dependencies: []');
  }
  return `${lines.join('\n')}\n`;
}
