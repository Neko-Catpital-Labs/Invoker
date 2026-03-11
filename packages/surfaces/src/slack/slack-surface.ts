/**
 * SlackSurface — Bidirectional Slack integration via Bolt SDK in Socket Mode.
 *
 * Outbound: Task deltas → Slack messages (posted/updated in a channel)
 * Inbound: Slash commands + interactive buttons → SurfaceCommand
 */

import { App } from '@slack/bolt';
import type { Surface, CommandHandler, SurfaceEvent, LogFn } from '../surface.js';
import { parseSlackCommand } from './slack-commands.js';
import type { ConversationCommand } from './slack-commands.js';
import { formatSurfaceEvent, formatWorkflowStatus } from './slack-formatter.js';
import type { SlackMessage } from './slack-formatter.js';
import { PlanConversation } from './plan-conversation.js';
import { SessionManager, SessionIdentifier } from './thread-session-manager.js';
import type { ConversationRepository } from '@invoker/persistence';
import type { PlanDefinition } from '@invoker/core';

// ── Config ──────────────────────────────────────────────────

export interface SlackSurfaceConfig {
  botToken: string;
  appToken: string;
  signingSecret: string;
  channelId: string;
  /** Port for Socket Mode. Default: 0 (auto). */
  port?: number;
  /** Anthropic API key for plan conversations. If not set, @mention planning is disabled. */
  anthropicApiKey?: string;
  /** Root directory for codebase exploration in plan conversations. */
  workingDir?: string;
  /** Repository for persisting plan conversation state across restarts. */
  conversationRepo?: ConversationRepository;
  /** Slack user IDs allowed to run admin commands (e.g. conversations). Empty = no admin access. */
  adminUserIds?: string[];
  /** Default branch name (e.g. "master"). Used when plan YAML omits baseBranch. */
  defaultBranch?: string;
  /** Optional structured log callback for activity tracking. */
  log?: LogFn;
}

// ── ConversationLike ─────────────────────────────────────────

/** Shared interface between SessionHandle and PlanConversation for handler code. */
interface ConversationLike {
  sendMessage(message: string): Promise<string>;
  readonly planSubmitted: boolean;
  readonly submittedPlan: PlanDefinition | null;
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
  private anthropicApiKey?: string;
  private workingDir?: string;
  private defaultBranch?: string;
  private conversationRepo?: ConversationRepository;
  private sessionManager?: SessionManager;
  /** Bot user ID, resolved on start. */
  private botUserId?: string;
  private adminUserIds: Set<string>;
  private log: LogFn;
  /** Session lifecycle metrics */
  private sessionMetrics = {
    created: 0,
    recovered: 0,
    deleted: 0,
    errors: 0,
  };

  constructor(config: SlackSurfaceConfig) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      signingSecret: config.signingSecret,
      socketMode: true,
      port: config.port ?? 0,
    });
    this.channelId = config.channelId;
    this.anthropicApiKey = config.anthropicApiKey;
    this.workingDir = config.workingDir;
    this.defaultBranch = config.defaultBranch;
    this.conversationRepo = config.conversationRepo;
    this.adminUserIds = new Set(config.adminUserIds ?? []);
    this.log = config.log ?? ((source, level, msg) => {
      const fn = level === 'error' ? console.error : console.log;
      fn(`[${source}] ${msg}`);
    });

    // Create SessionManager when persistence is available
    if (config.anthropicApiKey && config.conversationRepo) {
      this.sessionManager = new SessionManager({
        anthropicApiKey: config.anthropicApiKey,
        workingDir: config.workingDir ?? process.cwd(),
        conversationRepo: config.conversationRepo,
        defaultBranch: config.defaultBranch,
        log: this.log,
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

    // Resolve bot user ID for filtering self-messages
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id as string;
      this.log('slack', 'info', `Bot user ID resolved: ${this.botUserId}`);
    } catch (err) {
      this.log('slack', 'error', `Failed to resolve bot user ID: ${err}`);
    }

    // Restore active conversations from the database
    await this.recoverActiveConversations();
  }

  async handleEvent(event: SurfaceEvent): Promise<void> {
    const message = formatSurfaceEvent(event);
    if (!message) return;

    // For task deltas, try to update existing message or post new one
    if (event.type === 'task_delta') {
      const delta = event.delta;
      const taskId = delta.type === 'created' ? delta.task.id : delta.taskId;

      const existingTs = this.taskMessages.get(taskId);
      if (existingTs && delta.type === 'updated') {
        await this.updateMessage(existingTs, message);
      } else {
        const ts = await this.postMessage(message);
        if (ts) {
          this.taskMessages.set(taskId, ts);
        }
      }
      return;
    }

    // For other events, just post
    await this.postMessage(message);
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

      if (!this.anthropicApiKey) {
        await say({
          text: 'Plan conversations are disabled (no ANTHROPIC_API_KEY configured).',
          thread_ts: event.ts,
        });
        return;
      }

      const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      this.log('slack', 'info', `@mention: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}" (user=${event.user})`);
      if (!text) {
        await say({
          text: 'Hi! Tag me with a message to start a plan conversation. Example: `@Invoker I want to add a REST API endpoint`',
          thread_ts: event.ts,
        });
        return;
      }

      const threadTs = event.thread_ts ?? event.ts;
      this.log('slack', 'info', `[TRACE] getSession start (channelId=${this.channelId}, threadTs=${threadTs}, userId=${event.user}, create=true)`);
      const conversation = await this.getSession(this.channelId, threadTs, event.user ?? 'unknown');
      this.log('slack', 'info', `[TRACE] getSession returned ${conversation ? 'session' : 'null'} (threadTs=${threadTs})`);
      if (!conversation) {
        await say({ text: 'Too many active conversations. Please wait.', thread_ts: threadTs });
        return;
      }

      this.log('slack', 'info', `[TRACE] handleConversationMessage start (threadTs=${threadTs}, textLen=${text.length})`);
      await this.handleConversationMessage(conversation, text, threadTs, say);
    });
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

      // Look up or recover session (don't create new sessions for random thread replies in fallback mode)
      const conversation = await this.getSession(this.channelId, msg.thread_ts, msg.user ?? 'unknown', false);
      if (!conversation) return;
      const text = (msg.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
      if (!text) return;

      this.log('slack', 'info', `[SESSION_MESSAGE] Thread reply (thread_ts=${msg.thread_ts}, user=${msg.user}, preview="${text.slice(0, 100)}${text.length > 100 ? '...' : ''}")`);

      await this.handleConversationMessage(conversation, text, msg.thread_ts, say);
    });
  }

  // ── Shared Conversation Message Handler ────────────────

  private async handleConversationMessage(
    conversation: ConversationLike,
    text: string,
    threadTs: string,
    say: (msg: { text: string; thread_ts: string }) => Promise<any>,
  ): Promise<void> {
    this.log('slack', 'info', `[TRACE] handleConversationMessage (thread_ts=${threadTs}, text="${text.slice(0, 80)}")`);

    try {
      const reply = await conversation.sendMessage(text);
      this.log('slack', 'info', `[TRACE] conversation.sendMessage returned (threadTs=${threadTs}, replyLen=${reply.length}, planSubmitted=${conversation.planSubmitted})`);
      const sanitized = sanitizeSlashCommands(reply);
      await say({ text: sanitized, thread_ts: threadTs });

      if (conversation.planSubmitted && conversation.submittedPlan) {
        this.log('slack', 'info', `[SESSION_SUBMIT] Plan submitted via submit_plan tool (thread_ts=${threadTs}, plan="${conversation.submittedPlan.name}")`);
        await say({
          text: `Starting execution of "${conversation.submittedPlan.name}"...`,
          thread_ts: threadTs,
        });
        await this.onCommand?.({ type: 'start_plan', plan: conversation.submittedPlan });
        this.cleanupSession(threadTs, 'plan_submitted');
      }
    } catch (err) {
      this.log('slack', 'error', `[SESSION_ERROR] Plan conversation error (thread_ts=${threadTs}): ${err}`);
      this.sessionMetrics.errors++;
      await say({
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        thread_ts: threadTs,
      });
    }
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
  private async getSession(channelId: string, threadTs: string, userId: string, create = true): Promise<ConversationLike | null> {
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
      );
      this.log('slack', 'info', `[TRACE] getOrCreateSession returned ${session ? 'session' : 'null'} (threadTs=${threadTs})`);
      return session;
    }

    // Fallback: no persistence configured
    this.log('slack', 'info', `[TRACE] Fallback path — no sessionManager (threadTs=${threadTs})`);
    let conversation = this.planConversations.get(threadTs);
    if (!conversation && create && this.anthropicApiKey) {
      this.sessionMetrics.created++;
      conversation = new PlanConversation({
        apiKey: this.anthropicApiKey,
        workingDir: this.workingDir,
        threadTs,
        conversationRepo: this.conversationRepo,
        defaultBranch: this.defaultBranch,
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
    if (!this.anthropicApiKey || !this.conversationRepo) return;

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
            apiKey: this.anthropicApiKey,
            workingDir: this.workingDir,
            threadTs: entry.threadTs,
            conversationRepo: this.conversationRepo,
            defaultBranch: this.defaultBranch,
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

  private async postMessage(message: SlackMessage): Promise<string | undefined> {
    try {
      const result = await this.app.client.chat.postMessage({
        channel: this.channelId,
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

  private async updateMessage(ts: string, message: SlackMessage): Promise<void> {
    try {
      await this.app.client.chat.update({
        channel: this.channelId,
        ts,
        text: message.text,
        blocks: message.blocks as any,
      });
    } catch (err) {
      this.log('slack', 'error', `Failed to update message: ${err}`);
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

// ── Helpers ──────────────────────────────────────────────────

/**
 * Strip hallucinated /invoker commands from LLM responses.
 * The inner Claude sometimes invents non-existent commands like "/invoker start_plan".
 * This replaces any such references (except /invoker conversations, which is real)
 * with the correct user instruction.
 */
export function sanitizeSlashCommands(text: string): string {
  return text.replace(
    /(?:use |run |type |try )?`?\/?invoker\s+(?!conversations\b)\w+[^`\n]*`?/gi,
    'reply with "yes", "go", or "execute" to confirm',
  );
}
