/**
 * SlackSurface — Bidirectional Slack integration via Bolt SDK in Socket Mode.
 *
 * Outbound: Task deltas → Slack messages (posted/updated in a channel)
 * Inbound: Slash commands + interactive buttons → SurfaceCommand
 */

import { App } from '@slack/bolt';
import { spawn } from 'node:child_process';
import type { Surface, CommandHandler, SurfaceCommand, SurfaceEvent, LogFn } from '../surface.js';
import { parseSlackCommand } from './slack-commands.js';
import type { ConversationCommand } from './slack-commands.js';
import { formatSurfaceEvent, formatWorkflowStatus } from './slack-formatter.js';
import { splitForSlack, sanitizeSlashCommands } from './slack-message-helpers.js';
import type { SlackMessage } from './slack-formatter.js';
import { PlanConversation, defaultPlanningCommand } from './plan-conversation.js';
import type { PlanningCommandBuilder } from './plan-conversation.js';
import { SessionManager, SessionIdentifier } from './thread-session-manager.js';
import { buildAssistantPrompt, parseWorkflowControl } from './workflow-assistant.js';
import type { WorkflowContext, WorkflowControl } from './workflow-assistant.js';
import type { ConversationRepository, WorkflowChannelRepository, WorkflowChannel } from '@invoker/data-store';

// ── Config ──────────────────────────────────────────────────

export interface SlackSurfaceConfig {
  botToken: string;
  appToken: string;
  signingSecret: string;
  channelId: string;
  /** Port for Socket Mode. Default: 0 (auto). */
  port?: number;
  /** Command to invoke the agent CLI for plan conversations. Default: 'agent'. */
  cursorCommand?: string;
  /** Model to use for the agent CLI (e.g. 'auto', 'sonnet-4'). Omit to use the CLI default. */
  model?: string;
  /** Root directory for codebase exploration in plan conversations. */
  workingDir?: string;
  /** Repository for persisting plan conversation state across restarts. */
  conversationRepo?: ConversationRepository;
  /** Slack user IDs allowed to run admin commands (e.g. conversations). Empty = no admin access. */
  adminUserIds?: string[];
  /** Default branch name (e.g. "master"). Used when plan YAML omits baseBranch. */
  defaultBranch?: string;
  /** Default repo URL (e.g. "git@github.com:user/repo.git"). Used when plan YAML omits repoUrl. */
  repoUrl?: string;
  /** Optional structured log callback for activity tracking. */
  log?: LogFn;
  /** Enable immediate acknowledgment when bot receives a message. Default: true. */
  enableImmediateAck?: boolean;
  /** Custom message for immediate acknowledgment. Default: 'Processing your request...'. */
  immediateAckMessage?: string;
  /** Custom emoji for immediate acknowledgment reaction. Default: ':thinking_face:'. */
  immediateAckEmoji?: string;
  /** Use typing indicator (emoji reaction) as acknowledgment method. Default: false. */
  useTypingIndicator?: boolean;
  /** Cursor CLI subprocess timeout for plan conversations in seconds. Default: 7200 (2 hours). */
  planningTimeoutSeconds?: number;
  /** Interval for heartbeat messages posted to Slack during planning in seconds. Default: 120 (2 minutes). Set to 0 to disable. */
  planningHeartbeatIntervalSeconds?: number;

  // ── Slack-native workflow extensions ──────────────────────
  /** Lobby channel where `@Invoker` starts planning. Defaults to channelId. */
  lobbyChannelId?: string;
  /** Injected planner command builder (registry-backed). Keeps surfaces layer-clean. */
  planningCommandBuilder?: PlanningCommandBuilder;
  /** Checks out the target repo for the planning agent; returns the working dir. */
  prepareRepoCheckout?: (repoUrl: string) => Promise<string>;
  /** Named harness presets: preset key → {tool, model}. Falls back to built-ins. */
  harnessPresets?: Record<string, HarnessPreset>;
  /** Default harness preset key when the message carries no `[preset]` tag. */
  defaultHarnessPreset?: string;
  /** Repo aliases: alias → git URL, resolved from a `[repo:<alias>]` tag. */
  repoAliases?: Record<string, string>;
  /** Repo URL used when the message carries no `[repo:]` tag. */
  defaultRepoUrl?: string;
  /** Persisted workflow↔channel mapping for routing + channel creation. */
  workflowChannelRepo?: WorkflowChannelRepository;
  /** Gathers a workflow's planning convo + task transcripts for the in-channel assistant. */
  gatherWorkflowContext?: (workflowId: string) => Promise<WorkflowContext>;
}

export interface HarnessPreset {
  tool: string;
  model?: string;
}

export const BUILTIN_HARNESS_PRESETS: Record<string, HarnessPreset> = {
  'cursor+claude': { tool: 'cursor', model: 'claude' },
  'cursor+codex': { tool: 'cursor', model: 'codex' },
  'omp+claude': { tool: 'omp', model: 'claude' },
  omp: { tool: 'omp' },
  codex: { tool: 'codex' },
};

export const DEFAULT_HARNESS_PRESET = 'cursor+claude';

interface PlanningContext {
  repoUrl?: string;
  presetKey: string;
  requestedBy?: string;
  lobbyChannel?: string;
}

// ── Planning request parsing ─────────────────────────────────

const PRESET_TOOL_HINTS = ['cursor', 'omp', 'codex', 'claude'];

/** A leading bracket tag is a likely preset attempt when it names a known tool or uses the tool+model form. */
function looksLikePreset(normalized: string): boolean {
  return normalized.includes('+') || PRESET_TOOL_HINTS.some((hint) => normalized.includes(hint));
}

/** Peel leading `[preset]` and `[repo:]` tags off a lobby mention; the rest is the request text. A preset-shaped tag matching no key is returned as `unknownPreset` so the caller can reject it instead of silently using the default. */
export function parsePlanningRequest(
  text: string,
  presetKeys: string[],
  defaultPresetKey: string,
): { presetKey: string; repo?: string; text: string; unknownPreset?: string } {
  let rest = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  let presetKey = defaultPresetKey;
  let repo: string | undefined;
  let unknownPreset: string | undefined;
  const keyset = new Set(presetKeys.map((k) => k.toLowerCase()));
  const tagRe = /^\[([^\]]*)\]\s*/;

  for (;;) {
    const m = tagRe.exec(rest);
    if (!m) break;
    const raw = m[1].trim();
    if (/^repo:/i.test(raw)) {
      repo = raw.slice(raw.indexOf(':') + 1).trim();
      rest = rest.slice(m[0].length);
      continue;
    }
    const normalized = raw.toLowerCase().replace(/\s+/g, '').replace(/^plain/, '');
    if (keyset.has(normalized)) {
      presetKey = normalized;
      rest = rest.slice(m[0].length);
      continue;
    }
    if (looksLikePreset(normalized)) {
      unknownPreset = raw;
      rest = rest.slice(m[0].length);
    }
    break;
  }

  return { presetKey, repo, text: rest.trim(), unknownPreset };
}

// ── ConversationLike ─────────────────────────────────────────

/** Shared interface between SessionHandle and PlanConversation for handler code. */
interface ConversationLike {
  sendMessage(message: string): Promise<string>;
  readonly planSubmitted: boolean;
  readonly submittedPlanText: string | null;
}

interface SayResult {
  ts?: string;
}

type SayFn = (msg: { text: string; thread_ts: string }) => Promise<SayResult>;

interface SlackMentionEvent {
  text?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  channel?: string;
}

// ── SlackSurface ────────────────────────────────────────────

export class SlackSurface implements Surface {
  readonly type = 'slack';
  private app: App;
  private channelId: string;
  private onCommand?: CommandHandler;
  /** Maps taskId → Slack message timestamp for in-place updates. */
  private taskMessages = new Map<string, string>();
  /** Maps thread_ts → PlanConversation for ongoing plan threads. */
  private planConversations = new Map<string, PlanConversation>();
  private cursorCommand: string;
  private workingDir?: string;
  private defaultBranch?: string;
  private repoUrl?: string;
  private conversationRepo?: ConversationRepository;
  private sessionManager?: SessionManager;
  /** Bot user ID, resolved on start. */
  private botUserId?: string;
  private adminUserIds: Set<string>;
  private log: LogFn;
  private enableImmediateAck: boolean;
  private immediateAckMessage: string;
  private immediateAckEmoji: string;
  private useTypingIndicator: boolean;
  private model?: string;
  private planningTimeoutSeconds?: number;
  private planningHeartbeatIntervalSeconds?: number;
  /** Minimum spacing between thread message posts to avoid Slack burst limits. */
  private readonly messagePacingMs = 1_100;
  /** Session lifecycle metrics */
  private sessionMetrics = {
    created: 0,
    recovered: 0,
    deleted: 0,
    errors: 0,
  };
  /** Maps thread_ts → acknowledgment message timestamp */
  private ackMessages = new Map<string, string>();
  /** Maps thread_ts → planning context carried into start_plan. */
  private planningContexts = new Map<string, PlanningContext>();

  // ── Slack-native workflow extensions ──────────────────────
  private lobbyChannelId: string;
  private planningCommandBuilder?: PlanningCommandBuilder;
  private prepareRepoCheckout?: (repoUrl: string) => Promise<string>;
  private harnessPresets: Record<string, HarnessPreset>;
  private defaultHarnessPreset: string;
  private repoAliases: Record<string, string>;
  private defaultRepoUrl?: string;
  private workflowChannelRepo?: WorkflowChannelRepository;
  private gatherWorkflowContext?: (workflowId: string) => Promise<WorkflowContext>;

  constructor(config: SlackSurfaceConfig) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      signingSecret: config.signingSecret,
      socketMode: true,
      port: config.port ?? 0,
    });
    this.channelId = config.channelId;
    this.cursorCommand = config.cursorCommand ?? 'agent';
    this.model = config.model;
    this.workingDir = config.workingDir;
    this.defaultBranch = config.defaultBranch;
    this.repoUrl = config.repoUrl;
    this.conversationRepo = config.conversationRepo;
    this.adminUserIds = new Set(config.adminUserIds ?? []);
    this.enableImmediateAck = config.enableImmediateAck ?? true;
    this.immediateAckMessage = config.immediateAckMessage ?? 'Processing your request...';
    this.immediateAckEmoji = config.immediateAckEmoji ?? 'thinking_face';
    this.useTypingIndicator = config.useTypingIndicator ?? false;
    this.planningTimeoutSeconds = config.planningTimeoutSeconds;
    this.planningHeartbeatIntervalSeconds = config.planningHeartbeatIntervalSeconds;
    this.lobbyChannelId = config.lobbyChannelId ?? config.channelId;
    this.planningCommandBuilder = config.planningCommandBuilder;
    this.prepareRepoCheckout = config.prepareRepoCheckout;
    this.harnessPresets = config.harnessPresets ?? BUILTIN_HARNESS_PRESETS;
    this.defaultHarnessPreset = config.defaultHarnessPreset ?? DEFAULT_HARNESS_PRESET;
    this.repoAliases = config.repoAliases ?? {};
    this.defaultRepoUrl = config.defaultRepoUrl ?? config.repoUrl;
    this.workflowChannelRepo = config.workflowChannelRepo;
    this.gatherWorkflowContext = config.gatherWorkflowContext;
    this.log = config.log ?? ((source, level, msg) => {
      const fn = level === 'error' ? console.error : console.log;
      fn(`[${source}] ${msg}`);
    });

    // Create SessionManager when persistence is available
    if (config.conversationRepo) {
      this.sessionManager = new SessionManager({
        cursorCommand: this.cursorCommand,
        model: this.model,
        workingDir: config.workingDir ?? process.cwd(),
        conversationRepo: config.conversationRepo,
        defaultBranch: config.defaultBranch,
        repoUrl: config.repoUrl,
        log: this.log,
        timeoutMs: (this.planningTimeoutSeconds ?? 7_200) * 1_000,
        planningCommandBuilder: config.planningCommandBuilder,
      });
    }
  }

  async start(onCommand: CommandHandler): Promise<void> {
    this.onCommand = onCommand;
    this.registerSlashCommand();
    this.registerActions();
    this.registerMentionHandler();
    this.registerMessageHandler();
    await this.app.start();

    const persistenceEnabled = !!this.conversationRepo;
    this.log('slack', 'info', `Slack bot started (Socket Mode, persistence=${persistenceEnabled ? 'on' : 'off'}, sessionManager=${!!this.sessionManager})`);

    // Start SessionManager eviction loop
    this.sessionManager?.start();

    // Run post-connect initialization in background — don't block event delivery
    this.postConnectInit().catch((err) => {
      this.log('slack', 'error', `Post-connect initialization failed: ${err}`);
    });
  }

  private async postConnectInit(): Promise<void> {
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id as string;
      this.log('slack', 'info', `Bot user ID resolved: ${this.botUserId}`);
    } catch (err) {
      this.log('slack', 'error', `Failed to resolve bot user ID: ${err}`);
    }

    await this.recoverActiveConversations();

    if (this.workflowChannelRepo) {
      const mappings = this.workflowChannelRepo.list();
      this.log('slack', 'info', `[WORKFLOW_CHANNELS] ${mappings.length} workflow channel mapping(s) available for routing`);
    }
  }

  async handleEvent(event: SurfaceEvent): Promise<void> {
    if (event.type === 'workflow_created') {
      await this.createWorkflowChannel(event);
      return;
    }

    const message = formatSurfaceEvent(event);
    if (!message) return;

    const channel = this.resolveChannelForWorkflow(this.deriveWorkflowId(event));

    // For task deltas, try to update existing message or post new one
    if (event.type === 'task_delta') {
      const delta = event.delta;
      const taskId = delta.type === 'created' ? delta.task.id : delta.taskId;

      const existingTs = this.taskMessages.get(taskId);
      if (existingTs && delta.type === 'updated') {
        await this.updateMessage(channel, existingTs, message);
      } else {
        const ts = await this.postMessage(message, channel);
        if (ts) {
          this.taskMessages.set(taskId, ts);
        }
      }
      return;
    }

    // For other events, just post
    await this.postMessage(message, channel);
  }

  private deriveWorkflowId(event: SurfaceEvent): string | undefined {
    if (event.type === 'workflow_status') return event.workflowId;
    if (event.type === 'task_delta') {
      const delta = event.delta;
      const taskId = delta.type === 'created' ? delta.task.id : delta.taskId;
      if (taskId.startsWith('__merge__')) return taskId.slice('__merge__'.length);
      const slash = taskId.indexOf('/');
      return slash === -1 ? undefined : taskId.slice(0, slash);
    }
    return undefined;
  }

  private resolveChannelForWorkflow(workflowId: string | undefined): string {
    if (!workflowId) return this.lobbyChannelId;
    return this.workflowChannelRepo?.getByWorkflowId(workflowId)?.channelId ?? this.lobbyChannelId;
  }

  async stop(): Promise<void> {
    if (this.sessionManager) {
      this.sessionManager.stop();
    } else {
      const activeCount = this.planConversations.size;
      if (activeCount > 0) {
        this.log('slack', 'info', `Shutting down with ${activeCount} active plan conversation(s) — state preserved in DB`);
      }
      this.planConversations.clear();
    }
    this.taskMessages.clear();
    await this.app.stop();
    this.log('slack', 'info', 'Slack bot stopped');
  }

  // ── Slash Command ───────────────────────────────────────

  private registerSlashCommand(): void {
    this.app.command('/invoker', async ({ command, ack, respond }) => {
      await ack();
      this.log('slack', 'info', `Slash command: /invoker ${command.text} (user=${command.user_name})`);

      const result = parseSlackCommand(command.text);
      if (!result.ok) {
        this.log('slack', 'error', `Invalid command: ${result.error}`);
        await respond({ text: result.error, response_type: 'ephemeral' });
        return;
      }

      if (!this.adminUserIds.has(command.user_id)) {
        await respond({ text: 'Permission denied. Conversation commands require admin access.', response_type: 'ephemeral' });
        return;
      }
      try {
        const output = this.executeConversationCommand(result.command);
        await respond({ text: output, response_type: 'ephemeral' });
      } catch (err) {
        this.log('slack', 'error', `Conversation command failed: ${result.command.type} — ${err}`);
        await respond({ text: `Error: ${String(err)}`, response_type: 'ephemeral' });
      }
    });
  }

  // ── Interactive Buttons ─────────────────────────────────

  private registerActions(): void {
    this.app.action(/^approve:/, async ({ action, ack }) => {
      await ack();
      if (action.type !== 'button' || !action.value) return;
      this.log('slack', 'info', `Button: approve task=${action.value}`);
      await this.onCommand?.({ type: 'approve', taskId: action.value });
    });

    this.app.action(/^reject:/, async ({ action, ack }) => {
      await ack();
      if (action.type !== 'button' || !action.value) return;
      this.log('slack', 'info', `Button: reject task=${action.value}`);
      await this.onCommand?.({ type: 'reject', taskId: action.value });
    });

    this.app.action(/^select:/, async ({ action, ack }) => {
      await ack();
      if (action.type !== 'button') return;
      const [taskId, experimentId] = (action.value ?? '').split(':');
      if (taskId && experimentId) {
        this.log('slack', 'info', `Button: select experiment task=${taskId} exp=${experimentId}`);
        await this.onCommand?.({ type: 'select_experiment', taskId, experimentId });
      }
    });

    this.app.action(/^input:/, async ({ action, ack, respond }) => {
      await ack();
      if (action.type !== 'button' || !action.value) return;
      this.log('slack', 'info', `Button: input requested for task=${action.value}`);
      await respond?.({
        text: `To provide input for task \`${action.value}\`, reply in this thread with your text.`,
        response_type: 'ephemeral',
      });
    });
  }

  // ── @mention Handler (Plan Conversations) ──────────────

  private registerMentionHandler(): void {
    this.app.event('app_mention', async ({ event, say }) => {
      const channel: string | undefined = event.channel;

      const mapping = channel ? this.workflowChannelRepo?.getByChannelId(channel) : null;
      if (mapping) {
        await this.handleWorkflowAssistantMention(mapping, event, say);
        return;
      }

      const isLobbyOrDm = !channel || channel === this.lobbyChannelId || channel.startsWith('D');
      if (!isLobbyOrDm) {
        this.log('slack', 'info', `Ignoring @mention in non-lobby channel ${channel}`);
        return;
      }

      await this.handlePlanningMention(event, say, channel ?? this.lobbyChannelId);
    });
  }

  // ── Planning mention (lobby) ───────────────────────────

  private async handlePlanningMention(
    event: SlackMentionEvent,
    say: SayFn,
    channel: string,
  ): Promise<void> {
    const parsed = parsePlanningRequest(
      event.text ?? '',
      Object.keys(this.harnessPresets),
      this.defaultHarnessPreset,
    );
    this.log('slack', 'info', `@mention: "${parsed.text.slice(0, 100)}${parsed.text.length > 100 ? '...' : ''}" (user=${event.user}, preset=${parsed.presetKey}, repo=${parsed.repo ?? 'default'})`);
    if (parsed.unknownPreset) {
      await say({
        text: `Unknown preset \`[${parsed.unknownPreset}]\`. Valid presets: ${Object.keys(this.harnessPresets).join(', ')}. Omit the tag to use the default (\`${this.defaultHarnessPreset}\`).`,
        thread_ts: event.ts,
      });
      return;
    }
    if (!parsed.text) {
      await say({
        text: 'Hi! Tag me with a message to start a plan conversation. Example: `@Invoker I want to add a REST API endpoint`',
        thread_ts: event.ts,
      });
      return;
    }

    const preset = this.resolveHarnessPreset(parsed.presetKey);
    const repoResolution = this.resolveRepoUrl(parsed.repo);
    if (repoResolution.error) {
      await say({ text: repoResolution.error, thread_ts: event.ts });
      return;
    }
    const repoUrl = repoResolution.url;

    const threadTs = event.thread_ts ?? event.ts;

    if (this.enableImmediateAck) {
      try {
        const ackResult = await say({ text: this.immediateAckMessage, thread_ts: threadTs });
        if (ackResult?.ts) this.ackMessages.set(threadTs, ackResult.ts);
        this.log('slack', 'info', `[ACK] Sent immediate acknowledgment (thread_ts=${threadTs})`);
      } catch (err) {
        this.log('slack', 'error', `[ACK] Failed to send immediate acknowledgment: ${err}`);
      }
    }

    let workingDir = this.workingDir;
    if (repoUrl && this.prepareRepoCheckout) {
      try {
        workingDir = await this.prepareRepoCheckout(repoUrl);
      } catch (err) {
        this.log('slack', 'error', `Failed to prepare repo checkout for ${repoUrl}: ${err}`);
        await say({ text: `Failed to check out repo: ${err instanceof Error ? err.message : String(err)}`, thread_ts: threadTs });
        return;
      }
    }

    const conversation = await this.getSession(channel, threadTs, event.user ?? 'unknown', true, {
      tool: preset.tool,
      model: preset.model,
      workingDir,
    });
    if (!conversation) {
      await say({ text: 'Too many active conversations. Please wait.', thread_ts: threadTs });
      return;
    }

    this.planningContexts.set(threadTs, {
      repoUrl,
      presetKey: parsed.presetKey,
      requestedBy: event.user,
      lobbyChannel: channel,
    });

    await this.handleConversationMessage(conversation, parsed.text, threadTs, say, channel);
  }

  private resolveHarnessPreset(presetKey: string): HarnessPreset {
    return (
      this.harnessPresets[presetKey] ??
      this.harnessPresets[this.defaultHarnessPreset] ??
      BUILTIN_HARNESS_PRESETS[DEFAULT_HARNESS_PRESET]
    );
  }

  private resolveRepoUrl(repo?: string): { url?: string; error?: string } {
    if (!repo) return { url: this.defaultRepoUrl };
    const alias = this.repoAliases[repo];
    if (alias) return { url: alias };
    if (/^(git@|https?:\/\/|ssh:\/\/)/.test(repo)) return { url: repo };
    const known = Object.keys(this.repoAliases);
    const list = known.length ? known.join(', ') : '(none configured)';
    return { error: `Unknown repo "${repo}". Known aliases: ${list}. Or pass a full git URL.` };
  }

  // ── In-channel workflow assistant ──────────────────────

  private async handleWorkflowAssistantMention(
    mapping: WorkflowChannel,
    event: SlackMentionEvent,
    say: SayFn,
  ): Promise<void> {
    const threadTs = event.thread_ts ?? event.ts;
    const text = (event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!text) {
      await say({
        text: `I answer questions about workflow \`${mapping.workflowId}\` and run controls: \`status\`, \`approve <id>\`, \`reject <id>\`, \`retry <id>\`, \`input <id>: <text>\`.`,
        thread_ts: threadTs,
      });
      return;
    }

    const ctrl = parseWorkflowControl(text);
    if (ctrl) {
      await this.dispatchWorkflowControl(mapping, ctrl, say, threadTs);
      return;
    }

    if (!this.gatherWorkflowContext) {
      await say({ text: 'Workflow context is not available in this deployment.', thread_ts: threadTs });
      return;
    }

    try {
      const ctx = await this.gatherWorkflowContext(mapping.workflowId);
      const harness = this.resolveHarnessPreset(mapping.harnessPreset ?? this.defaultHarnessPreset);
      const reply = await this.runOneShotPlanner(harness, buildAssistantPrompt(text, ctx));
      const chunks = splitForSlack(sanitizeSlashCommands(reply));
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await this.sleep(this.messagePacingMs);
        await this.sayWithRateLimitRetry(say, { text: chunks[i], thread_ts: threadTs });
      }
    } catch (err) {
      this.log('slack', 'error', `[ASSISTANT] Q&A failed (workflow=${mapping.workflowId}): ${err}`);
      await this.sayWithRateLimitRetry(say, {
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        thread_ts: threadTs,
      });
    }
  }

  private async dispatchWorkflowControl(
    mapping: WorkflowChannel,
    ctrl: WorkflowControl,
    say: SayFn,
    threadTs: string,
  ): Promise<void> {
    const scoped = (task: string): string => `${mapping.workflowId}/${task}`;
    switch (ctrl.kind) {
      case 'status':
        await this.onCommand?.({ type: 'get_status', workflowId: mapping.workflowId });
        await say({ text: `Fetching status for \`${mapping.workflowId}\`...`, thread_ts: threadTs });
        return;
      case 'approve':
        await this.onCommand?.({ type: 'approve', taskId: scoped(ctrl.task) });
        await say({ text: `Approving \`${scoped(ctrl.task)}\`.`, thread_ts: threadTs });
        return;
      case 'reject':
        await this.onCommand?.({ type: 'reject', taskId: scoped(ctrl.task) });
        await say({ text: `Rejecting \`${scoped(ctrl.task)}\`.`, thread_ts: threadTs });
        return;
      case 'retry':
        await this.onCommand?.({ type: 'retry', taskId: scoped(ctrl.task) });
        await say({ text: `Retrying \`${scoped(ctrl.task)}\`.`, thread_ts: threadTs });
        return;
      case 'input':
        await this.onCommand?.({ type: 'provide_input', taskId: scoped(ctrl.task), input: ctrl.text });
        await say({ text: `Sent input to \`${scoped(ctrl.task)}\`.`, thread_ts: threadTs });
        return;
    }
  }

  private runOneShotPlanner(harness: HarnessPreset, prompt: string): Promise<string> {
    const { command, args } = this.planningCommandBuilder
      ? this.planningCommandBuilder({ tool: harness.tool, model: harness.model, prompt })
      : defaultPlanningCommand(this.cursorCommand, { model: harness.model, prompt });
    const timeoutMs = (this.planningTimeoutSeconds ?? 7_200) * 1_000;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.workingDir ?? process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        reject(new Error(`Planner timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim() || '(no output)');
        else reject(new Error(stderr.trim() || stdout.trim() || `Planner exited with code ${code}`));
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn planner CLI: ${err.message}`));
      });
    });
  }

  // ── Workflow channel creation ──────────────────────────

  private async createWorkflowChannel(
    event: Extract<SurfaceEvent, { type: 'workflow_created' }>,
  ): Promise<void> {
    const client = this.app.client;
    const name = `workflow-${event.workflowId.replace(/^wf-/, '')}`
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .slice(0, 80);

    let channelId: string | undefined;
    try {
      const created = await client.conversations.create({ name, is_private: true });
      channelId = created.channel?.id;
    } catch (err) {
      const code = this.slackErrorCode(err);
      if (code === 'name_taken') {
        try {
          const list = await client.conversations.list({ types: 'private_channel', limit: 1000 });
          channelId = (list.channels ?? []).find((c) => c.name === name)?.id;
        } catch (listErr) {
          this.log('slack', 'error', `Failed to list channels after name_taken: ${listErr}`);
        }
      } else {
        this.log('slack', 'error', `Failed to create workflow channel ${name}: ${err}`);
      }
    }

    if (!channelId) {
      if (event.lobbyChannel) {
        await this.postToThread(event.lobbyChannel, event.lobbyThreadTs, `Could not create a channel for workflow \`${event.workflowId}\`.`);
      }
      return;
    }

    if (event.requestedBy) {
      try {
        await client.conversations.invite({ channel: channelId, users: event.requestedBy });
      } catch (err) {
        const code = this.slackErrorCode(err);
        if (code !== 'already_in_channel' && code !== 'cant_invite_self') {
          this.log('slack', 'warn', `Failed to invite ${event.requestedBy} to ${channelId}: ${err}`);
        }
      }
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

    await this.postMessage(
      {
        text: `Workflow \`${event.workflowId}\` is running here. Mention me with \`status\`, \`approve <task>\`, \`reject <task>\`, \`retry <task>\`, or ask a question about this workflow.`,
        blocks: [],
      },
      channelId,
    );

    if (event.lobbyChannel) {
      await this.postToThread(event.lobbyChannel, event.lobbyThreadTs, `Created <#${channelId}> for workflow \`${event.workflowId}\`.`);
    }
  }

  private async postToThread(channel: string, threadTs: string | undefined, text: string): Promise<void> {
    try {
      await this.app.client.chat.postMessage({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    } catch (err) {
      this.log('slack', 'error', `Failed to post to thread: ${err}`);
    }
  }

  // ── Thread Reply Handler (Continue Plan Conversations) ─

  private registerMessageHandler(): void {
    this.app.event('message', async ({ event, say }) => {
      const msg = event as any;

      if (!msg.thread_ts) return;
      if (msg.bot_id || msg.user === this.botUserId) return;
      if (msg.subtype === 'bot_message') return;
      // Skip @mentions — already handled by registerMentionHandler
      if (this.botUserId && (msg.text ?? '').includes(`<@${this.botUserId}>`)) return;

      const channel = (msg.channel as string | undefined) ?? this.channelId;
      if (msg.channel && this.workflowChannelRepo?.getByChannelId(msg.channel)) return;

      // Look up or recover session (don't create new sessions for random thread replies in fallback mode)
      const conversation = await this.getSession(channel, msg.thread_ts, msg.user ?? 'unknown', false);
      if (!conversation) return;
      const text = (msg.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
      if (!text) return;

      this.log('slack', 'info', `[SESSION_MESSAGE] Thread reply (thread_ts=${msg.thread_ts}, user=${msg.user}, preview="${text.slice(0, 100)}${text.length > 100 ? '...' : ''}")`);

      await this.handleConversationMessage(conversation, text, msg.thread_ts, say, channel);
    });
  }

  // ── Shared Conversation Message Handler ────────────────

  private async handleConversationMessage(
    conversation: ConversationLike,
    text: string,
    threadTs: string,
    say: SayFn,
    channel: string = this.lobbyChannelId,
  ): Promise<void> {
    const tEntry = Date.now();
    this.log('slack', 'info', `[TRACE] handleConversationMessage (thread_ts=${threadTs}, text="${text.slice(0, 80)}")`);

    const typingStarted = await this.startTypingIndicator(channel, threadTs);
    const tSetup = Date.now();

    const heartbeatMs = (this.planningHeartbeatIntervalSeconds ?? 120) * 1_000;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    const heartbeatTimestamps: string[] = [];
    let heartbeatInFlight = false;
    if (heartbeatMs > 0) {
      heartbeatTimer = setInterval(async () => {
        if (heartbeatInFlight) return;
        heartbeatInFlight = true;
        try {
          const result = await this.sayWithRateLimitRetry(say, {
            text: ':hourglass_flowing_sand: Still thinking...',
            thread_ts: threadTs,
          });
          if (result?.ts) heartbeatTimestamps.push(result.ts);
          this.log('slack', 'info', `[HEARTBEAT] Sent planning heartbeat (thread_ts=${threadTs})`);
        } catch (err) {
          this.log('slack', 'error', `[HEARTBEAT] Failed to send planning heartbeat: ${err}`);
        } finally {
          heartbeatInFlight = false;
        }
      }, heartbeatMs);
    }

    try {
      const reply = await conversation.sendMessage(text);
      const tCursor = Date.now();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const hbTs of heartbeatTimestamps) {
        try {
          await this.deleteMessage(channel, hbTs);
        } catch (err) {
          this.log('slack', 'warn', `[HEARTBEAT] Failed to delete heartbeat message ${hbTs}: ${err}`);
        }
      }
      const tHeartbeatCleanup = Date.now();
      this.log('slack', 'info', `[TRACE] conversation.sendMessage returned (threadTs=${threadTs}, replyLen=${reply.length}, planSubmitted=${conversation.planSubmitted})`);

      if (typingStarted) {
        await this.stopTypingIndicator(channel, threadTs);
      }

      const chunks = splitForSlack(sanitizeSlashCommands(reply));

      const ackTs = this.ackMessages.get(threadTs);
      if (ackTs) {
        const updated = await this.updateMessage(channel, ackTs, { text: chunks[0], blocks: [] });
        this.ackMessages.delete(threadTs);
        if (updated) {
          this.log('slack', 'info', `[ACK] Replaced immediate acknowledgment with actual response (thread_ts=${threadTs}, ack_ts=${ackTs}, chunks=${chunks.length})`);
        } else {
          this.log('slack', 'warn', `[ACK] Failed to replace ack, falling back to new message (thread_ts=${threadTs}, ack_ts=${ackTs})`);
          await this.deleteMessage(channel, ackTs);
          await this.sayWithRateLimitRetry(say, { text: chunks[0], thread_ts: threadTs });
        }
      } else {
        await this.sayWithRateLimitRetry(say, { text: chunks[0], thread_ts: threadTs });
      }

      for (let i = 1; i < chunks.length; i++) {
        await this.sleep(this.messagePacingMs);
        await this.sayWithRateLimitRetry(say, { text: chunks[i], thread_ts: threadTs });
      }
      const tPosting = Date.now();

      if (conversation.planSubmitted && conversation.submittedPlanText) {
        this.log('slack', 'info', `[SESSION_SUBMIT] Plan submitted via confirmation (thread_ts=${threadTs})`);
        await this.sayWithRateLimitRetry(say, {
          text: `Starting plan execution...`,
          thread_ts: threadTs,
        });
        const ctx = this.planningContexts.get(threadTs);
        await this.onCommand?.({
          type: 'start_plan',
          planText: conversation.submittedPlanText,
          repoUrl: ctx?.repoUrl,
          harnessPreset: ctx?.presetKey,
          requestedBy: ctx?.requestedBy,
          lobbyChannel: ctx?.lobbyChannel ?? channel,
          lobbyThreadTs: threadTs,
        });
        this.planningContexts.delete(threadTs);
        this.cleanupSession(threadTs, 'plan_submitted');
      }
      const tEnd = Date.now();

      this.log('slack', 'info', `[PERF] thread_ts=${threadTs} setup=${tSetup - tEntry}ms cursor=${tCursor - tSetup}ms heartbeatCleanup=${tHeartbeatCleanup - tCursor}ms posting=${tPosting - tHeartbeatCleanup}ms chunks=${chunks.length} total=${tEnd - tEntry}ms`);
    } catch (err) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const hbTs of heartbeatTimestamps) {
        try {
          await this.deleteMessage(channel, hbTs);
        } catch (deleteErr) {
          this.log('slack', 'warn', `[HEARTBEAT] Failed to delete heartbeat message ${hbTs}: ${deleteErr}`);
        }
      }
      if (typingStarted) {
        await this.stopTypingIndicator(channel, threadTs);
      }

      const tErr = Date.now();
      this.log('slack', 'error', `[SESSION_ERROR] Plan conversation error (thread_ts=${threadTs}, elapsed=${tErr - tEntry}ms): ${err}`);
      if (this.isCursorCliMissingError(err)) {
        this.log(
          'slack',
          'error',
          '[ACTION_REQUIRED] Cursor CLI is missing. Please install Cursor CLI or set CURSOR_COMMAND to an absolute path (for macOS app installs, try /Applications/Cursor.app/Contents/Resources/app/bin/cursor).',
        );
      }
      this.sessionMetrics.errors++;
      await this.sayWithRateLimitRetry(say, {
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        thread_ts: threadTs,
      });
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private slackErrorCode(err: unknown): string | undefined {
    if (!err || typeof err !== 'object') return undefined;
    const e = err as { data?: { error?: unknown }; code?: unknown };
    if (typeof e.data?.error === 'string') return e.data.error;
    if (typeof e.code === 'string') return e.code;
    return undefined;
  }

  private getRetryAfterMs(err: unknown): number | null {
    const maybeErr = err as any;
    const retryAfter =
      maybeErr?.data?.retry_after ??
      maybeErr?.retryAfter ??
      maybeErr?.headers?.['retry-after'] ??
      maybeErr?.response?.headers?.['retry-after'];
    const code = maybeErr?.data?.error ?? maybeErr?.code;
    if (code === 'rate_limited' || retryAfter !== undefined) {
      const retrySeconds = Number(retryAfter);
      if (!Number.isNaN(retrySeconds) && retrySeconds > 0) return retrySeconds * 1000;
      return 1_000;
    }
    return null;
  }

  private async sayWithRateLimitRetry(
    say: (msg: { text: string; thread_ts: string }) => Promise<any>,
    msg: { text: string; thread_ts: string },
  ): Promise<any> {
    try {
      return await say(msg);
    } catch (err) {
      const retryAfterMs = this.getRetryAfterMs(err);
      if (retryAfterMs === null) throw err;
      this.log('slack', 'warn', `[RATE_LIMIT] Delaying retry for ${retryAfterMs}ms (thread_ts=${msg.thread_ts})`);
      await this.sleep(retryAfterMs + 100);
      return await say(msg);
    }
  }

  private isCursorCliMissingError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('Failed to spawn Cursor CLI') && msg.includes('ENOENT');
  }

  // ── Conversation Admin Commands ─────────────────────────

  private executeConversationCommand(cmd: ConversationCommand): string {
    if (!this.conversationRepo) {
      return 'Conversation persistence is not enabled. Configure a ConversationRepository to use these commands.';
    }

    switch (cmd.type) {
      case 'conversations_list': {
        const active = this.conversationRepo.listActiveConversations();
        const inMemory = this.sessionManager
          ? this.sessionManager.getMetrics().totalActive
          : this.planConversations.size;
        if (active.length === 0 && inMemory === 0) {
          return 'No active conversations.';
        }
        const lines = active.map((c) => {
          const hasPlan = c.extractedPlan ? ' (has plan)' : '';
          return `• \`${c.threadTs}\` — created ${c.createdAt}, updated ${c.updatedAt}${hasPlan}`;
        });
        const header = `*Active conversations:* ${active.length} persisted, ${inMemory} in memory\n`;
        return header + lines.join('\n');
      }

      case 'conversations_clear': {
        const existing = this.conversationRepo.loadConversation(cmd.threadTs);
        if (!existing) {
          return `No conversation found for thread \`${cmd.threadTs}\`.`;
        }
        this.conversationRepo.deleteConversation(cmd.threadTs);
        if (this.sessionManager) {
          this.sessionManager.evictSession(new SessionIdentifier(this.channelId, cmd.threadTs));
        } else {
          this.cleanupSession(cmd.threadTs, 'admin_clear');
        }
        this.log('slack', 'info', `[SESSION_ADMIN] Admin cleared conversation (thread_ts=${cmd.threadTs})`);
        return `Cleared conversation \`${cmd.threadTs}\`.`;
      }

      case 'conversations_cleanup': {
        const deleted = this.conversationRepo.cleanupOldConversations(cmd.olderThanDays);
        this.sessionMetrics.deleted += deleted;
        this.log('slack', 'info', `[SESSION_ADMIN] Admin cleanup (count=${deleted}, older_than_days=${cmd.olderThanDays})`);
        return `Cleaned up ${deleted} conversation(s) older than ${cmd.olderThanDays} day(s).`;
      }

      case 'conversations_status': {
        const conv = this.conversationRepo.loadConversation(cmd.threadTs);
        if (!conv) {
          return `No conversation found for thread \`${cmd.threadTs}\`.`;
        }
        const inMemory = this.sessionManager
          ? this.sessionManager.getMetrics().totalActive > 0 // approximate; exact lookup not exposed
          : this.planConversations.has(cmd.threadTs);
        const planStatus = conv.extractedPlan
          ? `yes ("${conv.extractedPlan.name}")`
          : 'no';
        return [
          `*Conversation* \`${cmd.threadTs}\``,
          `• Channel: ${conv.channelId || '(unknown)'}`,
          `• User: ${conv.userId || '(unknown)'}`,
          `• Messages: ${conv.messages.length}`,
          `• Plan extracted: ${planStatus}`,
          `• Plan submitted: ${conv.planSubmitted ? 'yes' : 'no'}`,
          `• In memory: ${inMemory ? 'yes' : 'no'}`,
          `• Created: ${conv.createdAt}`,
          `• Updated: ${conv.updatedAt}`,
        ].join('\n');
      }

      case 'conversations_metrics': {
        const persistedActive = this.conversationRepo.listActiveConversations().length;
        if (this.sessionManager) {
          const sm = this.sessionManager.getMetrics();
          return [
            `*Session Manager Metrics*`,
            `• Total active: ${sm.totalActive}`,
            `• Active (in use): ${sm.active}`,
            `• Idle: ${sm.idle}`,
            `• Submitted: ${sm.submitted}`,
            `• Persisted active: ${persistedActive}`,
            ``,
            `*Lifecycle Counters*`,
            `• Recovered: ${this.sessionMetrics.recovered}`,
            `• Errors: ${this.sessionMetrics.errors}`,
          ].join('\n');
        }
        const inMemoryCount = this.planConversations.size;
        return [
          `*Session Lifecycle Metrics*`,
          `• Sessions created: ${this.sessionMetrics.created}`,
          `• Sessions recovered (eager): ${this.sessionMetrics.recovered}`,
          `• Sessions deleted: ${this.sessionMetrics.deleted}`,
          `• Errors: ${this.sessionMetrics.errors}`,
          ``,
          `*Current State*`,
          `• In-memory sessions: ${inMemoryCount}`,
          `• Persisted active sessions: ${persistedActive}`,
        ].join('\n');
      }

      case 'conversations_inspect': {
        const conv = this.conversationRepo.loadConversation(cmd.threadTs);
        if (!conv) {
          return `No conversation found for thread \`${cmd.threadTs}\`.`;
        }
        const inMemory = this.sessionManager
          ? this.sessionManager.getMetrics().totalActive > 0
          : this.planConversations.has(cmd.threadTs);

        const messagePreview = conv.messages.slice(-3).map((m, i) => {
          const role = m.role === 'user' ? 'U' : 'A';
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          const preview = content.slice(0, 80).replace(/\n/g, ' ');
          return `  ${role}: ${preview}${content.length > 80 ? '...' : ''}`;
        }).join('\n');

        return [
          `*Session Inspection* \`${cmd.threadTs}\``,
          ``,
          `*Metadata*`,
          `• Channel: ${conv.channelId || '(unknown)'}`,
          `• User: ${conv.userId || '(unknown)'}`,
          `• Created: ${conv.createdAt}`,
          `• Updated: ${conv.updatedAt}`,
          ``,
          `*State*`,
          `• In memory: ${inMemory ? 'yes' : 'no'}`,
          `• Total messages: ${conv.messages.length}`,
          `• Plan extracted: ${conv.extractedPlan ? `yes ("${conv.extractedPlan.name}")` : 'no'}`,
          `• Plan submitted: ${conv.planSubmitted ? 'yes' : 'no'}`,
          ``,
          `*Recent messages (last 3)*`,
          messagePreview || '  (no messages)',
          ``,
          `*Session Map*`,
          `• Total sessions in memory: ${this.sessionManager ? this.sessionManager.getMetrics().totalActive : this.planConversations.size}`,
          `• Using SessionManager: ${!!this.sessionManager}`,
        ].join('\n');
      }
    }
  }

  // ── Session Management Helpers ──────────────────────────

  /**
   * Get or create a conversation session for a thread.
   * When SessionManager is available, delegates to it.
   * Falls back to the in-memory Map when no persistence is configured.
   */
  private async getSession(
    channelId: string,
    threadTs: string,
    userId: string,
    create = true,
    opts?: { tool?: string; model?: string; workingDir?: string },
  ): Promise<ConversationLike | null> {
    this.log('slack', 'info', `[TRACE] getSession (channelId=${channelId}, threadTs=${threadTs}, userId=${userId}, create=${create}, hasSessionManager=${!!this.sessionManager})`);
    if (this.sessionManager) {
      if (!create) {
        // Look up existing session without creating — used by message handler
        // to avoid creating empty sessions for random thread replies
        this.log('slack', 'info', `[TRACE] findSession (threadTs=${threadTs})`);
        const found = this.sessionManager.findSession(
          new SessionIdentifier(channelId, threadTs),
        );
        this.log('slack', 'info', `[TRACE] findSession returned ${found ? 'session' : 'null'} (threadTs=${threadTs})`);
        return found;
      }
      this.log('slack', 'info', `[TRACE] getOrCreateSession delegating to sessionManager (threadTs=${threadTs})`);
      const session = await this.sessionManager.getOrCreateSession(
        new SessionIdentifier(channelId, threadTs),
        userId,
        opts,
      );
      this.log('slack', 'info', `[TRACE] getOrCreateSession returned ${session ? 'session' : 'null'} (threadTs=${threadTs})`);
      return session;
    }

    // Fallback: no persistence configured
    this.log('slack', 'info', `[TRACE] Fallback path — no sessionManager (threadTs=${threadTs})`);
    let conversation = this.planConversations.get(threadTs);
    if (!conversation && create) {
      this.sessionMetrics.created++;
      conversation = new PlanConversation({
        cursorCommand: this.cursorCommand,
        tool: opts?.tool,
        model: opts?.model ?? this.model,
        planningCommandBuilder: this.planningCommandBuilder,
        workingDir: opts?.workingDir ?? this.workingDir,
        threadTs,
        conversationRepo: this.conversationRepo,
        defaultBranch: this.defaultBranch,
        repoUrl: this.repoUrl,
        timeoutMs: (this.planningTimeoutSeconds ?? 7_200) * 1_000,
      });
      this.planConversations.set(threadTs, conversation);
    }
    return conversation ?? null;
  }

  /**
   * Clean up a session from memory and update metrics.
   * @param threadTs The thread timestamp
   * @param reason Why the session is being cleaned up
   */
  private cleanupSession(threadTs: string, reason: string): void {
    if (this.sessionManager) {
      this.sessionManager.markPlanSubmitted(new SessionIdentifier(this.channelId, threadTs));
      this.log('slack', 'info', `[SESSION_CLEANUP] Marked submitted (thread_ts=${threadTs}, reason=${reason})`);
      return;
    }
    const existed = this.planConversations.has(threadTs);
    if (existed) {
      this.planConversations.delete(threadTs);
      this.sessionMetrics.deleted++;
      this.log('slack', 'info', `[SESSION_CLEANUP] Removed from memory (thread_ts=${threadTs}, reason=${reason})`);
    }
  }

  // ── Conversation Recovery ───────────────────────────────

  /**
   * Eagerly restore all active (non-submitted) conversations from the database.
   * Called once during start() so threads survive bot restarts.
   */
  private async recoverActiveConversations(): Promise<void> {
    if (!this.conversationRepo) return;

    try {
      const active = this.conversationRepo.listActiveConversations();
      if (active.length === 0) {
        this.log('slack', 'info', '[SESSION_RECOVERY] No active conversations to recover');
        return;
      }

      this.log('slack', 'info', `[SESSION_RECOVERY] Starting recovery of ${active.length} active conversation(s)`);

      if (this.sessionManager) {
        // Delegate recovery to SessionManager
        for (const entry of active) {
          const id = new SessionIdentifier(
            entry.channelId || this.channelId,
            entry.threadTs,
          );
          await this.sessionManager.getOrCreateSession(id, entry.userId);
          this.sessionMetrics.recovered++;
        }
      } else {
        // Fallback: direct Map recovery
        for (const entry of active) {
          const conversation = new PlanConversation({
            cursorCommand: this.cursorCommand,
            model: this.model,
            workingDir: this.workingDir,
            threadTs: entry.threadTs,
            conversationRepo: this.conversationRepo,
            defaultBranch: this.defaultBranch,
            repoUrl: this.repoUrl,
          });
          await conversation.init();
          this.planConversations.set(entry.threadTs, conversation);
          this.sessionMetrics.recovered++;
        }
      }

      this.log('slack', 'info', `[SESSION_RECOVERY] Completed recovery (recovered=${active.length})`);
    } catch (err) {
      this.log('slack', 'error', `[SESSION_ERROR] Failed to recover conversations from DB: ${err}`);
      this.sessionMetrics.errors++;
    }
  }

  // ── Slack API Helpers ───────────────────────────────────

  /**
   * Start typing indicator by adding emoji reaction to a message.
   * Returns true if reaction was added successfully.
   */
  private async startTypingIndicator(channel: string, timestamp: string): Promise<boolean> {
    if (!this.useTypingIndicator) return false;
    try {
      await this.app.client.reactions.add({
        channel,
        timestamp,
        name: this.immediateAckEmoji,
      });
      this.log('slack', 'info', `[TYPING] Started indicator (ts=${timestamp})`);
      return true;
    } catch (err) {
      this.log('slack', 'error', `[TYPING] Failed to start indicator: ${err}`);
      return false;
    }
  }

  /**
   * Stop typing indicator by removing emoji reaction from a message.
   */
  private async stopTypingIndicator(channel: string, timestamp: string): Promise<void> {
    if (!this.useTypingIndicator) return;
    try {
      await this.app.client.reactions.remove({
        channel,
        timestamp,
        name: this.immediateAckEmoji,
      });
      this.log('slack', 'info', `[TYPING] Stopped indicator (ts=${timestamp})`);
    } catch (err) {
      // Silently ignore removal failures (reaction may not exist)
      this.log('slack', 'info', `[TYPING] Could not remove indicator (may not exist): ${err}`);
    }
  }

  private async postMessage(message: SlackMessage, channel = this.lobbyChannelId): Promise<string | undefined> {
    try {
      const result = await this.app.client.chat.postMessage({
        channel,
        text: message.text,
        blocks: message.blocks as any,
      });
      this.log('slack', 'info', `Posted message: "${message.text.slice(0, 80)}..."`);
      return result.ts;
    } catch (err) {
      this.log('slack', 'error', `Failed to post message: ${err}`);
      return undefined;
    }
  }

  private async updateMessage(channel: string, ts: string, message: SlackMessage): Promise<boolean> {
    try {
      await this.app.client.chat.update({
        channel,
        ts,
        text: message.text,
        blocks: message.blocks as any,
      });
      return true;
    } catch (err) {
      this.log('slack', 'error', `Failed to update message: ${err}`);
      return false;
    }
  }

  private async deleteMessage(channel: string, ts: string): Promise<void> {
    try {
      await this.app.client.chat.delete({
        channel,
        ts,
      });
    } catch (err) {
      this.log('slack', 'error', `Failed to delete message: ${err}`);
    }
  }

  // ── Testing Accessors ───────────────────────────────────

  /** Exposed for testing. Returns the Bolt App instance. */
  getApp(): App {
    return this.app;
  }

  /** Exposed for testing. Returns the task→message timestamp map. */
  getTaskMessages(): Map<string, string> {
    return this.taskMessages;
  }
}
