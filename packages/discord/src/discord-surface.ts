import { readFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { summarizePlanText } from '@invoker/planning-core';
import type { SlackPlanDraftRepository, WorkflowChannel, WorkflowChannelRepository } from '@invoker/data-store';
import {
  ApprovalStateMachine,
  BUILTIN_HARNESS_PRESETS,
  DEFAULT_HARNESS_PRESET,
  PlanDraftLifecycle,
  buildAssistantPrompt,
  normalizeSupportedRepoCandidate,
  redactAbsolutePaths,
  resolveChannelRepo,
  routePlanningMention,
  routeRepoScopedMention,
  routeWorkflowMention,
  type CommandHandler,
  type CoreLogFn,
  type HarnessPreset,
  type LogFn,
  type ParsedPlanningRequest,
  type PlanDraftRecord,
  type PlanDraftStore,
  type PlanIntentConfirm,
  type PlanningCommandBuilder,
  type PlanningContext,
  type SayFn,
  type Surface,
  type SurfaceCommand,
  type SurfaceEvent,
  type WorkflowContext,
  type WorkflowControl,
} from '@invoker/surfaces';
import type {
  DiscordButtonEvent,
  DiscordCommandEvent,
  DiscordGateway,
  DiscordMessageEvent,
  DiscordMessagePayload,
  SlashCommandDefinition,
} from './gateway.js';
import { DiscordChatTransport } from './discord-transport.js';
import { DiscordAction, chunkMessage, createDiscordBlocks, fitMessage, parseButtonId, renderReviewBody } from './discord-rendering.js';
import { formatSurfaceEventText } from './discord-formatter.js';
import {
  DISCORD_SURFACE,
  createOneShotAnswerer,
  createPlanConversationFactory,
  planningSessionKeyString,
  type PlanningSession,
  type PlanningSessionFactory,
  type PlanningSessionKey,
  type WorkflowQuestionAnswerer,
} from './planning-session.js';

export interface DiscordSurfaceConfig {
  gateway: DiscordGateway;
  planDraftRepo?: SlackPlanDraftRepository;
  workflowChannelRepo?: WorkflowChannelRepository;
  createPlanningSession?: PlanningSessionFactory;
  answerWorkflowQuestion?: WorkflowQuestionAnswerer;
  gatherWorkflowContext?: (workflowId: string) => Promise<WorkflowContext>;
  prepareRepoCheckout?: (repoUrl: string) => Promise<string>;
  workingDir?: string;
  harnessPresets?: Record<string, HarnessPreset>;
  defaultHarnessPreset?: string;
  repoAliases?: Record<string, string>;
  defaultRepoUrl?: string;
  channelRepoBindings?: Record<string, string>;
  guildId?: string;
  alertChannelId?: string;
  registerSlashCommands?: boolean;
  cursorCommand?: string;
  planningCommandBuilder?: PlanningCommandBuilder;
  defaultBranch?: string;
  planningTimeoutSeconds?: number;
  log?: LogFn;
}

export const PLAN_SLASH_COMMAND: SlashCommandDefinition = {
  name: 'plan',
  description: 'Turn this Invoker thread into a plan review with Approve and Cancel buttons',
};

interface ThreadAddress {
  channelId: string;
  threadId: string;
}

type DiscordPlanDraftStore = PlanDraftStore & { getReady(threadId: string): PlanDraftRecord | undefined };

function scopeDraftsToDiscord(repo: SlackPlanDraftRepository): DiscordPlanDraftStore {
  const own = (draft: PlanDraftRecord | undefined) => (draft?.surface === DISCORD_SURFACE ? draft : undefined);
  return {
    create: (input) => repo.create({ ...input, surface: DISCORD_SURFACE }),
    get: (draftId, version) => own(repo.get(draftId, version)),
    bindAttachment: (draft, fileId) => repo.bindAttachment(draft, fileId),
    bindMessage: (draft, messageTs) => repo.bindMessage(draft, messageTs),
    markReady: (draft) => repo.markReady(draft),
    claim: (draft) => repo.claim(draft),
    markSubmitted: (draft, workflowIds) => repo.markSubmitted(draft, workflowIds),
    markFailed: (draft, decidedBy) => repo.markFailed(draft, decidedBy),
    resolvePlanText: (draft) => repo.resolvePlanText(draft),
    decide: (draft, status, decidedBy) => repo.decide(draft, status, decidedBy),
    getReady: (threadId) => repo.getReady(threadId, threadId, DISCORD_SURFACE),
  };
}

function repositoryIdentity(repoUrl: string): string {
  return repoUrl.trim()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .toLowerCase();
}

function stripAngleBrackets(value: string): string {
  return value.trim().replace(/^<([^>]+)>$/, '$1');
}

function pinPlanRepoUrl(planText: string, repoUrl: string | undefined): string {
  if (!repoUrl) return planText;
  let raw: unknown;
  try {
    raw = parseYaml(planText);
  } catch {
    return planText;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return planText;
  const plan = raw as Record<string, unknown>;
  if (plan.scratch === true) return planText;
  plan.repoUrl = repoUrl;
  for (const child of Array.isArray(plan.workflows) ? plan.workflows : []) {
    if (child && typeof child === 'object' && !Array.isArray(child) && (child as Record<string, unknown>).scratch !== true) {
      (child as Record<string, unknown>).repoUrl = repoUrl;
    }
  }
  return stringifyYaml(plan);
}

function workflowChannelName(workflowId: string): string {
  return `workflow-${workflowId.replace(/^wf-/, '')}`
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .slice(0, 100);
}

function threadName(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 90) || 'Invoker planning';
}

function deriveWorkflowId(event: SurfaceEvent): string | undefined {
  if (event.type === 'workflow_status') return event.workflowId;
  if (event.type === 'workflow_progress') return event.progress.workflowId;
  if (event.type !== 'task_delta') return undefined;
  const taskId = event.delta.type === 'created' ? event.delta.task.id : event.delta.taskId;
  if (taskId.startsWith('__merge__')) return taskId.slice('__merge__'.length);
  const slash = taskId.indexOf('/');
  return slash === -1 ? undefined : taskId.slice(0, slash);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ONLY_APPROVE_BUTTON_STARTS_WORKFLOWS = 'Plans only start from the **Approve** button on the review message.';

const WORKFLOW_CHANNEL_HELP = 'Mention me with `status`, `approve <task>`, `reject <task>`, `retry <task>`, `input <task>: <text>`, or ask a question about this workflow.';

export class DiscordSurface implements Surface {
  readonly type = DISCORD_SURFACE;
  private readonly gateway: DiscordGateway;
  private readonly transport: DiscordChatTransport;
  private readonly approvals: ApprovalStateMachine;
  private readonly planDrafts: PlanDraftLifecycle;
  private readonly draftStore?: DiscordPlanDraftStore;
  private readonly workflowChannelRepo?: WorkflowChannelRepository;
  private readonly createPlanningSession: PlanningSessionFactory;
  private readonly answerWorkflowQuestion: WorkflowQuestionAnswerer;
  private readonly gatherWorkflowContext?: (workflowId: string) => Promise<WorkflowContext>;
  private readonly prepareRepoCheckout?: (repoUrl: string) => Promise<string>;
  private readonly workingDir?: string;
  private readonly harnessPresets: Record<string, HarnessPreset>;
  private readonly defaultHarnessPreset: string;
  private readonly repoAliases: Record<string, string>;
  private readonly defaultRepoUrl?: string;
  private readonly channelRepoBindings: Record<string, string>;
  private readonly guildId?: string;
  private readonly alertChannelId?: string;
  private readonly registerSlashCommands: boolean;
  private readonly log: LogFn;
  private readonly sessions = new Map<string, PlanningSession>();
  private readonly planningContexts = new Map<string, PlanningContext>();
  private readonly progressMessages = new Map<string, string>();
  private readonly taskMessages = new Map<string, string>();
  private onCommand?: CommandHandler;

  constructor(config: DiscordSurfaceConfig) {
    this.gateway = config.gateway;
    this.workflowChannelRepo = config.workflowChannelRepo;
    this.gatherWorkflowContext = config.gatherWorkflowContext;
    this.prepareRepoCheckout = config.prepareRepoCheckout;
    this.workingDir = config.workingDir;
    this.harnessPresets = { ...BUILTIN_HARNESS_PRESETS, ...(config.harnessPresets ?? {}) };
    this.defaultHarnessPreset = config.defaultHarnessPreset ?? DEFAULT_HARNESS_PRESET;
    this.repoAliases = config.repoAliases ?? {};
    this.defaultRepoUrl = config.defaultRepoUrl;
    this.channelRepoBindings = config.channelRepoBindings ?? {};
    this.guildId = config.guildId;
    this.alertChannelId = config.alertChannelId;
    this.registerSlashCommands = config.registerSlashCommands ?? true;
    this.log = config.log ?? ((source, level, message) => {
      (level === 'error' ? console.error : console.log)(`[${source}] ${message}`);
    });

    const coreLog: CoreLogFn = (level, message) => this.log('discord', level, message);
    const blocks = createDiscordBlocks(this.gateway.maxMessageLength);
    this.transport = new DiscordChatTransport(this.gateway, coreLog);
    this.draftStore = config.planDraftRepo ? scopeDraftsToDiscord(config.planDraftRepo) : undefined;
    this.approvals = new ApprovalStateMachine({
      transport: this.transport,
      blocks,
      log: coreLog,
      allowsControls: () => false,
    });
    this.planDrafts = new PlanDraftLifecycle({
      platformName: 'Discord',
      transport: this.transport,
      blocks,
      log: coreLog,
      store: this.draftStore,
      dispatch: (command) => this.onCommand?.(command),
      normalizePlanRepoUrl: pinPlanRepoUrl,
      loadPlanningContext: (threadId) => this.planningContexts.get(threadId),
      defaultConfirmationMode: 'require',
      raiseAlert: (event) => this.handleEvent(event),
    });

    const plannerOptions = {
      cursorCommand: config.cursorCommand,
      planningCommandBuilder: config.planningCommandBuilder,
      defaultBranch: config.defaultBranch,
      timeoutMs: config.planningTimeoutSeconds === undefined ? undefined : config.planningTimeoutSeconds * 1_000,
      log: this.log,
    };
    this.createPlanningSession = config.createPlanningSession ?? createPlanConversationFactory(plannerOptions);
    this.answerWorkflowQuestion = config.answerWorkflowQuestion ?? createOneShotAnswerer(plannerOptions);
  }

  async start(onCommand: CommandHandler): Promise<void> {
    this.onCommand = onCommand;
    this.restoreProgressMessages();
    const { botUserId } = await this.gateway.connect({
      onMessage: (event) => this.handleMessage(event),
      onButton: (event) => this.handleButton(event),
      onCommand: (event) => this.handleSlashCommand(event),
    });
    if (this.registerSlashCommands) {
      try {
        await this.gateway.registerCommands([PLAN_SLASH_COMMAND]);
      } catch (err) {
        this.log('discord', 'error', `Failed to register the /plan command: ${errorText(err)}`);
      }
    }
    this.log('discord', 'info', `Discord bot started (bot=${botUserId}, planReviews=${this.draftStore ? 'on' : 'off'}, workflowChannels=${this.workflowChannelRepo ? 'on' : 'off'})`);
  }

  async stop(): Promise<void> {
    this.sessions.clear();
    this.progressMessages.clear();
    this.taskMessages.clear();
    await this.gateway.disconnect();
    this.log('discord', 'info', 'Discord bot stopped');
  }

  async handleEvent(event: SurfaceEvent): Promise<void> {
    if (event.type === 'workflow_created') {
      await this.createWorkflowChannel(event);
      return;
    }
    const text = formatSurfaceEventText(event);
    if (!text) return;
    const content = fitMessage(text, this.gateway.maxMessageLength);

    if (event.type === 'alert' || event.type === 'error') {
      if (!this.alertChannelId) {
        this.log('discord', 'warn', `[ALERT] No alert channel configured; dropping: ${content.slice(0, 200)}`);
        return;
      }
      await this.safeSend(this.alertChannelId, { content });
      return;
    }

    const workflowId = deriveWorkflowId(event);
    const channel = workflowId ? this.workflowChannelRepo?.getByWorkflowId(workflowId)?.channelId : undefined;
    if (!workflowId || !channel) {
      this.log('discord', 'warn', `[WORKFLOW_EVENT] Suppressed unmapped workflow update (type=${event.type})`);
      return;
    }
    if (event.type === 'workflow_progress') {
      const id = await this.sendOrEdit(channel, this.progressMessages.get(workflowId), content);
      if (id) this.saveProgressMessage(workflowId, id);
      return;
    }
    if (event.type === 'task_delta') {
      const taskId = event.delta.type === 'created' ? event.delta.task.id : event.delta.taskId;
      const existing = event.delta.type === 'updated' ? this.taskMessages.get(taskId) : undefined;
      const id = await this.sendOrEdit(channel, existing, content);
      if (id) this.taskMessages.set(taskId, id);
      return;
    }
    await this.safeSend(channel, { content });
  }

  private async handleMessage(event: DiscordMessageEvent): Promise<void> {
    if (event.authorIsBot || !event.mentionsBot) return;
    if (!event.content.trim()) {
      this.log('discord', 'warn', `[DISCORD_EMPTY_CONTENT] message=${event.id} channel=${event.channelId} author=${event.authorId}: the bot was mentioned but the message arrived with empty content, so it is not treated as a request. Without the MESSAGE_CONTENT intent Discord only delivers content for messages that mention the bot inline.`);
      return;
    }
    const text = event.content.replace(/<@!?\d+>/g, '').trim();
    const mapping = this.workflowMappingFor(event);
    if (mapping) {
      this.log('discord', 'info', `[MENTION_ROUTE] message=${event.id} route=workflow workflow=${mapping.workflowId}`);
      await this.handleWorkflowMention(mapping, text, event.channelId);
      return;
    }
    if (!event.guildId) {
      await this.sayIn(event.channelId)({ text: 'Mention me in a server channel to start a planning thread.', thread_ts: event.channelId });
      return;
    }
    const address = event.parentChannelId
      ? { channelId: event.parentChannelId, threadId: event.channelId }
      : await this.openThread(event, text);
    if (!address) return;
    this.log('discord', 'info', `[MENTION_ROUTE] message=${event.id} route=planning channel=${address.channelId} thread=${address.threadId} user=${event.authorId}`);
    await this.handlePlanningMention(text, address, event.authorId);
  }

  private async openThread(event: DiscordMessageEvent, text: string): Promise<ThreadAddress | undefined> {
    try {
      return { channelId: event.channelId, threadId: await this.gateway.startThread(event.channelId, event.id, threadName(text)) };
    } catch (err) {
      this.log('discord', 'error', `[THREAD] Failed to open a thread on message ${event.id} in ${event.channelId}: ${errorText(err)}`);
      await this.safeSend(event.channelId, { content: `I could not open a planning thread here: ${errorText(err)}` });
      return undefined;
    }
  }

  private workflowMappingFor(event: DiscordMessageEvent): WorkflowChannel | undefined {
    const repo = this.workflowChannelRepo;
    if (!repo) return undefined;
    return repo.getByChannelId(event.channelId)
      ?? (event.parentChannelId ? repo.getByChannelId(event.parentChannelId) : null)
      ?? undefined;
  }

  private async handlePlanningMention(text: string, address: ThreadAddress, userId: string): Promise<void> {
    const say = this.sayIn(address.threadId);
    const reply = (message: string) => say({ text: message, thread_ts: address.threadId });
    const mention = routePlanningMention({ text, userId }, {
      presetKeys: Object.keys(this.harnessPresets),
      defaultPresetKey: this.defaultHarnessPreset,
      readyDraft: () => this.draftStore?.getReady(address.threadId),
    });
    const { parsed, route } = mention;
    if (mention.announceAutoSubmitUnavailable) {
      await reply('Auto-submit is unavailable here. I will stage the draft for review instead.');
    }
    switch (route.kind) {
      case 'unknown_preset':
        await reply(`Unknown preset \`[${route.preset}]\`. Valid presets: ${Object.keys(this.harnessPresets).join(', ')}. Omit the tag to use the default (\`${this.defaultHarnessPreset}\`).`);
        return;
      case 'greeting':
        await reply('Hi! Tell me what you want to build or fix and I will work on it in this thread. When the scope is ready, use `/plan` here to get a plan review.');
        return;
      case 'explicit_plan':
        await this.handleExplicitPlanAction(address, userId, say);
        return;
      case 'channel_repo_setup':
        await reply('Channel repository setup is not available on Discord yet. Use a `[repo:…]` tag or a repository URL in your message.');
        return;
      case 'submit_ready_draft':
      case 'submit_denied':
        await reply(ONLY_APPROVE_BUTTON_STARTS_WORKFLOWS);
        return;
      case 'resolve_repo':
        break;
    }

    const repo = await this.resolveRouteRepo(parsed, address.channelId);
    if (repo.error) {
      await reply(repo.error);
      return;
    }
    const scoped = routeRepoScopedMention(parsed, {
      allowsLobbyControls: false,
      hasPendingConfirm: () => this.approvals.getPendingConfirm(address.threadId) !== undefined,
    });
    switch (scoped.kind) {
      case 'plan_intent': {
        const context = await this.pinContext(address, parsed, repo.url, userId, reply);
        if (!context) return;
        await this.approvals.stagePlanIntentConfirm(address.threadId, address.threadId, {
          kind: 'plan_intent',
          requestText: scoped.requestText,
          userId,
          context,
          channel: address.threadId,
        }, say);
        return;
      }
      case 'confirm_reply':
        await reply('There is a pending choice in this thread. Use its buttons to answer it.');
        return;
      case 'control_rejected':
      case 'workflow_op':
      case 'restart':
      case 'local_command':
        await reply(`Workflow operations, restarts and local commands are not available from Discord planning threads. Inside a workflow channel: ${WORKFLOW_CHANNEL_HELP}`);
        return;
      case 'conversation_turn':
        break;
    }

    const context = await this.pinContext(address, parsed, repo.url, userId, reply);
    if (!context) return;
    await this.runConversationTurn(address, userId, context, scoped.requestText);
  }

  private async pinContext(
    address: ThreadAddress,
    parsed: ParsedPlanningRequest,
    repoUrl: string | undefined,
    userId: string,
    reply: (message: string) => Promise<unknown>,
  ): Promise<PlanningContext | undefined> {
    const stored = this.planningContexts.get(address.threadId);
    if (stored) {
      const selectedRepo = Boolean(parsed.repo) || (parsed.repositoryUrls?.length ?? 0) > 0;
      if (selectedRepo && repoUrl && stored.repoUrl && repositoryIdentity(repoUrl) !== repositoryIdentity(stored.repoUrl)) {
        await reply('This thread is already pinned to a different repository. Start a new thread to use another repository.');
        return undefined;
      }
      if (parsed.hasExplicitPreset && parsed.presetKey !== stored.presetKey) {
        await reply('This thread is already pinned to a different planner preset. Start a new thread to use another preset.');
        return undefined;
      }
      return stored;
    }
    let workingDir = this.workingDir;
    if (this.prepareRepoCheckout && repoUrl
      && !(this.workingDir && this.defaultRepoUrl && repositoryIdentity(repoUrl) === repositoryIdentity(this.defaultRepoUrl))) {
      try {
        workingDir = await this.prepareRepoCheckout(repoUrl);
      } catch (err) {
        this.log('discord', 'error', `Failed to prepare repo checkout for ${repoUrl}: ${errorText(err)}`);
        await reply(`Failed to check out repo: ${errorText(err)}`);
        return undefined;
      }
    }
    const context: PlanningContext = {
      repoUrl,
      presetKey: parsed.presetKey,
      workingDir,
      requestedBy: userId,
      lobbyChannel: address.channelId,
      confirmationMode: 'require',
    };
    this.planningContexts.set(address.threadId, context);
    return context;
  }

  private sessionFor(address: ThreadAddress, userId: string, context: PlanningContext): PlanningSession {
    const key: PlanningSessionKey = { surface: DISCORD_SURFACE, channelId: address.channelId, threadId: address.threadId };
    const id = planningSessionKeyString(key);
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const preset = this.resolveHarnessPreset(context.presetKey);
    const session = this.createPlanningSession({
      key,
      userId,
      tool: preset.tool,
      model: preset.model,
      workingDir: context.workingDir,
      repoUrl: context.repoUrl,
    });
    this.sessions.set(id, session);
    this.log('discord', 'info', `[SESSION] created ${id}`);
    return session;
  }

  private findSession(address: ThreadAddress): PlanningSession | undefined {
    return this.sessions.get(planningSessionKeyString({ surface: DISCORD_SURFACE, ...address }));
  }

  private async runConversationTurn(address: ThreadAddress, userId: string, context: PlanningContext, text: string): Promise<void> {
    const session = this.sessionFor(address, userId, context);
    const ack = await this.gateway.send(address.threadId, { content: 'Working on it…' });
    try {
      const reply = await session.sendMessage(text);
      await this.postReply(address.threadId, reply, ack.id);
    } catch (err) {
      this.log('discord', 'error', `[SESSION_ERROR] thread=${address.threadId}: ${errorText(err)}`);
      await this.postReply(address.threadId, `Error: ${errorText(err)}`, ack.id);
    }
  }

  private async postReply(channelId: string, reply: string, replaceMessageId?: string): Promise<void> {
    const chunks = chunkMessage(redactAbsolutePaths(reply), this.gateway.maxMessageLength).filter((chunk) => chunk.trim());
    const [first = 'The planner completed without a reply.', ...rest] = chunks;
    await this.sendOrEdit(channelId, replaceMessageId, first);
    for (const chunk of rest) await this.gateway.send(channelId, { content: chunk });
  }

  private async sendOrEdit(channelId: string, messageId: string | undefined, content: string): Promise<string | undefined> {
    if (messageId) {
      try {
        await this.gateway.edit(channelId, messageId, { content, buttons: [] });
        return messageId;
      } catch (err) {
        this.log('discord', 'warn', `Failed to edit message ${messageId} in ${channelId}, posting a replacement: ${errorText(err)}`);
      }
    }
    return (await this.safeSend(channelId, { content }))?.id;
  }

  private async safeSend(channelId: string, payload: DiscordMessagePayload): Promise<{ id: string } | undefined> {
    try {
      return await this.gateway.send(channelId, payload);
    } catch (err) {
      this.log('discord', 'error', `Failed to post to ${channelId}: ${errorText(err)}`);
      return undefined;
    }
  }

  private async handleExplicitPlanAction(address: ThreadAddress, userId: string, say: SayFn): Promise<boolean> {
    const reply = (message: string) => say({ text: message, thread_ts: address.threadId });
    if (!this.draftStore) {
      await reply('Plan reviews are not configured in this deployment.');
      return false;
    }
    const session = this.findSession(address);
    if (!session) {
      await reply('Start a conversation in this thread before asking me to create a plan.');
      return false;
    }
    try {
      const plannerOutput = await session.runPlanConversion();
      const result = await this.planDrafts.stageDraftReview(plannerOutput, session, address.threadId, address.threadId, userId, say, { silentWhenNotReady: false });
      if (result.staged === false && result.reason === 'posting_error') {
        await reply(`I hit an error trying to prepare the plan review: ${result.message}. An operator needs to look at draft ${result.draftId}.`);
      }
      return result.staged;
    } catch (err) {
      this.log('discord', 'error', `[PLAN_REVIEW] thread=${address.threadId}: ${errorText(err)}`);
      await reply(`Planning failed: ${errorText(err)}`);
      return false;
    }
  }

  private async handleSlashCommand(event: DiscordCommandEvent): Promise<void> {
    await event.acknowledge();
    if (event.name !== PLAN_SLASH_COMMAND.name) {
      await event.respond(`Unknown command \`/${event.name}\`.`);
      return;
    }
    if (!event.parentChannelId) {
      await event.respond('Run `/plan` inside an Invoker planning thread.');
      return;
    }
    const address: ThreadAddress = { channelId: event.parentChannelId, threadId: event.channelId };
    this.log('discord', 'info', `[SLASH] /plan thread=${address.threadId} user=${event.userId}`);
    const staged = await this.handleExplicitPlanAction(address, event.userId, this.sayIn(address.threadId));
    await event.respond(staged ? 'Posted the plan review in this thread.' : 'No plan review was posted; see the thread for details.');
  }

  private async handleButton(event: DiscordButtonEvent): Promise<void> {
    await event.acknowledge();
    const { action, value } = parseButtonId(event.customId);
    this.log('discord', 'info', `[BUTTON] action=${action} value=${value} channel=${event.channelId} user=${event.userId}`);
    const actor = { channel: event.channelId, threadTs: event.channelId, userId: event.userId };
    const notify = (text: string) => event.notify(fitMessage(text, this.gateway.maxMessageLength));
    switch (action) {
      case DiscordAction.planDraftApprove:
        await this.planDrafts.approvePlanDraft(value, actor, notify);
        return;
      case DiscordAction.planDraftCancel:
        await this.planDrafts.cancelPlanDraft(value, actor, notify);
        return;
      case DiscordAction.planDraftDiscard:
        await this.planDrafts.discardPlanDraft(value, actor, notify);
        return;
      case DiscordAction.planForExecution:
      case DiscordAction.continueConversation:
        await this.resolvePlanIntent(event, value, action === DiscordAction.planForExecution);
        return;
      default:
        this.log('discord', 'warn', `[BUTTON] unhandled action=${action}`);
        await notify('This action is no longer available.');
    }
  }

  private async resolvePlanIntent(event: DiscordButtonEvent, key: string, forExecution: boolean): Promise<void> {
    const pending = this.approvals.getPendingConfirm(key);
    if (!pending || pending.kind !== 'plan_intent' || pending.channel !== event.channelId) {
      await this.gateway.edit(event.channelId, event.messageId, { content: 'This planning choice has expired.', buttons: [] });
      return;
    }
    this.approvals.clearPendingConfirm(key);
    await this.gateway.edit(event.channelId, event.messageId, {
      content: forExecution ? '✅ Planning for execution.' : '✅ Continuing the conversation without planning.',
      buttons: [],
    });
    const address: ThreadAddress = { channelId: pending.context.lobbyChannel ?? event.parentChannelId ?? pending.channel, threadId: pending.channel };
    if (!forExecution || !pending.alreadySent) await this.replayPlanIntentRequest(address, pending);
    if (forExecution) await this.handleExplicitPlanAction(address, pending.userId, this.sayIn(address.threadId));
  }

  private async replayPlanIntentRequest(address: ThreadAddress, pending: PlanIntentConfirm): Promise<void> {
    if (!this.planningContexts.has(address.threadId)) this.planningContexts.set(address.threadId, pending.context);
    await this.runConversationTurn(address, pending.userId, this.planningContexts.get(address.threadId)!, pending.requestText);
  }

  private async handleWorkflowMention(mapping: WorkflowChannel, text: string, channelId: string): Promise<void> {
    const reply = (message: string) => this.sayIn(channelId)({ text: message, thread_ts: channelId });
    const route = routeWorkflowMention(text);
    switch (route.kind) {
      case 'workflow_help':
        await reply(`I answer questions about workflow \`${mapping.workflowId}\` and run controls. ${WORKFLOW_CHANNEL_HELP}`);
        return;
      case 'workflow_control':
        await this.dispatchWorkflowControl(mapping.workflowId, route.control, reply);
        return;
      case 'workflow_question':
        break;
    }
    if (!this.gatherWorkflowContext) {
      await reply('Workflow context is not available in this deployment.');
      return;
    }
    const ack = await this.gateway.send(channelId, { content: 'Looking into it…' });
    try {
      const context = await this.gatherWorkflowContext(mapping.workflowId);
      const preset = this.resolveHarnessPreset(mapping.harnessPreset ?? this.defaultHarnessPreset);
      const answer = await this.answerWorkflowQuestion({
        tool: preset.tool,
        model: preset.model,
        workingDir: this.workingDir,
        prompt: buildAssistantPrompt(route.text, context),
      });
      await this.postReply(channelId, answer, ack.id);
    } catch (err) {
      this.log('discord', 'error', `[ASSISTANT] Q&A failed (workflow=${mapping.workflowId}): ${errorText(err)}`);
      await this.postReply(channelId, `Error: ${errorText(err)}`, ack.id);
    }
  }

  private async dispatchWorkflowControl(
    workflowId: string,
    control: WorkflowControl,
    reply: (message: string) => Promise<unknown>,
  ): Promise<void> {
    const scoped = (task: string): string => `${workflowId}/${task}`;
    const run = async (command: SurfaceCommand, okText: string): Promise<void> => {
      try {
        await this.onCommand?.(command);
        await reply(okText);
      } catch (err) {
        await reply(errorText(err));
      }
    };
    switch (control.kind) {
      case 'status':
        await run({ type: 'get_status', workflowId }, `Fetching status for \`${workflowId}\`...`);
        return;
      case 'approve':
        await run({ type: 'approve', taskId: scoped(control.task) }, `Approving \`${scoped(control.task)}\`.`);
        return;
      case 'reject':
        await run({ type: 'reject', taskId: scoped(control.task) }, `Rejecting \`${scoped(control.task)}\`.`);
        return;
      case 'retry':
        await run({ type: 'retry', taskId: scoped(control.task) }, `Retrying \`${scoped(control.task)}\`.`);
        return;
      case 'input':
        await run({ type: 'provide_input', taskId: scoped(control.task), input: control.text }, `Sent input to \`${scoped(control.task)}\`.`);
        return;
    }
  }

  private async createWorkflowChannel(event: Extract<SurfaceEvent, { type: 'workflow_created' }>): Promise<void> {
    let channelId: string;
    try {
      channelId = await this.gateway.createPrivateChannel({
        name: workflowChannelName(event.workflowId),
        memberIds: event.requestedBy ? [event.requestedBy] : [],
        nearChannelId: event.lobbyChannel,
        guildId: this.guildId,
      });
    } catch (err) {
      this.log('discord', 'error', `Failed to create workflow channel for ${event.workflowId}: ${errorText(err)}`);
      if (event.lobbyChannel) {
        await this.safeSend(event.lobbyChannel, { content: `Could not create a channel for workflow \`${event.workflowId}\`: ${errorText(err)}` });
      }
      return;
    }

    this.workflowChannelRepo?.save({
      workflowId: event.workflowId,
      channelId,
      requestedBy: event.requestedBy,
      lobbyChannelId: event.lobbyChannel,
      lobbyThreadTs: event.lobbyThreadTs,
      harnessPreset: event.harnessPreset,
      repoUrl: event.repoUrl,
      createdAt: new Date().toISOString(),
    });

    await this.safeSend(channelId, { content: `Workflow \`${event.workflowId}\` is running here. ${WORKFLOW_CHANNEL_HELP}` });
    await this.publishWorkflowSummary(channelId, event.workflowId, event.planFile);
    if (event.lobbyChannel) {
      await this.safeSend(event.lobbyChannel, { content: `Created <#${channelId}> for workflow \`${event.workflowId}\`.` });
    }
  }

  private async publishWorkflowSummary(channelId: string, workflowId: string, planFile: string | undefined): Promise<void> {
    if (!planFile) return;
    let planText: string;
    try {
      planText = readFileSync(planFile, 'utf8');
    } catch (err) {
      await this.safeSend(channelId, { content: `Could not read the workflow plan file: ${errorText(err)}` });
      return;
    }
    const summary = summarizePlanText(planText);
    if (!summary) {
      await this.safeSend(channelId, { content: `Could not summarize the workflow plan for \`${workflowId}\`.` });
      return;
    }
    await this.safeSend(channelId, {
      content: renderReviewBody(summary, 'ready', this.gateway.maxMessageLength),
      files: [{ name: `workflow-${workflowId}-plan.yaml`, content: planText }],
    });
  }

  private async resolveRouteRepo(parsed: ParsedPlanningRequest, channelId: string): Promise<{ url?: string; error?: string }> {
    if (parsed.repo) return this.resolveRepoSelector(parsed.repo);
    const repositoryUrls = parsed.repositoryUrls ?? [];
    if (repositoryUrls.length > 1) {
      return { error: 'I found multiple repository URLs. Use one repository URL or one `[repo:…]` selector per request.' };
    }
    if (repositoryUrls.length === 1) return this.resolveRepoSelector(repositoryUrls[0]);
    const channelDefault = await resolveChannelRepo({ surface: DISCORD_SURFACE, channelId }, {
      configBinding: (key) => this.channelRepoBindings[key.channelId],
      log: this.log,
    });
    return { url: channelDefault.repoUrl ?? this.defaultRepoUrl };
  }

  private resolveRepoSelector(selector: string): { url?: string; error?: string } {
    const aliasKey = Object.keys(this.repoAliases).find((key) => key.toLowerCase() === selector.toLowerCase());
    if (aliasKey) return { url: this.repoAliases[aliasKey] };
    const literal = stripAngleBrackets(selector);
    if (/^(?:git@|https?:\/\/|ssh:\/\/)/i.test(literal)) {
      const supported = normalizeSupportedRepoCandidate(literal);
      return supported ? { url: supported } : { error: `Invalid repo URL "${literal}". Use a GitHub repo URL or a clone URL ending in .git.` };
    }
    const known = Object.keys(this.repoAliases);
    return { error: `Unknown repo "${selector}". Known aliases: ${known.length ? known.join(', ') : '(none configured)'}. Or pass a full git URL.` };
  }

  private resolveHarnessPreset(presetKey: string): HarnessPreset {
    return this.harnessPresets[presetKey] ?? this.harnessPresets[this.defaultHarnessPreset] ?? { tool: 'codex' };
  }

  private sayIn(channelId: string): SayFn {
    return (message) => this.transport.post(channelId, message);
  }

  private restoreProgressMessages(): void {
    for (const mapping of this.workflowChannelRepo?.list() ?? []) {
      if (mapping.progressCardTs) this.progressMessages.set(mapping.workflowId, mapping.progressCardTs);
    }
  }

  private saveProgressMessage(workflowId: string, messageId: string): void {
    this.progressMessages.set(workflowId, messageId);
    const mapping = this.workflowChannelRepo?.getByWorkflowId(workflowId);
    if (mapping && mapping.progressCardTs !== messageId) this.workflowChannelRepo?.save({ ...mapping, progressCardTs: messageId });
  }
}
