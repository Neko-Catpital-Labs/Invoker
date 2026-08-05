/**
 * SlackSurface — Bidirectional Slack integration via Bolt SDK in Socket Mode.
 *
 * Outbound: Task deltas → Slack messages (posted/updated in a channel)
 * Inbound: Slash commands + interactive buttons → SurfaceCommand
 */

import { App, type RespondFn } from '@slack/bolt';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  formatPlanSummaryLines,
  formatSlackPlanBrief,
  preparePlanningReview,
  summarizePlanText,
  type PlanSummary,
  type PlanningConfirmationMode,
} from '@invoker/planning-core';
import type { Surface, CommandHandler, SurfaceCommand, SurfaceEvent, LogFn, WorkflowOp, WorkflowOpResult, WorkflowOpProgress } from '../surface.js';
import { parseSlackCommand } from './slack-commands.js';
import type { ConversationCommand } from './slack-commands.js';
import { formatSurfaceEvent, formatWorkflowStatus } from './slack-formatter.js';
import {
  splitForSlack,
  sanitizeSlackOutbound,
  extractArtifactPaths,
  MAX_ARTIFACT_BATCH_BYTES,
} from './slack-message-helpers.js';
import type { SlackMessage } from './slack-formatter.js';
import {
  DEFAULT_PLANNER_RETRY_BASE_DELAY_MS,
  DEFAULT_PLANNER_RETRY_LIMIT,
  PlanConversation,
  buildEmptyPlannerOutputError,
  defaultPlanningCommand,
  isConfirmation,
  isNegation,
} from './plan-conversation.js';
import type { ConversationMode, PlanIntentSignal, PlanningCommandBuilder } from './plan-conversation.js';
import { parseLobbyControl } from './lobby-control.js';
import type { LobbyControl } from './lobby-control.js';
import { SessionManager, SessionIdentifier } from './thread-session-manager.js';
import { buildAssistantPrompt, parseWorkflowControl } from './workflow-assistant.js';
import type { WorkflowContext, WorkflowControl } from './workflow-assistant.js';
import type { ConversationRepository, SlackPlanDraft, SlackSessionRepository, WorkflowChannelRepository, WorkflowChannel } from '@invoker/data-store';
import { SlackPlanDraftRepository } from '@invoker/data-store';
import { formatCodexPlannerStdout, materializeLocalAgentPrompt } from '@invoker/execution-engine';
import type { HarnessSessionDriver } from '@invoker/execution-engine';

function truncateWords(text: string, maxWords: number): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')} ...`;
}

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
  /** Repository for Slack launch context and pending submit confirmations. */
  slackSessionRepo?: SlackSessionRepository;
  /** Durable message-bound Slack YAML review records. */
  slackPlanDraftRepo?: SlackPlanDraftRepository;
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
  /** How many extra planner attempts to make when the CLI exits 0 with empty stdout. Default: 2 (3 total attempts). */
  plannerRetryLimit?: number;
  /** Base delay in milliseconds between empty-output retry attempts (doubles per retry). Default: 500. */
  plannerRetryBaseDelayMs?: number;
  /** Opt in to scoping-first conversational planning before YAML drafting. Default: false. */
  conversationalPlanning?: boolean;

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
  /** Default Slack plan review mode. Default: 'require'. */
  defaultPlanningConfirmationMode?: PlanningConfirmationMode;
  /** Persisted workflow↔channel mapping for routing + channel creation. */
  workflowChannelRepo?: WorkflowChannelRepository;
  /** Gathers a workflow's planning convo + task transcripts for the in-channel assistant. */
  gatherWorkflowContext?: (workflowId: string) => Promise<WorkflowContext>;
  /** Executes a workflow operation (recreate/rebase/retry/status/cancel) and returns a summary. Injected by main.ts. */
  runWorkflowOp?: (op: WorkflowOp, onProgress?: (p: WorkflowOpProgress) => void) => Promise<WorkflowOpResult>;
  /** Relaunches Invoker (host-owned). Enables the `restart` lobby verb. */
  onRestartInvoker?: () => Promise<void>;
  /** Identifies the owning Slack manager process in request and reply logs. */
  instanceId?: string;
  /** Resolves a per-turn harness session driver for a preset (append-based continuity instead of prompt replay), when feasible. */
  harnessSessionDriverFactory?: (preset: HarnessPreset) => HarnessSessionDriver | undefined;
}

export interface HarnessPreset {
  tool: string;
  model?: string;
}

export interface StageSlackPlanDraftInput {
  channelId: string;
  threadTs: string;
  planText: string;
  repoUrl: string;
  harnessPreset: string;
  workingDir: string;
  requestedBy: string;
}

export interface StageSlackPlanDraftResult {
  draftId: string;
  version: number;
  messageTs?: string;
  slackFileId?: string;
  status: SlackPlanDraft['status'];
  summary: PlanSummary;
}

export const BUILTIN_HARNESS_PRESETS: Record<string, HarnessPreset> = {
  'cursor+claude': { tool: 'cursor', model: 'claude' },
  'cursor+codex': { tool: 'cursor', model: 'codex' },
  'omp+claude': { tool: 'omp', model: 'claude' },
  'omp+codex': { tool: 'omp', model: 'codex' },
  omp: { tool: 'omp' },
  codex: { tool: 'codex' },
  claude: { tool: 'claude' },
};

export const DEFAULT_HARNESS_PRESET = 'cursor+claude';

interface PlanningContext {
  repoUrl?: string;
  presetKey: string;
  workingDir?: string;
  requestedBy?: string;
  lobbyChannel?: string;
  confirmationMode: PlanningConfirmationMode;
  harnessSessionId?: string;
}

export type LocalRequest =
  | { kind: 'command'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'change'; text: string };

/**
 * Upper bound on stdout/stderr retained per stream while a local command runs.
 * Bounds process memory against noisy commands; only the tail is kept because
 * `formatLocalCommandResult` shows the last chars anyway.
 */
const MAX_LOCAL_CAPTURE_CHARS = 65_536;

// Internal marker for the "success with empty stdout" case so the runOneShotPlanner
// retry wrapper can distinguish transient silent-success from user-actionable
// failures (non-zero exit, spawn error, timeout) that must not be retried.
class EmptyOutputAttemptError extends Error {
  constructor(public readonly stderrTail: string) {
    super('planner exited 0 with no output');
    this.name = 'EmptyOutputAttemptError';
  }
}

function isEmptyOutputAttemptError(err: unknown): err is EmptyOutputAttemptError {
  return err instanceof EmptyOutputAttemptError;
}

/** Keep only the last `max` chars of a growing buffer. */
function capTailChars(value: string, max: number): string {
  return value.length > max ? value.slice(-max) : value;
}

// ── Planning request parsing ─────────────────────────────────

const PRESET_TOOL_HINTS = ['cursor', 'omp', 'codex', 'claude'];
const MESSAGE_REPO_TOKEN_RE = /<((?:https?|ssh):\/\/[^|>\s]+|git@[\w.-]+:[^|>\s]+)(?:\|[^>]+)?>|\b(?:https?:\/\/[^\s<>()\[\]{}"'|]+|ssh:\/\/[^\s<>()\[\]{}"'|]+|git@[\w.-]+:[^\s<>()\[\]{}"'|]+)/gi;
const TRAILING_URL_PUNCTUATION = new Set(['.', ',', ';', ':', '!']);
const GITHUB_REPO_ROOT_PATH_RE = /^\/[^/]+\/[^/]+(?:\.git)?\/?$/;
const INVALID_LITERAL_REPO_URL_GUIDANCE = 'Use a GitHub repo URL or a clone URL ending in .git.';

/** A leading bracket tag is a likely preset attempt when it names a known tool or uses the tool+model form. */
function looksLikePreset(normalized: string): boolean {
  return normalized.includes('+') || PRESET_TOOL_HINTS.some((hint) => normalized.includes(hint));
}

export function extractRepoUrlFromMessage(text: string): string | undefined {
  return extractMessageRepoCandidates(text)[0];
}

type RepoParts = {
  host: string;
  path: string;
};

function stripGitSuffix(path: string): string {
  return path.replace(/\/+$/g, '').replace(/\.git$/i, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRepoParts(repoUrl: string): RepoParts | undefined {
  const trimmed = repoUrl.trim().replace(/\/+$/g, '');
  const scpLike = /^git@([^:]+):(.+)$/.exec(trimmed);
  if (scpLike) return { host: scpLike[1], path: stripGitSuffix(scpLike[2]) };

  const sshUrl = /^ssh:\/\/git@([^/]+)\/(.+)$/i.exec(trimmed);
  if (sshUrl) return { host: sshUrl[1], path: stripGitSuffix(sshUrl[2]) };

  try {
    const parsed = new URL(trimmed);
    if (!parsed.host || !['http:', 'https:', 'ssh:'].includes(parsed.protocol)) return undefined;
    const path = parsed.pathname.replace(/^\/+/, '');
    if (!path) return undefined;
    return { host: parsed.host, path: stripGitSuffix(path) };
  } catch {
    return undefined;
  }
}

function sameRepoUrl(a: string, b: string): boolean {
  return repositoryIdentity(a) === repositoryIdentity(b);
}

function repoDisplayName(repoUrl: string): string {
  const parts = parseRepoParts(repoUrl);
  if (!parts) return repoUrl;
  const segments = parts.path.split('/').filter(Boolean);
  return segments.length >= 2 ? segments.slice(-2).join('/') : parts.path;
}

/** Peel leading `[preset]` and `[repo:]` tags off a lobby mention; the rest is the request text. A preset-shaped tag matching no key is returned as `unknownPreset` so the caller can reject it instead of silently using the default. */
export function parsePlanningRequest(
  text: string,
  presetKeys: string[],
  defaultPresetKey: string,
): {
  presetKey: string;
  repo?: string;
  repositoryUrls?: string[];
  hasExplicitPreset?: boolean;
  confirmationMode?: PlanningConfirmationMode;
  text: string;
  unknownPreset?: string;
} {
  let rest = text.replace(/<@[^>]+>/g, '').trim();
  let presetKey = defaultPresetKey;
  let repo: string | undefined;
  let confirmationMode: PlanningConfirmationMode | undefined;
  let unknownPreset: string | undefined;
  let hasExplicitPreset = false;
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
    if (normalized === 'auto-submit' || normalized === 'autosubmit') {
      confirmationMode = 'auto_submit';
      rest = rest.slice(m[0].length);
      continue;
    }
    if (keyset.has(normalized)) {
      presetKey = normalized;
      hasExplicitPreset = true;
      rest = rest.slice(m[0].length);
      continue;
    }
    if (looksLikePreset(normalized)) {
      unknownPreset = raw;
      rest = rest.slice(m[0].length);
    }
    break;
  }

  const repositoryUrls = extractRepositoryUrls(rest);
  return {
    presetKey,
    repo,
    text: rest.trim(),
    ...(repositoryUrls.length > 0 ? { repositoryUrls } : {}),
    ...(hasExplicitPreset ? { hasExplicitPreset } : {}),
    ...(confirmationMode ? { confirmationMode } : {}),
    ...(unknownPreset ? { unknownPreset } : {}),
  };
}

function extractRepositoryUrls(text: string): string[] {
  return extractMessageRepoCandidates(text);
}

function extractMessageRepoCandidates(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MESSAGE_REPO_TOKEN_RE)) {
    let candidate = (match[1] ?? match[0]).trim();
    while (candidate && TRAILING_URL_PUNCTUATION.has(candidate.at(-1)!)) {
      candidate = candidate.slice(0, -1);
    }

    const accepted = normalizeSupportedRepoCandidate(candidate);

    if (accepted && !seen.has(accepted)) {
      seen.add(accepted);
      urls.push(accepted);
    }
  }
  return urls;
}

function normalizeSupportedRepoCandidate(candidate: string): string | undefined {
  if (/^git@[\w.-]+:.+/.test(candidate)) return candidate;
  if (/^ssh:\/\//i.test(candidate)) return candidate;
  if (!/^https?:\/\//i.test(candidate) || /[?#]/.test(candidate)) return undefined;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (!url.host || url.username || url.password || url.search || url.hash) return undefined;

  const host = url.host.toLowerCase();
  if (host === 'github.com') {
    return GITHUB_REPO_ROOT_PATH_RE.test(url.pathname)
      ? candidate.replace(/\/$/, '')
      : undefined;
  }
  return url.pathname.endsWith('.git') ? candidate : undefined;
}

function repositoryIdentity(repoUrl: string): string {
  const parts = parseRepoParts(repoUrl);
  if (!parts) return stripGitSuffix(repoUrl.trim()).toLowerCase();
  const host = parts.host.toLowerCase();
  const path = host === 'github.com' ? parts.path.toLowerCase() : parts.path;
  return `${host}/${path}`;
}

// ── Lobby intent routing ─────────────────────────────────────

export function parseWorkflowStatusQuery(text: string): { intent: 'command'; operation: 'status'; target: { all: true } } | null {
  const trimmed = text.trim();
  if (!/\bworkflows?\b/i.test(trimmed)) return null;
  if (!/\b(status|how many|count|running|active|in progress|progress)\b/i.test(trimmed)) return null;
  return { intent: 'command', operation: 'status', target: { all: true } };
}

/** Explicit local-mode prefixes. `run local:` means “use the local agent”; `exec local:` means raw shell. */
export function parseLocalRequest(text: string): LocalRequest | null {
  const trimmed = text.trim();
  const commandPatterns = [
    /^(?:exec|execute)\s+local(?:ly)?\s*:\s*/i,
    /^local\s+(?:command|cmd)\s*:\s*/i,
  ];
  for (const pattern of commandPatterns) {
    const match = pattern.exec(trimmed);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      return rest ? { kind: 'command', text: rest } : null;
    }
  }

  const agentPatterns = [
    /^run\s+local(?:ly)?\s*:\s*/i,
    /^local\s+run\s*:\s*/i,
  ];
  for (const pattern of agentPatterns) {
    const match = pattern.exec(trimmed);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      return rest ? { kind: 'agent', text: rest } : null;
    }
  }

  const changePatterns = [
    /^local\s*:\s*/i,
    /^local\s+(?:change|edit|patch)\s*:\s*/i,
    /^(?:change|edit|patch)\s+local(?:ly)?\s*:\s*/i,
    /^locally\s*:\s*/i,
  ];
  for (const pattern of changePatterns) {
    const match = pattern.exec(trimmed);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      return rest ? { kind: 'change', text: rest } : null;
    }
  }

  return null;
}

// ── ConversationLike ─────────────────────────────────────────

/** Shared interface between SessionHandle and PlanConversation for handler code. */
interface ConversationLike {
  sendMessage(message: string): Promise<string>;
  runPlanConversion(): Promise<string>;
  getDraftedPlan(): string | null;
  readonly history: readonly { role: 'user' | 'assistant'; content: string }[];
  readonly lastTurnDraftPlanText: string | null;
  readonly lastTurnPlanIntentSignal: PlanIntentSignal | null;
  readonly conversationMode: ConversationMode;
  readonly planSubmitted: boolean;
  readonly submittedPlanText: string | null;  readonly workingDir?: string;
}

/** An action staged for a thread, awaiting a yes/no (text or button) confirmation. */
type PendingConfirm =
  | { kind: 'op'; op: WorkflowOp }
  | { kind: 'plan_intent'; requestText: string; userId: string; context: PlanningContext; channel: string; alreadySent?: boolean }
  | { kind: 'restart' };

interface SayResult {
  ts?: string;
}

type SayFn = (msg: { text: string; thread_ts: string; blocks?: unknown[] }) => Promise<SayResult>;

type ConversationSessionOptions = {
  tool?: string;
  model?: string;
  workingDir?: string;
  mode?: ConversationMode;
  repoUrl?: string;
  harnessSessionDriver?: HarnessSessionDriver;
  harnessSessionId?: string;
};

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
  /** Maps workflowId → Slack message ts for the live progress status card. */
  private progressCardTs = new Map<string, string>();
  /** Maps thread_ts → PlanConversation for ongoing plan threads. */
  private planConversations = new Map<string, PlanConversation>();
  private cursorCommand: string;
  private workingDir?: string;
  private defaultBranch?: string;
  private repoUrl?: string;
  private conversationRepo?: ConversationRepository;
  private slackSessionRepo?: SlackSessionRepository;
  private slackPlanDraftRepo?: SlackPlanDraftRepository;
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
  private plannerRetryLimit: number;
  private plannerRetryBaseDelayMs: number;
  private conversationalPlanning: boolean;
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
  /** Maps thread_ts → an action awaiting yes/no (or button) confirmation. */
  private pendingConfirms = new Map<string, PendingConfirm>();
  private defaultPlanningConfirmationMode: PlanningConfirmationMode;

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
  private runWorkflowOp?: (op: WorkflowOp, onProgress?: (p: WorkflowOpProgress) => void) => Promise<WorkflowOpResult>;
  private onRestartInvoker?: () => Promise<void>;
  private instanceId: string;
  private harnessSessionDriverFactory?: (preset: HarnessPreset) => HarnessSessionDriver | undefined;

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
    this.slackSessionRepo = config.slackSessionRepo;
    this.slackPlanDraftRepo = config.slackPlanDraftRepo;
    this.adminUserIds = new Set(config.adminUserIds ?? []);
    this.enableImmediateAck = config.enableImmediateAck ?? true;
    this.immediateAckMessage = config.immediateAckMessage ?? 'Processing your request...';
    this.immediateAckEmoji = config.immediateAckEmoji ?? 'thinking_face';
    this.useTypingIndicator = config.useTypingIndicator ?? false;
    this.planningTimeoutSeconds = config.planningTimeoutSeconds;
    this.planningHeartbeatIntervalSeconds = config.planningHeartbeatIntervalSeconds;
    this.plannerRetryLimit = Math.max(0, config.plannerRetryLimit ?? DEFAULT_PLANNER_RETRY_LIMIT);
    this.plannerRetryBaseDelayMs = Math.max(0, config.plannerRetryBaseDelayMs ?? DEFAULT_PLANNER_RETRY_BASE_DELAY_MS);
    this.conversationalPlanning = config.conversationalPlanning ?? false;
    this.lobbyChannelId = config.lobbyChannelId ?? config.channelId;
    this.planningCommandBuilder = config.planningCommandBuilder;
    this.prepareRepoCheckout = config.prepareRepoCheckout;
    this.harnessPresets = { ...BUILTIN_HARNESS_PRESETS, ...(config.harnessPresets ?? {}) };
    this.defaultHarnessPreset = config.defaultHarnessPreset ?? DEFAULT_HARNESS_PRESET;
    this.repoAliases = config.repoAliases ?? {};
    this.defaultRepoUrl = config.defaultRepoUrl ?? config.repoUrl;
    this.defaultPlanningConfirmationMode = config.defaultPlanningConfirmationMode ?? 'require';
    this.workflowChannelRepo = config.workflowChannelRepo;
    this.gatherWorkflowContext = config.gatherWorkflowContext;
    this.runWorkflowOp = config.runWorkflowOp;
    this.onRestartInvoker = config.onRestartInvoker;
    this.instanceId = config.instanceId ?? 'local';
    this.harnessSessionDriverFactory = config.harnessSessionDriverFactory;
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
        plannerRetryLimit: this.plannerRetryLimit,
        plannerRetryBaseDelayMs: this.plannerRetryBaseDelayMs,
        conversationalPlanning: this.conversationalPlanning,
        onHarnessSessionId: (id, sessionId) => this.persistHarnessSessionId(id.threadTs, sessionId),
      });
    }
  }

  async start(onCommand: CommandHandler): Promise<void> {
    this.onCommand = onCommand;
    this.registerSlashCommand();
    this.registerActions();
    this.registerMentionHandler();
    this.registerMessageHandler();
    this.restoreProgressCardTimestamps();
    await this.app.start();

    const persistenceEnabled = !!this.conversationRepo;
    this.log('slack', 'info', `Slack bot started (Socket Mode, persistence=${persistenceEnabled ? 'on' : 'off'}, sessionManager=${!!this.sessionManager})`);

    // Start SessionManager eviction loop
    this.sessionManager?.start();

    await this.postConnectInit();
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

    if (event.type === 'workflow_progress') {
      const message = formatSurfaceEvent(event);
      if (!message) return;
      const workflowId = event.progress.workflowId;
      const channel = this.resolveChannelForWorkflow(workflowId);
      if (!channel) {
        this.log('slack', 'warn', `[WORKFLOW_PROGRESS] Suppressed unmapped workflow update (workflowId=${workflowId})`);
        return;
      }
      const existingTs = this.progressCardTs.get(workflowId);
      if (existingTs) {
        const updated = await this.updateMessage(channel, existingTs, message);
        if (!updated) {
          this.log('slack', 'warn', `[WORKFLOW_PROGRESS] Failed to update progress card, posting replacement (workflowId=${workflowId}, ts=${existingTs})`);
          const replacementTs = await this.postMessage(message, channel);
          if (replacementTs) this.saveProgressCardTimestamp(workflowId, replacementTs);
        }
      } else {
        const ts = await this.postMessage(message, channel);
        if (ts) this.saveProgressCardTimestamp(workflowId, ts);
      }
      return;
    }

    const message = formatSurfaceEvent(event);
    if (!message) return;

    const channel = this.resolveChannelForWorkflow(this.deriveWorkflowId(event));
    if (!channel) {
      this.log('slack', 'warn', `[WORKFLOW_EVENT] Suppressed unmapped workflow update (type=${event.type})`);
      return;
    }

    // For task deltas, try to update existing message or post new one
    if (event.type === 'task_delta') {
      const delta = event.delta;
      const taskId = delta.type === 'created' ? delta.task.id : delta.taskId;

      const existingTs = this.taskMessages.get(taskId);
      if (existingTs && delta.type === 'updated') {
        const updated = await this.updateMessage(channel, existingTs, message);
        if (!updated) {
          this.log('slack', 'warn', `[TASK_DELTA] Failed to update task card, posting replacement (taskId=${taskId}, ts=${existingTs})`);
          const replacementTs = await this.postMessage(message, channel);
          if (replacementTs) {
            this.taskMessages.set(taskId, replacementTs);
          }
        }
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

  private resolveChannelForWorkflow(workflowId: string | undefined): string | undefined {
    if (!workflowId) return undefined;
    return this.workflowChannelRepo?.getByWorkflowId(workflowId)?.channelId ?? undefined;
  }

  private restoreProgressCardTimestamps(): void {
    for (const mapping of this.workflowChannelRepo?.list() ?? []) {
      if (mapping.progressCardTs) {
        this.progressCardTs.set(mapping.workflowId, mapping.progressCardTs);
      }
    }
  }

  private saveProgressCardTimestamp(workflowId: string, progressCardTs: string): void {
    this.progressCardTs.set(workflowId, progressCardTs);
    const mapping = this.workflowChannelRepo?.getByWorkflowId(workflowId);
    if (mapping) {
      this.workflowChannelRepo?.save({ ...mapping, progressCardTs });
    }
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
    this.progressCardTs.clear();
    await this.app.stop();
    this.log('slack', 'info', 'Slack bot stopped');
  }

  // ── Slash Command ───────────────────────────────────────

  private registerSlashCommand(): void {
    this.app.command('/invoker', async ({ command, ack, respond }) => {
      await ack();
      this.log('slack', 'info', `Slash command: /invoker ${command.text} (user=${command.user_name})`);

      // Deterministic verb commands (ops + submit) take priority over admin conversation commands.
      const ctrl = parseLobbyControl(command.text);
      if (ctrl) {
        await this.handleSlashControl(ctrl, command, respond);
        return;
      }

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

    this.app.action('plan_draft_approve', async ({ action, body, ack, respond }) => {
      await ack();
      if (action.type !== 'button' || !action.value) return;
      await this.approveSlackPlanDraft(action.value, body, respond);
    });
    this.app.action('plan_draft_discard', async ({ action, body, ack, respond }) => {
      await ack();
      if (action.type !== 'button' || !action.value) return;
      await this.discardSlackPlanDraft(action.value, body, respond);
    });

    this.app.action('plan_draft_cancel', async ({ action, body, ack, respond }) => {
      await ack();
      if (action.type !== 'button' || !action.value) return;
      await this.cancelSlackPlanDraft(action.value, body, respond);
    });

    this.app.action('lobby_confirm', async ({ action, body, ack, respond }) => {
      await ack();
      if (action.type !== 'button' || !action.value) return;
      const key = action.value;
      const pending = this.getPendingConfirm(key);
      if (!pending) {
        await respond?.({ text: 'This confirmation has expired.', replace_original: true });
        return;
      }
      this.pendingConfirms.delete(key);
      this.slackSessionRepo?.deletePendingConfirmation(key);
      this.log('slack', 'info', `Button: lobby_confirm key=${key} kind=${pending.kind}`);
      // Acknowledge instantly by replacing the buttons. The op itself can take
      // minutes (e.g. rebase-recreate all), and silence here reads as "nothing happened".
      await respond?.({ text: '✅ Approved.', replace_original: true });
      // Follow-ups post in-thread via the bot client: a response_url expires after
      // 30 minutes / 5 uses, which a long bulk op can outlast.
      const opChannel = (body as { channel?: { id?: string } })?.channel?.id;
      await this.executeConfirm(pending, key, this.lobbyButtonSay(body, respond), opChannel);
    });

    this.app.action('lobby_cancel', async ({ action, ack, respond }) => {
      await ack();
      if (action.type !== 'button' || !action.value) return;
      const pending = this.getPendingConfirm(action.value);
      if (!pending) return;
      this.pendingConfirms.delete(action.value);
      this.slackSessionRepo?.deletePendingConfirmation(action.value);
      this.log('slack', 'info', `Button: lobby_cancel key=${action.value}`);
      await respond?.({ text: '❌ Cancelled.', replace_original: true });
    });

    this.app.action('lobby_plan_for_execution', async ({ action, body, ack, respond }) => {
      await ack();
      if (action.type !== 'button' || !action.value) return;
      const pending = this.getPendingConfirm(action.value);
      if (!pending || pending.kind !== 'plan_intent') {
        await respond?.({ text: 'This planning choice has expired.', replace_original: true });
        return;
      }
      this.pendingConfirms.delete(action.value);
      this.slackSessionRepo?.deletePendingConfirmation(action.value);
      this.log('slack', 'info', `[PLAN_INTENT_CONFIRM] accepted key=${action.value}`);
      await respond?.({ text: '✅ Planning for execution.', replace_original: true });
      const say = this.lobbyButtonSay(body, respond);
      try {
        await this.startPlanIntent(pending, say, action.value);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log('slack', 'error', `[PLAN_INTENT_CONFIRM] drafting failed key=${action.value}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        this.pendingConfirms.set(action.value, pending);
        this.slackSessionRepo?.createPendingConfirmation({
          confirmKey: action.value,
          threadTs: action.value,
          channelId: pending.channel,
          userId: pending.userId,
          kind: pending.kind,
          payload: pending,
        });
        await this.sayWithRateLimitRetry(say, {
          text: `Planning failed: ${message}. Click Approve above to try again.`,
          thread_ts: action.value,
          blocks: this.buildPlanIntentBlocks(action.value) as never,
        });
      }
    });

    this.app.action('lobby_continue_conversation', async ({ action, body, ack, respond }) => {
      await ack();
      if (action.type !== 'button' || !action.value) return;
      const pending = this.getPendingConfirm(action.value);
      if (!pending || pending.kind !== 'plan_intent') {
        await respond?.({ text: 'This planning choice has expired.', replace_original: true });
        return;
      }
      this.pendingConfirms.delete(action.value);
      this.slackSessionRepo?.deletePendingConfirmation(action.value);
      this.log('slack', 'info', `[PLAN_INTENT_CONFIRM] declined key=${action.value}`);
      await respond?.({ text: '✅ Continuing the conversation without planning.', replace_original: true });
      await this.startConversationIntent(pending, this.lobbyButtonSay(body, respond), action.value);
    });
  }

  // ── @mention Handler (Plan Conversations) ──────────────

  private registerMentionHandler(): void {
    this.app.event('app_mention', async ({ event, say }) => {
      const channel: string | undefined = event.channel;
      const threadTs = event.thread_ts ?? event.ts;
      this.log('slack', 'info', `[MENTION_RECEIVED] instance=${this.instanceId} event_ts=${event.ts} thread_ts=${threadTs} channel=${channel ?? 'unknown'} user=${event.user ?? 'unknown'}`);

      const mapping = channel ? this.workflowChannelRepo?.getByChannelId(channel) : null;
      await this.handleMention(event, say, channel ?? this.lobbyChannelId, mapping ?? undefined);
    });
  }

  private async handleMention(
    event: SlackMentionEvent,
    say: SayFn,
    channel: string,
    mapping?: WorkflowChannel,
  ): Promise<void> {
    if (mapping) {
      this.log('slack', 'info', `[MENTION_ROUTE] instance=${this.instanceId} event_ts=${event.ts} route=workflow workflow=${mapping.workflowId}`);
      await this.handleWorkflowAssistantMention(mapping, event, say);
      return;
    }

    this.log('slack', 'info', `[MENTION_ROUTE] instance=${this.instanceId} event_ts=${event.ts} route=planning`);
    await this.handlePlanningMention(event, say, channel);
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
    this.log('slack', 'info', `@mention: instance=${this.instanceId} event_ts=${event.ts} "${parsed.text.slice(0, 100)}${parsed.text.length > 100 ? '...' : ''}" (user=${event.user}, preset=${parsed.presetKey}, repo=${parsed.repo ?? 'default'})`);
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
    const threadTs = event.thread_ts ?? event.ts;
    if (/^\/plan\s*$/i.test(parsed.text)) {
      await this.handleExplicitPlanAction(channel, threadTs, event.user ?? 'unknown', say);
      return;
    }

    const preset = this.resolveHarnessPreset(parsed.presetKey);
    const explicitRepoResolution = parsed.repo ? this.resolveRepoUrl(parsed.repo) : {};
    if (explicitRepoResolution.error) {
      await say({ text: explicitRepoResolution.error, thread_ts: event.ts });
      return;
    }
    const repositoryUrls = parsed.repositoryUrls ?? [];
    if (repositoryUrls.length > 1) {
      await say({ text: 'I found multiple repository URLs. Use one repository URL or one `[repo:…]` selector per request.', thread_ts: event.ts });
      return;
    }
    const detectedRepoResolution = repositoryUrls.length === 1
      ? this.resolveRepoUrl(repositoryUrls[0])
      : {};
    if (detectedRepoResolution.error) {
      await say({ text: detectedRepoResolution.error, thread_ts: event.ts });
      return;
    }
    const mentionedRepoAlias = !parsed.repo && repositoryUrls.length === 0
      ? this.findMentionedRepoAlias(parsed.text)
      : undefined;
    const mentionedRepoResolution = mentionedRepoAlias ? this.resolveRepoUrl(mentionedRepoAlias) : {};
    const routeRepoUrl = explicitRepoResolution.url
      ?? detectedRepoResolution.url
      ?? mentionedRepoResolution.url
      ?? this.resolveRepoUrl().url;

    if (/^\/plan\s+.+/i.test(parsed.text)) {
      const context: PlanningContext = {
        repoUrl: routeRepoUrl,
        presetKey: parsed.presetKey,
        workingDir: this.workingDir,
        requestedBy: event.user,
        lobbyChannel: channel,
        confirmationMode: parsed.confirmationMode ?? this.defaultPlanningConfirmationMode,
      };
      await this.stagePlanIntentConfirm(threadTs, channel, {
        kind: 'plan_intent',
        requestText: parsed.text.replace(/^\/plan\s+/i, ''),
        userId: event.user ?? 'unknown',
        context,
        channel,
      }, say);
      return;
    }

    // Confirm/cancel a staged action first (plain yes/no in-thread).
    if (await this.resolveConfirm(threadTs, parsed.text, say, channel)) return;

    // Deterministic verb commands respond instantly and take priority over agent sessions.
    const ctrl = parseLobbyControl(parsed.text);
    if (ctrl?.kind === 'op' || ctrl?.kind === 'restart') {
      if (!this.allowsLobbyControls(channel)) {
        await this.rejectNonLobbyControl(threadTs, say);
        return;
      }
      if (ctrl.kind === 'op') {
        await this.handleLobbyOp(ctrl, threadTs, channel, say);
        return;
      }
      await this.handleLobbyRestart(threadTs, channel, say);
      return;
    }

    const localRequest = parseLocalRequest(parsed.text);
    if (localRequest?.kind === 'command') {
      if (!this.allowsLobbyControls(channel)) {
        await this.rejectNonLobbyControl(threadTs, say);
        return;
      }
      await this.handleLocalRequest(localRequest, preset, threadTs, say, channel, { userId: event.user, repoUrl: routeRepoUrl });
      return;
    }

    const workflowStatusQuery = parseWorkflowStatusQuery(localRequest?.kind === 'agent' ? localRequest.text : parsed.text);
    if (workflowStatusQuery?.intent === 'command') {
      if (!this.allowsLobbyControls(channel)) {
        await this.rejectNonLobbyControl(threadTs, say);
        return;
      }
      await this.handleLobbyOp({ kind: 'op', operation: workflowStatusQuery.operation, target: workflowStatusQuery.target }, threadTs, channel, say);
      return;
    }

    const requestText = localRequest?.kind === 'agent' || localRequest?.kind === 'change' ? localRequest.text : parsed.text;

    if (this.enableImmediateAck) {
      await this.sendImmediateAck(threadTs, say);
    }

    try {
      const storedContext = this.loadPlanningContext(threadTs);
      if (storedContext) {
        if ((parsed.repo || repositoryUrls.length > 0) && routeRepoUrl && storedContext.repoUrl && repositoryIdentity(routeRepoUrl) !== repositoryIdentity(storedContext.repoUrl)) {
          await say({ text: 'This thread is already pinned to a different repository. Start a new thread to use another repository.', thread_ts: threadTs });
          return;
        }
        if (parsed.hasExplicitPreset && parsed.presetKey !== storedContext.presetKey) {
          await say({ text: 'This thread is already pinned to a different planner preset. Start a new thread to use another preset.', thread_ts: threadTs });
          return;
        }
      }
      const effectiveConfirmationMode = parsed.confirmationMode
        ?? storedContext?.confirmationMode
        ?? this.defaultPlanningConfirmationMode;
      const context = storedContext
        ? { ...storedContext, confirmationMode: effectiveConfirmationMode }
        : {
            repoUrl: routeRepoUrl,
            presetKey: parsed.presetKey,
            workingDir: this.workingDir,
            requestedBy: event.user,
            lobbyChannel: channel,
            confirmationMode: effectiveConfirmationMode,
          };
      const contextPreset = this.resolveHarnessPreset(context.presetKey);
      let workingDir = context.workingDir ?? this.workingDir;
      const prepareRepoCheckout = this.prepareRepoCheckout;
      if (this.shouldPrepareRepoCheckout(context.repoUrl) && prepareRepoCheckout) {
        try {
          workingDir = await prepareRepoCheckout(context.repoUrl);
        } catch (err) {
          this.log('slack', 'error', `Failed to prepare repo checkout for ${context.repoUrl}: ${err}`);
          await say({ text: `Failed to check out repo: ${err instanceof Error ? err.message : String(err)}`, thread_ts: threadTs });
          return;
        }
      }

      const explicitLocalAgent = localRequest?.kind === 'agent' || localRequest?.kind === 'change';
      const opts = {
        tool: contextPreset.tool,
        model: contextPreset.model,
        workingDir,
        mode: (explicitLocalAgent || !this.conversationalPlanning ? 'agent' : 'plan') as ConversationMode,
        repoUrl: context.repoUrl,
        ...this.harnessDriverSessionOpts(contextPreset, context),
      };
      const conversation = await this.getSession(channel, threadTs, event.user ?? 'unknown', true, opts);
      if (!conversation) {
        await say({ text: 'Too many active conversations. Please wait.', thread_ts: threadTs });
        return;
      }

      this.persistLaunchContext(threadTs, { ...context, workingDir });

      await this.handleConversationMessage(conversation, requestText, threadTs, say, channel, event.ts,
        { userId: event.user ?? 'unknown', context });
    } finally {
      // Drop any leftover Processing… ack (success paths already replace/delete it).
      await this.clearImmediateAck(channel, threadTs);
    }
  }

  private async handleExplicitPlanAction(
    channel: string,
    threadTs: string,
    userId: string,
    say: SayFn,
  ): Promise<void> {
    if (!this.slackPlanDraftRepo) {
      await say({ text: 'Slack plan reviews are not configured in this deployment.', thread_ts: threadTs });
      return;
    }
    const conversation = await this.getSession(channel, threadTs, userId, false);
    if (!conversation) {
      await say({ text: 'Start a conversation in this thread before asking me to create a plan.', thread_ts: threadTs });
      return;
    }
    const plannerOutput = await conversation.runPlanConversion();
    await this.stageDraftReviewFromPlannerOutput(plannerOutput, conversation, channel, threadTs, userId, say, { silentWhenNotReady: false });
  }

  private async stageDraftReviewFromPlannerOutput(
    plannerOutput: string,
    conversation: ConversationLike,
    channel: string,
    threadTs: string,
    userId: string,
    say: SayFn,
    opts: { silentWhenNotReady: boolean },
  ): Promise<void> {
    if (!this.slackPlanDraftRepo) return;
    const review = preparePlanningReview({
      plannerOutput,
      extractDraftPlanText: () => conversation.lastTurnDraftPlanText,
      confirmationMode: this.loadPlanningContext(threadTs)?.confirmationMode ?? this.defaultPlanningConfirmationMode,
    });
    if ('kind' in review) {
      if (!opts.silentWhenNotReady) {
        await this.sayWithRateLimitRetry(say, { text: review.reply, thread_ts: threadTs });
      }
      return;
    }
    const draftReview = review;
    const context = this.loadPlanningContext(threadTs);
    if (!context?.repoUrl || !context.workingDir) {
      if (opts.silentWhenNotReady) {
        this.log('slack', 'warn', `[DRAFT_STAGE] Skipped staging draft for thread ${threadTs}: no pinned repository context.`);
        return;
      }
      await this.sayWithRateLimitRetry(say, {
        text: 'This thread has no pinned repository context. Start a new thread with the repository selected.',
        thread_ts: threadTs,
      });
      return;
    }
    const draft = this.slackPlanDraftRepo.create({
      channelId: channel,
      threadTs,
      planText: draftReview.planText,
      summaryJson: JSON.stringify(draftReview.summary),
      repoUrl: context.repoUrl,
      harnessPreset: context.presetKey,
      workingDir: context.workingDir,
      requestedBy: context.requestedBy ?? userId,
      confirmationMode: draftReview.confirmationMode,
    });
    try {
      await this.postSlackPlanDraft(draft, draftReview.summary, say);
    } catch (error) {
      // The draft row already exists at this point and postSlackPlanDraft has
      // already surfaced the failure by updating the Slack message in place,
      // so this must not propagate: letting it reach the button handler's
      // catch would restore the pending confirmation and offer "click
      // Approve to retry", which re-runs this whole method and creates a
      // second, orphaned draft instead of reconciling the one that exists.
      this.log('slack', 'error', `Posting plan draft ${draft.draftId}:${draft.version} failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (draftReview.confirmationMode === 'auto_submit') {
      try {
        await this.submitSlackPlanDraft(this.slackPlanDraftRepo.get(draft.draftId, draft.version) ?? draft, { userId });
      } catch (error) {
        this.log('slack', 'error', `Auto-submit failed for draft ${draft.draftId}:${draft.version}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async stageSlackPlanDraftForReview(input: StageSlackPlanDraftInput): Promise<StageSlackPlanDraftResult> {
    if (!this.slackPlanDraftRepo) {
      throw new Error('Slack plan reviews are not configured in this deployment.');
    }
    const summary = summarizePlanText(input.planText);
    if (!summary) {
      throw new Error('The supplied plan YAML could not be summarized for Slack review.');
    }
    const draft = this.slackPlanDraftRepo.create({
      channelId: input.channelId,
      threadTs: input.threadTs,
      planText: input.planText,
      summaryJson: JSON.stringify(summary),
      repoUrl: input.repoUrl,
      harnessPreset: input.harnessPreset,
      workingDir: input.workingDir,
      requestedBy: input.requestedBy,
      confirmationMode: 'require',
    });
    const say: SayFn = async ({ text, thread_ts, blocks }) => {
      const posted = await this.app.client.chat.postMessage({
        channel: input.channelId,
        text,
        thread_ts,
        ...(blocks ? { blocks: blocks as never } : {}),
      });
      return { ts: posted.ts as string | undefined };
    };
    await this.postSlackPlanDraft(draft, summary, say);
    const ready = this.slackPlanDraftRepo.get(draft.draftId, draft.version) ?? draft;
    return {
      draftId: ready.draftId,
      version: ready.version,
      messageTs: ready.messageTs,
      slackFileId: ready.slackFileId,
      status: ready.status,
      summary,
    };
  }

  /** Post the immediate "received it" acknowledgment and track it for in-place replacement. */
  private async sendImmediateAck(threadTs: string, say: SayFn): Promise<void> {
    try {
      const res = await say({ text: this.immediateAckMessage, thread_ts: threadTs });
      if (res?.ts) this.ackMessages.set(threadTs, res.ts);
      this.log('slack', 'info', `[ACK] Sent immediate acknowledgment (thread_ts=${threadTs})`);
    } catch (err) {
      this.log('slack', 'error', `[ACK] Failed to send immediate acknowledgment: ${err}`);
    }
  }

  /** Drop the immediate ack — used by paths that post their own reply instead of replacing it. */
  private async clearImmediateAck(channel: string, threadTs: string): Promise<void> {
    const ts = this.ackMessages.get(threadTs);
    if (!ts) return;
    this.ackMessages.delete(threadTs);
    await this.deleteMessage(channel, ts);
  }

  private async handleLobbyOp(
    ctrl: Extract<LobbyControl, { kind: 'op' }>,
    threadTs: string,
    channel: string,
    say: SayFn,
  ): Promise<void> {
    if (!this.runWorkflowOp) {
      await say({ text: 'Workflow operations are not available in this deployment.', thread_ts: threadTs });
      return;
    }
    const op: WorkflowOp = { operation: ctrl.operation, target: ctrl.target };
    // Destructive bulk mutations require explicit confirmation; status and single-workflow ops run now.
    if (ctrl.operation !== 'status' && 'all' in ctrl.target) {
      await this.stageConfirm(threadTs, channel, { kind: 'op', op }, `This will \`${ctrl.operation}\` ALL workflows.`, say);
      return;
    }
    await this.runConfirmedOp(op, threadTs, say, channel);
  }

  private async runConfirmedOp(op: WorkflowOp, threadTs: string, say: SayFn, channel?: string): Promise<void> {
    const onIt = await say({ text: `On it — ${this.describeOp(op)}. I'll post a summary here when it finishes.`, thread_ts: threadTs });
    const progressTs = onIt?.ts;
    let lastEdit = 0;
    const onProgress = channel && progressTs
      ? (p: WorkflowOpProgress): void => {
          if (p.total <= 1) return;
          const now = Date.now();
          if (now - lastEdit < 2000 && p.done < p.total) return;
          lastEdit = now;
          const icon = p.done >= p.total ? '✅' : '⏳';
          const tail = p.failed ? `, ${p.failed} failed` : '';
          const cur = p.current && p.done < p.total ? ` · now \`${p.current}\`` : '';
          void this.app.client.chat
            .update({ channel, ts: progressTs, text: `${icon} ${this.describeOp(op)} — ${p.done}/${p.total} (${p.ok} ok${tail})${cur}` })
            .catch(() => {});
        }
      : undefined;
    try {
      const result = await this.runWorkflowOp!(op, onProgress);
      await say({ text: result.summary, thread_ts: threadTs });
    } catch (err) {
      await say({ text: `Operation failed: ${err instanceof Error ? err.message : String(err)}`, thread_ts: threadTs });
    }
  }

  /** Build a say() for a button action: posts in-thread via the bot client so
   *  follow-ups survive past the 30-minute response_url window; falls back to respond(). */
  private lobbyButtonSay(body: unknown, respond?: RespondFn): SayFn {
    const b = body as { channel?: { id?: string }; message?: { thread_ts?: string }; container?: { thread_ts?: string } };
    const channel = b?.channel?.id;
    const threadTs = b?.message?.thread_ts ?? b?.container?.thread_ts;
    return async ({ text, blocks }) => {
      if (channel) {
        const res = await this.app.client.chat.postMessage({
          channel,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          ...(blocks ? { blocks: blocks as never } : {}),
        });
        return { ts: res.ts as string };
      }
      await respond?.({ text, replace_original: false });
      return {};
    };
  }

  private async replaceConfirmationMessage(body: unknown, respond: RespondFn | undefined, text: string): Promise<void> {
    const message = body as { channel?: { id?: string }; message?: { ts?: string } };
    const channel = message.channel?.id;
    const ts = message.message?.ts;
    if (channel && ts) {
      await this.app.client.chat.update({ channel, ts, text, blocks: [] });
      return;
    }
    await respond?.({ text, replace_original: true });
  }

  private describeOp(op: WorkflowOp): string {
    const target = 'all' in op.target ? 'ALL workflows' : `\`${op.target.workflow}\``;
    return `${op.operation} ${target}`;
  }

  private renderPlanSummary(summary: PlanSummary): string {
    return formatSlackPlanBrief(summary);
  }

  private parseDraftAction(value: string): { draftId: string; version: number } | undefined {
    const [draftId, rawVersion] = value.split(':');
    const version = Number(rawVersion);
    return draftId && Number.isInteger(version) && version > 0 ? { draftId, version } : undefined;
  }

  private draftActionContext(body: unknown): { channel?: string; threadTs?: string; userId?: string } {
    const event = body as {
      channel?: { id?: string };
      message?: { thread_ts?: string; ts?: string };
      container?: { thread_ts?: string };
      user?: { id?: string };
    };
    return {
      channel: event.channel?.id,
      threadTs: event.message?.thread_ts ?? event.container?.thread_ts,
      userId: event.user?.id,
    };
  }

  private parseSlackDraftSummary(draft: SlackPlanDraft): PlanSummary {
    const parsed = JSON.parse(draft.summaryJson) as PlanSummary;
    return parsed;
  }

  private async replacePlanDraftMessage(draft: SlackPlanDraft, text: string, blocks: unknown[]): Promise<void> {
    if (!draft.messageTs) return;
    await this.app.client.chat.update({
      channel: draft.channelId,
      ts: draft.messageTs,
      text,
      blocks: blocks as never,
    });
  }

  private async submitSlackPlanDraft(
    draft: SlackPlanDraft,
    context: { userId?: string },
  ): Promise<void> {
    if (draft.status !== 'ready') {
      throw new Error(`This plan review is ${draft.status}.`);
    }
    if (!draft.messageTs || !draft.slackFileId
      || createHash('sha256').update(draft.planText).digest('hex') !== draft.contentHash) {
      throw new Error('This plan review failed its integrity check and cannot be approved.');
    }
    const executionKey = this.slackPlanDraftRepo?.claim(draft);
    if (!executionKey) {
      throw new Error('This plan is already being submitted.');
    }
    await this.replacePlanDraftMessage(draft, 'Starting plan execution…', []);
    try {
      const result = await this.onCommand?.({
        type: 'start_plan',
        planText: draft.planText,
        repoUrl: draft.repoUrl,
        harnessPreset: draft.harnessPreset,
        requestedBy: draft.requestedBy,
        lobbyChannel: draft.channelId,
        lobbyThreadTs: draft.threadTs,
        executionKey,
      });
      this.slackPlanDraftRepo?.markSubmitted(draft, result?.workflowIds ?? []);
    } catch (error) {
      this.slackPlanDraftRepo?.markFailed(draft, context.userId ?? 'unknown');
      await this.replacePlanDraftMessage(
        draft,
        `Plan execution failed: ${error instanceof Error ? error.message : String(error)}`,
        [],
      );
      throw error;
    }
  }

  private async approveSlackPlanDraft(value: string, body: unknown, respond?: RespondFn): Promise<void> {
    const key = this.parseDraftAction(value);
    const context = this.draftActionContext(body);
    const draft = key && this.slackPlanDraftRepo?.get(key.draftId, key.version);
    if (!draft || !context.channel || !context.threadTs
      || draft.channelId !== context.channel || draft.threadTs !== context.threadTs) {
      await respond?.({ text: 'This plan review is no longer available.', replace_original: true });
      return;
    }
    try {
      await this.submitSlackPlanDraft(draft, context);
    } catch (error) {
      await respond?.({ text: error instanceof Error ? error.message : String(error), replace_original: true });
    }
  }

  private async cancelSlackPlanDraft(value: string, body: unknown, respond?: RespondFn): Promise<void> {
    const key = this.parseDraftAction(value);
    const context = this.draftActionContext(body);
    const draft = key && this.slackPlanDraftRepo?.get(key.draftId, key.version);
    if (!draft || !context.channel || !context.threadTs
      || draft.channelId !== context.channel || draft.threadTs !== context.threadTs) {
      await respond?.({ text: 'This plan review is no longer available.', replace_original: true });
      return;
    }
    if (draft.status !== 'ready') {
      await respond?.({ text: `This plan review is ${draft.status}.`, replace_original: true });
      return;
    }
    const summary = this.parseSlackDraftSummary(draft);
    await this.replacePlanDraftMessage(
      draft,
      `${summary.name}\n${formatPlanSummaryLines(summary).join('\n')}\nPlan not submitted. Draft kept.`,
      this.planDraftBlocks(summary, draft, 'kept'),
    );
  }

  private async discardSlackPlanDraft(value: string, body: unknown, respond?: RespondFn): Promise<void> {
    const key = this.parseDraftAction(value);
    const context = this.draftActionContext(body);
    const draft = key && this.slackPlanDraftRepo?.get(key.draftId, key.version);
    if (!draft || !context.channel || !context.threadTs
      || draft.channelId !== context.channel || draft.threadTs !== context.threadTs) {
      await respond?.({ text: 'This plan review is no longer available.', replace_original: true });
      return;
    }
    if (draft.status !== 'ready') {
      await respond?.({ text: `This plan review is ${draft.status}.`, replace_original: true });
      return;
    }
    this.slackPlanDraftRepo?.decide(draft, 'rejected', context.userId ?? 'unknown');
    await this.replacePlanDraftMessage(draft, 'Plan draft discarded.', []);
  }

  private planDraftBlocks(
    summary: PlanSummary,
    draft: SlackPlanDraft,
    state: 'plain' | 'ready' | 'kept',
  ): unknown[] {
    const text = [`*${summary.name}*`, ...formatPlanSummaryLines(summary)].join('\n');
    const actionButtons = state === 'ready'
      ? [
          {
            type: 'button',
            action_id: 'plan_draft_approve',
            style: 'primary',
            text: { type: 'plain_text', text: 'Approve' },
            value: `${draft.draftId}:${draft.version}`,
          },
          {
            type: 'button',
            action_id: 'plan_draft_cancel',
            text: { type: 'plain_text', text: 'Cancel' },
            value: `${draft.draftId}:${draft.version}`,
          },
        ]
      : state === 'kept'
        ? [
            {
              type: 'button',
              action_id: 'plan_draft_approve',
              style: 'primary',
              text: { type: 'plain_text', text: 'Approve' },
              value: `${draft.draftId}:${draft.version}`,
            },
            {
              type: 'button',
              action_id: 'plan_draft_discard',
              text: { type: 'plain_text', text: 'Discard draft' },
              value: `${draft.draftId}:${draft.version}`,
            },
          ]
        : [];
    return [
      { type: 'section', text: { type: 'mrkdwn', text } },
      ...(actionButtons.length > 0 ? [{
        type: 'actions',
        elements: actionButtons,
      }] : []),
    ];
  }

  private async postSlackPlanDraft(
    draft: SlackPlanDraft,
    summary: PlanSummary,
    say: SayFn,
  ): Promise<void> {
    if (!this.slackPlanDraftRepo) return;
    const posted = await this.sayWithRateLimitRetry(say, {
      text: `${summary.name}\n${formatPlanSummaryLines(summary).join('\n')}\nPreparing YAML attachment…`,
      thread_ts: draft.threadTs,
      blocks: this.planDraftBlocks(summary, draft, 'plain'),
    });
    if (!posted?.ts) throw new Error('Slack did not return a timestamp for the plan review message.');
    this.slackPlanDraftRepo.bindMessage(draft, posted.ts);
    try {
      const upload = await this.app.client.files.uploadV2({
        channel_id: draft.channelId,
        thread_ts: draft.threadTs,
        file_uploads: [{
          file: Buffer.from(draft.planText, 'utf8'),
          filename: `${draft.draftId}.yaml`,
          title: `${summary.name}.yaml`,
        }],
      }) as unknown as { files?: Array<{ files?: Array<{ id?: string }> }> };
      const fileId = upload.files?.[0]?.files?.[0]?.id;
      if (!fileId) throw new Error('Slack did not return an uploaded YAML file id.');
      this.slackPlanDraftRepo.bindAttachment(draft, fileId);
      this.slackPlanDraftRepo.markReady(draft);
      await this.replacePlanDraftMessage(
        this.slackPlanDraftRepo.get(draft.draftId, draft.version) ?? draft,
        `${summary.name}\n${formatPlanSummaryLines(summary).join('\n')}`,
        this.planDraftBlocks(summary, draft, 'ready'),
      );
    } catch (error) {
      await this.app.client.chat.update({
        channel: draft.channelId,
        ts: posted.ts,
        text: `Plan review could not attach YAML: ${error instanceof Error ? error.message : String(error)}`,
        blocks: [],
      });
      throw error;
    }
  }

  private buildConfirmBlocks(prompt: string, confirmKey: string): unknown[] {
    return [
      { type: 'section', text: { type: 'mrkdwn', text: prompt } },
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'lobby_confirm', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: confirmKey },
          { type: 'button', action_id: 'lobby_cancel', text: { type: 'plain_text', text: 'Reject' }, value: confirmKey },
        ],
      },
    ];
  }

  private buildPlanIntentBlocks(confirmKey: string): unknown[] {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'It sounds like you may want an Invoker plan that can be executed. Which should I do?' },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'lobby_plan_for_execution', style: 'primary', text: { type: 'plain_text', text: 'Plan for execution' }, value: confirmKey },
          { type: 'button', action_id: 'lobby_continue_conversation', text: { type: 'plain_text', text: 'No planning, just continue conversation' }, value: confirmKey },
        ],
      },
    ];
  }

  private async stagePlanIntentConfirm(
    threadTs: string,
    channel: string,
    pending: Extract<PendingConfirm, { kind: 'plan_intent' }>,
    say: SayFn,
  ): Promise<void> {
    const existing = this.getPendingConfirm(threadTs);
    if (existing) {
      await say({
        text: 'There is already a pending confirmation in this thread. Resolve it before asking again.',
        thread_ts: threadTs,
      });
      return;
    }
    this.pendingConfirms.set(threadTs, pending);
    this.slackSessionRepo?.createPendingConfirmation({
      confirmKey: threadTs,
      threadTs,
      channelId: channel,
      userId: pending.userId,
      kind: pending.kind,
      payload: pending,
    });
    this.log('slack', 'info', `[PLAN_INTENT_CONFIRM] staged key=${threadTs} thread_ts=${threadTs}`);
    await say({
      text: 'Do you want a plan for execution, or should I continue the conversation without planning?',
      thread_ts: threadTs,
      blocks: this.buildPlanIntentBlocks(threadTs),
    });
  }

  private async startConversationIntent(
    pending: Extract<PendingConfirm, { kind: 'plan_intent' }>,
    say: SayFn,
    threadTs: string,
  ): Promise<void> {
    const context = pending.context;
    const conversation = await this.getSession(
      pending.channel,
      threadTs,
      pending.userId,
      true,
      this.sessionOptionsFromContext(context, 'agent'),
    );
    if (!conversation) {
      await say({ text: 'Too many active conversations. Please wait.', thread_ts: threadTs });
      return;
    }
    this.persistLaunchContext(threadTs, context);
    // Do NOT pass a planIntentContext here: this replays the original turn after
    // the user already clicked "Plan for execution" — re-detecting would loop.
    await this.handleConversationMessage(conversation, pending.requestText, threadTs, say, pending.channel);
  }

  private async startPlanIntent(
    pending: Extract<PendingConfirm, { kind: 'plan_intent' }>,
    say: SayFn,
    threadTs: string,
  ): Promise<void> {
    // alreadySent means the request text was already sent to the conversation
    // once, by the agent-mode turn that detected the plan-intent signal and
    // staged this confirm. Replaying it here would ask the model the same
    // thing twice and post a redundant reply.
    if (!pending.alreadySent) {
      await this.startConversationIntent(pending, say, threadTs);
    }
    await this.handleExplicitPlanAction(pending.channel, threadTs, pending.userId, say);
  }

  /** Stage an action and post the prompt with Approve/Cancel buttons (plain yes/no also works). */
  private async stageConfirm(
    threadTs: string,
    channel: string,
    pending: PendingConfirm,
    prompt: string,
    say: SayFn,
  ): Promise<void> {
    this.stagePendingConfirm(threadTs, channel, pending);
    await say({
      text: `${prompt}\n_Approve to proceed, or reply \`no\` to cancel._`,
      thread_ts: threadTs,
      blocks: this.buildConfirmBlocks(prompt, threadTs),
    });
  }

  private stagePendingConfirm(threadTs: string, channel: string, pending: PendingConfirm): void {
    this.pendingConfirms.set(threadTs, pending);
  }


  /** Lobby controls stay in the lobby channel or DMs; planning may run elsewhere. */
  private allowsLobbyControls(channel: string | undefined): boolean {
    if (!channel) return true;
    return channel === this.lobbyChannelId || channel.startsWith('D');
  }

  private async rejectNonLobbyControl(threadTs: string, say: SayFn): Promise<void> {
    await say({
      text: 'I can plan here, but restart/submit/workflow controls only work in the lobby channel or DMs.',
      thread_ts: threadTs,
    });
  }

  /** Resolve a staged action from a plain-text reply. Returns true if the reply was consumed. */
  private async resolveConfirm(threadTs: string, text: string, say: SayFn, channel?: string): Promise<boolean> {
    const pending = this.getPendingConfirm(threadTs);
    if (!pending) return false;
    if (!this.allowsLobbyControls(channel)) {
      await this.rejectNonLobbyControl(threadTs, say);
      return true;
    }
    if (isConfirmation(text)) {
      this.pendingConfirms.delete(threadTs);
      this.slackSessionRepo?.deletePendingConfirmation(threadTs);
      await this.executeConfirm(pending, threadTs, say, channel);
      return true;
    }
    if (isNegation(text)) {
      this.pendingConfirms.delete(threadTs);
      this.slackSessionRepo?.deletePendingConfirmation(threadTs);
      await say({ text: 'Cancelled.', thread_ts: threadTs });
      return true;
    }
    this.pendingConfirms.delete(threadTs);
    await say({
      text: 'Dropped the pending approval because the reply was not a confirmation.',
      thread_ts: threadTs,
    });
    return true;
  }

  /** Run a confirmed action — a workflow op or a restart. */
  private async executeConfirm(pending: PendingConfirm, threadTs: string, say: SayFn, channel?: string): Promise<void> {
    if (pending.kind === 'op') {
      if (!this.runWorkflowOp) {
        await say({ text: 'Workflow operations are not available in this deployment.', thread_ts: threadTs });
        return;
      }
      await this.runConfirmedOp(pending.op, threadTs, say, channel);
      return;
    }
    await this.runConfirmedRestart(threadTs, say);
  }

  /** Restart Invoker on request — always confirm first (it interrupts the running app). */
  private async handleLobbyRestart(threadTs: string, channel: string, say: SayFn): Promise<void> {
    if (!this.onRestartInvoker) {
      await say({ text: 'Restarting Invoker is not available in this deployment.', thread_ts: threadTs });
      return;
    }
    await this.stageConfirm(threadTs, channel, { kind: 'restart' }, 'This will restart Invoker.', say);
  }

  /** Run a confirmed restart: relaunch Invoker, then report health. */
  private async runConfirmedRestart(threadTs: string, say: SayFn): Promise<void> {
    if (!this.onRestartInvoker) {
      await say({ text: 'Restarting Invoker is not available in this deployment.', thread_ts: threadTs });
      return;
    }
    await say({ text: 'Bringing Invoker back… :hourglass_flowing_sand:', thread_ts: threadTs });
    try {
      await this.onRestartInvoker();
      await say({ text: 'Invoker is back ✅', thread_ts: threadTs });
    } catch (err) {
      await say({ text: `Restart failed: ${err instanceof Error ? err.message : String(err)}`, thread_ts: threadTs });
    }
  }

  /** Route a deterministic verb from `/invoker` (channel-level — slash can't run in a thread). */
  private async handleSlashControl(
    ctrl: LobbyControl,
    command: { channel_id: string; user_id: string },
    respond: RespondFn,
  ): Promise<void> {
    const channel = command.channel_id;
    if (ctrl.kind === 'submit') {
      await respond({
        text: 'Open the thread and use the Approve button on its plan review message.',
        response_type: 'ephemeral',
      });
      return;
    }
    if (ctrl.kind === 'restart') {
      const key = `slash:${channel}:${command.user_id}:${Date.now()}`;
      this.pendingConfirms.set(key, { kind: 'restart' });
      const prompt = 'This will restart Invoker.';
      await respond({ text: prompt, response_type: 'ephemeral', blocks: this.buildConfirmBlocks(prompt, key) as never });
      return;
    }

    if (!this.runWorkflowOp) {
      await respond({ text: 'Workflow operations are not available in this deployment.', response_type: 'ephemeral' });
      return;
    }
    const op: WorkflowOp = { operation: ctrl.operation, target: ctrl.target };
    if (ctrl.operation !== 'status' && 'all' in ctrl.target) {
      const key = `slash:${channel}:${command.user_id}:${Date.now()}`;
      this.pendingConfirms.set(key, { kind: 'op', op });
      const prompt = `This will \`${ctrl.operation}\` ALL workflows.`;
      await respond({ text: prompt, response_type: 'ephemeral', blocks: this.buildConfirmBlocks(prompt, key) as never });
      return;
    }
    try {
      const result = await this.runWorkflowOp(op);
      await respond({ text: result.summary, response_type: 'ephemeral' });
    } catch (err) {
      await respond({ text: `Operation failed: ${err instanceof Error ? err.message : String(err)}`, response_type: 'ephemeral' });
    }
  }

  /** The invoking user's planning thread in a channel: a threadTs, or 'none'/'ambiguous'. */
  private resolveRecentPlanThread(channel: string, userId: string): string | 'none' | 'ambiguous' {
    const matches: string[] = [];
    for (const [threadTs, ctx] of this.planningContexts) {
      if (ctx.requestedBy === userId && (ctx.lobbyChannel ?? this.lobbyChannelId) === channel) {
        matches.push(threadTs);
      }
    }
    if (matches.length === 0) {
      const persisted = this.slackSessionRepo?.listActivePlanThreads(channel, userId) ?? [];
      if (persisted.length === 0) return 'none';
      if (persisted.length > 1) return 'ambiguous';
      return persisted[0].threadTs;
    }
    if (matches.length > 1) return 'ambiguous';
    return matches[0];
  }

  private loadPlanningContext(threadTs: string): PlanningContext | undefined {
    const inMemory = this.planningContexts.get(threadTs);
    if (inMemory) return inMemory;
    const persisted = this.slackSessionRepo?.getLaunchContext(threadTs);
    if (!persisted) return undefined;
    const context: PlanningContext = {
      repoUrl: persisted.repoUrl || undefined,
      presetKey: persisted.harnessPreset,
      workingDir: persisted.workingDir || undefined,
      requestedBy: persisted.requestedBy || undefined,
      lobbyChannel: persisted.lobbyChannelId || undefined,
      confirmationMode: persisted.confirmationMode,
      harnessSessionId: persisted.harnessSessionId || undefined,
    };
    this.planningContexts.set(threadTs, context);
    return context;
  }

  private savePlanningContext(threadTs: string, context: PlanningContext): void {
    this.planningContexts.set(threadTs, context);
    this.persistLaunchContext(threadTs, context);
  }

  /** Persists a newly-established harness session id so a Slack restart can resume the same agent session. */
  private persistHarnessSessionId(threadTs: string, sessionId: string): void {
    const context = this.loadPlanningContext(threadTs);
    if (!context) return;
    this.savePlanningContext(threadTs, { ...context, harnessSessionId: sessionId });
  }

  private persistLaunchContext(threadTs: string, context: PlanningContext): void {
    this.slackSessionRepo?.saveLaunchContext({
      threadTs,
      repoUrl: context.repoUrl ?? '',
      harnessPreset: context.presetKey,
      workingDir: context.workingDir ?? '',
      harnessSessionId: context.harnessSessionId,
      requestedBy: context.requestedBy ?? '',
      lobbyChannelId: context.lobbyChannel ?? '',
      confirmationMode: context.confirmationMode,
    });
  }

  private async maybeRebindThreadRepo(
    channel: string,
    threadTs: string,
    userId: string | undefined,
    text: string,
    say: SayFn,
  ): Promise<{ context?: PlanningContext; rebound: boolean; blocked: boolean }> {
    const context = this.loadPlanningContext(threadTs);
    const repoUrl = extractRepoUrlFromMessage(text);
    if (!repoUrl || !context?.repoUrl) return { context, rebound: false, blocked: false };
    if (sameRepoUrl(context.repoUrl, repoUrl)) return { context, rebound: false, blocked: false };
    if (!userId || (context.requestedBy !== userId && !this.adminUserIds.has(userId))) {
      await say({
        text: 'Permission denied. Only the user who started this thread or an admin can switch it to a different repository.',
        thread_ts: threadTs,
      });
      return { context, rebound: false, blocked: true };
    }

    const updated: PlanningContext = {
      ...context,
      repoUrl,
      workingDir: undefined,
      requestedBy: context.requestedBy ?? userId,
      lobbyChannel: context.lobbyChannel ?? channel,
    };
    this.discardThreadSession(channel, threadTs);
    this.savePlanningContext(threadTs, updated);

    await say({
      text: `I switched this thread to repo \`${repoDisplayName(repoUrl)}\`. The previous working state for this thread was discarded.`,
      thread_ts: threadTs,
    });
    return { context: updated, rebound: true, blocked: false };
  }

  private discardThreadSession(channel: string, threadTs: string): void {
    this.conversationRepo?.deleteConversation(threadTs);
    if (this.sessionManager) {
      this.sessionManager.evictSession(new SessionIdentifier(channel, threadTs));
      return;
    }
    this.planConversations.delete(threadTs);
  }

  private async preparePlanningContextForSession(
    threadTs: string,
    context: PlanningContext,
    say: SayFn,
  ): Promise<PlanningContext | undefined> {
    if (!context.repoUrl || context.workingDir || !this.prepareRepoCheckout) return context;
    try {
      const workingDir = await this.prepareRepoCheckout(context.repoUrl);
      const updated = { ...context, workingDir };
      this.savePlanningContext(threadTs, updated);
      return updated;
    } catch (err) {
      this.log('slack', 'error', `Failed to prepare repo checkout for ${context.repoUrl}: ${err}`);
      await say({ text: `Failed to check out repo: ${err instanceof Error ? err.message : String(err)}`, thread_ts: threadTs });
      return undefined;
    }
  }

  private sessionOptionsFromContext(context: PlanningContext, mode?: ConversationMode): ConversationSessionOptions {
    const preset = this.resolveHarnessPreset(context.presetKey);
    return {
      tool: preset.tool,
      model: preset.model,
      workingDir: context.workingDir,
      mode,
      repoUrl: context.repoUrl,
      ...this.harnessDriverSessionOpts(preset, context),
    };
  }

  /** Resolves the harness session driver + any restored session id for a thread's preset. */
  private harnessDriverSessionOpts(
    preset: HarnessPreset,
    context: Pick<PlanningContext, 'harnessSessionId'>,
  ): Pick<ConversationSessionOptions, 'harnessSessionDriver' | 'harnessSessionId'> {
    return {
      harnessSessionDriver: this.harnessSessionDriverFactory?.(preset),
      harnessSessionId: context.harnessSessionId,
    };
  }

  private getPendingConfirm(key: string): PendingConfirm | undefined {
    const inMemory = this.pendingConfirms.get(key);
    if (inMemory) return inMemory;
    const persisted = this.slackSessionRepo?.getPendingConfirmation(key);
    if (persisted?.kind !== 'plan_intent' || !persisted.payload || typeof persisted.payload !== 'object') return undefined;
    const pending = persisted.payload as PendingConfirm;
    this.pendingConfirms.set(key, pending);
    return pending;
  }

  private async handleLocalRequest(
    request: LocalRequest,
    harness: HarnessPreset,
    threadTs: string,
    say: SayFn,
    channel: string,
    opts: { userId?: string; repoUrl?: string; workingDir?: string } = {},
  ): Promise<void> {
    if (request.kind === 'command') {
      // Raw shell on the host is admin-only: this runs `/bin/bash -lc` with the
      // full inherited environment, so anyone else must be refused before execution.
      if (!this.isLocalCommandAuthorized(opts.userId)) {
        await say({ text: 'Permission denied. Raw local shell commands (`exec local:`) require admin access.', thread_ts: threadTs });
        return;
      }
      const dir = await this.resolveLocalWorkingDir(opts.repoUrl, threadTs, say, opts.workingDir);
      if (!dir.ok) return;
      await say({ text: `Running locally on DO1: \`${truncateWords(request.text, 12)}\``, thread_ts: threadTs });
      try {
        const result = await this.runLocalCommand(request.text, dir.workingDir);
        const reply = this.formatLocalCommandResult(result);
        const chunks = splitForSlack(sanitizeSlackOutbound(reply));
        for (let i = 0; i < chunks.length; i++) {
          if (i > 0) await this.sleep(this.messagePacingMs);
          await this.sayWithRateLimitRetry(say, { text: chunks[i], thread_ts: threadTs });
        }
      } catch (err) {
        await this.sayWithRateLimitRetry(say, {
          text: `Local command failed to start: ${err instanceof Error ? err.message : String(err)}`,
          thread_ts: threadTs,
        });
      }
      return;
    }

    const dir = await this.resolveLocalWorkingDir(opts.repoUrl, threadTs, say, opts.workingDir);
    if (!dir.ok) return;
    await say({ text: 'Making that local change on DO1. I will not create or submit an Invoker plan.', thread_ts: threadTs });
    try {
      const reply = await this.runOneShotPlanner(harness, this.buildLocalChangePrompt(request.text, dir.workingDir));
      const chunks = splitForSlack(sanitizeSlackOutbound(reply));
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await this.sleep(this.messagePacingMs);
        await this.sayWithRateLimitRetry(say, { text: chunks[i], thread_ts: threadTs });
      }
    } catch (err) {
      await this.sayWithRateLimitRetry(say, {
        text: `Local change failed: ${err instanceof Error ? err.message : String(err)}`,
        thread_ts: threadTs,
      });
    }
  }

  /** Only configured admins may run raw local shell. Empty admin set = nobody. */
  private isLocalCommandAuthorized(userId?: string): boolean {
    return !!userId && this.adminUserIds.has(userId);
  }

  /** Resolve the working dir for a local request, honoring an explicit `[repo:…]` checkout. */
  private async resolveLocalWorkingDir(
    repoUrl: string | undefined,
    threadTs: string,
    say: SayFn,
    existingWorkingDir?: string,
  ): Promise<{ ok: true; workingDir?: string } | { ok: false }> {
    let workingDir = existingWorkingDir ?? this.workingDir;
    if (repoUrl && this.prepareRepoCheckout && existingWorkingDir === undefined) {
      try {
        workingDir = await this.prepareRepoCheckout(repoUrl);
      } catch (err) {
        await say({ text: `Failed to check out repo: ${err instanceof Error ? err.message : String(err)}`, thread_ts: threadTs });
        return { ok: false };
      }
    }
    return { ok: true, workingDir };
  }

  private buildLocalChangePrompt(text: string, workingDir?: string): string {
    const cwd = workingDir ?? this.workingDir ?? process.cwd();
    return `Make this request directly in the local checkout on DO1.

Working directory: ${cwd}

Rules:
- Do NOT generate Invoker YAML.
- Do NOT create, submit, start, or mention an Invoker workflow.
- Edit files only when the request needs a local change.
- Run the focused command or test that verifies the local change when practical.
- Reply with changed files, verification, and any remaining risk in short Slack prose.

Request:
${text}`;
  }

  private runLocalCommand(commandText: string, workingDir?: string): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    const timeoutMs = (this.planningTimeoutSeconds ?? 7_200) * 1_000;
    const cwd = workingDir ?? this.workingDir ?? process.cwd();
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/bash', ['-lc', commandText], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      // Bound the buffers as data arrives so a noisy command cannot exhaust memory
      // before formatting runs; only the tail is kept, which is all the reply shows.
      child.stdout?.on('data', (chunk: Buffer) => { stdout = capTailChars(stdout + chunk.toString(), MAX_LOCAL_CAPTURE_CHARS); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr = capTailChars(stderr + chunk.toString(), MAX_LOCAL_CAPTURE_CHARS); });
      const timer = setTimeout(() => {
        settled = true;
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        resolve({ code: null, stdout, stderr, timedOut: true });
      }, timeoutMs);
      child.on('close', (code) => {
        if (settled) return;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut: false });
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private formatLocalCommandResult(result: { code: number | null; stdout: string; stderr: string; timedOut: boolean }): string {
    const status = result.timedOut ? 'timed out' : `exit ${result.code ?? 'unknown'}`;
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n\n');
    const safeOutput = sanitizeSlackOutbound(output.replace(/```/g, '`\u200b``'));
    const maxChars = 12_000;
    const body = safeOutput.length > maxChars
      ? `[showing last ${maxChars} chars]\n${safeOutput.slice(-maxChars)}`
      : safeOutput;
    return body
      ? `Local command finished: ${status}\n\`\`\`\n${body}\n\`\`\``
      : `Local command finished: ${status}`;
  }

  private resolveHarnessPreset(presetKey: string): HarnessPreset {
    return (
      this.harnessPresets[presetKey] ??
      this.harnessPresets[this.defaultHarnessPreset] ??
      BUILTIN_HARNESS_PRESETS[DEFAULT_HARNESS_PRESET]
    );
  }

  private resolveRepoUrl(repo?: string): { url?: string; error?: string } {
    if (!repo) return { url: this.defaultRepoUrl && this.normalizeRepositoryUrl(this.defaultRepoUrl) };
    const aliasKey = Object.keys(this.repoAliases).find((key) => key.toLowerCase() === repo.toLowerCase());
    const alias = aliasKey && this.repoAliases[aliasKey];
    if (alias) return { url: this.normalizeRepositoryUrl(alias) };
    const literalRepoUrl = repo.trim().replace(/^<([^|>]+)(?:\|[^>]+)?>$/, '$1');
    if (/^(?:git@|https?:\/\/|ssh:\/\/)/i.test(literalRepoUrl)) {
      const supportedRepoUrl = normalizeSupportedRepoCandidate(literalRepoUrl);
      if (supportedRepoUrl) return { url: this.normalizeRepositoryUrl(supportedRepoUrl) };
      return { error: `Invalid repo URL "${literalRepoUrl}". ${INVALID_LITERAL_REPO_URL_GUIDANCE}` };
    }
    const known = Object.keys(this.repoAliases);
    const list = known.length ? known.join(', ') : '(none configured)';
    return { error: `Unknown repo "${repo}". Known aliases: ${list}. Or pass a full git URL.` };
  }

  private findMentionedRepoAlias(text: string): string | undefined {
    return Object.keys(this.repoAliases).find((alias) => (
      new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i').test(text)
    ));
  }

  private normalizeDraftedPlanRepoUrl(planText: string, contextRepoUrl: string | undefined): string {
    let raw: unknown;
    try {
      raw = parseYaml(planText);
    } catch {
      return planText;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return planText;

    const plan = raw as Record<string, unknown>;
    if (typeof plan.repoUrl !== 'string') return planText;
    const repoUrl = plan.repoUrl.trim();
    const aliasKey = Object.keys(this.repoAliases).find((key) => key.toLowerCase() === repoUrl.toLowerCase());
    if (aliasKey) {
      plan.repoUrl = this.normalizeRepositoryUrl(this.repoAliases[aliasKey]);
      return stringifyYaml(plan);
    }
    if (!/^(?:git@|https?:\/\/|ssh:\/\/|file:\/\/|\/|\.{1,2}\/)/.test(repoUrl) && contextRepoUrl) {
      plan.repoUrl = contextRepoUrl;
      return stringifyYaml(plan);
    }
    return planText;
  }

  private normalizeRepositoryUrl(repoUrl: string): string {
    return repoUrl.trim().replace(/^<([^|>]+)(?:\|[^>]+)?>$/, '$1').replace(/\/+$/, '');
  }

  private shouldPrepareRepoCheckout(repoUrl: string | undefined): repoUrl is string {
    return !!repoUrl
      && !!this.prepareRepoCheckout
      && (!this.defaultRepoUrl || repositoryIdentity(repoUrl) !== repositoryIdentity(this.defaultRepoUrl));
  }

  // ── In-channel workflow assistant ──────────────────────

  private async handleWorkflowAssistantMention(
    mapping: WorkflowChannel,
    event: SlackMentionEvent,
    say: SayFn,
  ): Promise<void> {
    const threadTs = event.thread_ts ?? event.ts;
    const text = (event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
    this.log('slack', 'info', `[WORKFLOW_MENTION] instance=${this.instanceId} event_ts=${event.ts} thread_ts=${threadTs} workflow=${mapping.workflowId}`);
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
      this.log('slack', 'info', `[WORKFLOW_PLANNER] instance=${this.instanceId} event_ts=${event.ts} tool=${harness.tool} model=${harness.model ?? 'default'}`);
      const reply = await this.runOneShotPlanner(harness, buildAssistantPrompt(text, ctx));
      const chunks = splitForSlack(sanitizeSlackOutbound(reply));
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
    const run = async (command: Parameters<NonNullable<typeof this.onCommand>>[0], okText: string): Promise<void> => {
      try {
        await this.onCommand?.(command);
        await say({ text: okText, thread_ts: threadTs });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await say({ text: detail, thread_ts: threadTs });
      }
    };
    switch (ctrl.kind) {
      case 'status':
        await run(
          { type: 'get_status', workflowId: mapping.workflowId },
          `Fetching status for \`${mapping.workflowId}\`...`,
        );
        return;
      case 'approve':
        await run(
          { type: 'approve', taskId: scoped(ctrl.task) },
          `Approving \`${scoped(ctrl.task)}\`.`,
        );
        return;
      case 'reject':
        await run(
          { type: 'reject', taskId: scoped(ctrl.task) },
          `Rejecting \`${scoped(ctrl.task)}\`.`,
        );
        return;
      case 'retry':
        await run(
          { type: 'retry', taskId: scoped(ctrl.task) },
          `Retrying \`${scoped(ctrl.task)}\`.`,
        );
        return;
      case 'input':
        await run(
          { type: 'provide_input', taskId: scoped(ctrl.task), input: ctrl.text },
          `Sent input to \`${scoped(ctrl.task)}\`.`,
        );
        return;
    }
  }

  private async runOneShotPlanner(harness: HarnessPreset, prompt: string): Promise<string> {
    const promptTransport = materializeLocalAgentPrompt(prompt, 'invoker-slack-prompt-');
    try {
      const { command, args } = this.planningCommandBuilder
        ? this.planningCommandBuilder({ tool: harness.tool, model: harness.model, prompt: promptTransport.effectivePrompt })
        : defaultPlanningCommand(this.cursorCommand, { model: harness.model, prompt: promptTransport.effectivePrompt });
      const plannerLabel = harness.tool ?? command;
      const timeoutMs = (this.planningTimeoutSeconds ?? 7_200) * 1_000;
      const totalAttempts = this.plannerRetryLimit + 1;
      let lastStderrTail = '';

      for (let attempt = 0; attempt < totalAttempts; attempt++) {
        if (attempt > 0) {
          const backoffMs = this.plannerRetryBaseDelayMs * (2 ** (attempt - 1));
          this.log?.('slack-surface', 'warn',
            `[PLANNER_RETRY] backing off ${backoffMs}ms before attempt=${attempt + 1}/${totalAttempts} (planner=${plannerLabel})`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
        try {
          return await this.runOneShotPlannerAttempt(command, args, plannerLabel, timeoutMs, attempt + 1, totalAttempts);
        } catch (err) {
          if (isEmptyOutputAttemptError(err)) {
            lastStderrTail = err.stderrTail;
            const isLast = attempt >= totalAttempts - 1;
            this.log?.('slack-surface', 'warn',
              `[PLANNER_RETRY] attempt=${attempt + 1}/${totalAttempts} produced no output (planner=${plannerLabel}, willRetry=${!isLast}, stderrBytes=${err.stderrTail.length}, stderrTail="${err.stderrTail.slice(-200).replace(/\n/g, '\\n')}")`);
            if (!isLast) continue;
            throw buildEmptyPlannerOutputError(plannerLabel, lastStderrTail, { attemptCount: totalAttempts });
          }
          throw err;
        }
      }
      throw buildEmptyPlannerOutputError(plannerLabel, lastStderrTail, { attemptCount: totalAttempts });
    } finally {
      const cleanupResult = promptTransport.cleanup();
      if (cleanupResult) {
        this.log?.(
          'slack-surface',
          'warn',
          `[PROMPT_CLEANUP] failed to remove materialized planner prompt at ${cleanupResult.directory}: ${cleanupResult.error.message}`,
        );
      }
    }
  }

  private runOneShotPlannerAttempt(
    command: string,
    args: string[],
    plannerLabel: string,
    timeoutMs: number,
    attemptNumber: number,
    totalAttempts: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.workingDir ?? process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      this.log?.('slack-surface', 'info',
        `[PERF] one_shot_spawn: pid=${child.pid ?? 'none'}, planner=${plannerLabel}, attempt=${attemptNumber}/${totalAttempts}`);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      }, timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Planner timed out after ${timeoutMs}ms`));
          return;
        }
        if (code === 0) {
          const trimmed = stdout.trim();
          if (trimmed) {
            const message = formatCodexPlannerStdout(trimmed).message;
            resolve(message || 'The planner completed without a final user-facing reply.');
          } else {
            reject(new EmptyOutputAttemptError(stderr));
          }
        } else {
          reject(new Error(stderr.trim() || stdout.trim() || `Planner exited with code ${code}`));
        }
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

    let inviteFailed: string | undefined;
    if (event.requestedBy) {
      try {
        await client.conversations.invite({ channel: channelId, users: event.requestedBy });
      } catch (err) {
        const code = this.slackErrorCode(err);
        if (code === 'already_in_channel' || code === 'cant_invite_self') {
          // Requester is already present — treat as success.
        } else {
          inviteFailed = code ?? (err instanceof Error ? err.message : String(err));
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
    await this.publishWorkflowPlanCard(channelId, event.workflowId, event.planFile);

    if (event.lobbyChannel) {
      if (inviteFailed) {
        await this.postToThread(
          event.lobbyChannel,
          event.lobbyThreadTs,
          `Created private <#${channelId}> for workflow \`${event.workflowId}\`, but I could not invite you (${inviteFailed}). Ask a workspace admin to invite you, or check the bot has \`groups:write\` and was reinstalled after adding scopes.`,
        );
      } else {
        await this.postToThread(event.lobbyChannel, event.lobbyThreadTs, `Created <#${channelId}> for workflow \`${event.workflowId}\`.`);
      }
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

  private async publishWorkflowPlanCard(channel: string, workflowId: string, planFile: string | undefined): Promise<void> {
    if (!planFile) return;
    let planText: string;
    try {
      planText = readFileSync(planFile, 'utf8');
    } catch (err) {
      this.log('slack', 'error', `[PLAN] Failed to read workflow plan ${planFile}: ${err}`);
      await this.postMessage(
        { text: `Could not read the workflow plan file: ${err instanceof Error ? err.message : String(err)}`, blocks: [] },
        channel,
      );
      return;
    }
    const summary = summarizePlanText(planText);
    if (!summary) {
      await this.postMessage(
        { text: `Could not summarize the workflow plan for \`${workflowId}\`.`, blocks: [] },
        channel,
      );
      return;
    }
    const text = `*Plan for workflow \`${workflowId}\`*\n${this.renderPlanSummary(summary)}`;
    const summaryTs = await this.postMessage({ text, blocks: [] }, channel);
    if (summaryTs) {
      try {
        await this.app.client.pins.add({ channel, timestamp: summaryTs });
      } catch (err) {
        this.log('slack', 'error', `[PLAN] Failed to pin workflow plan (channel=${channel}, workflow=${workflowId}): ${err}`);
        await this.postMessage(
          { text: 'Could not pin the workflow plan. Add the `pins:write` bot scope and reinstall the Slack app.', blocks: [] },
          channel,
        );
      }
    }
    try {
      await this.app.client.files.uploadV2({
        channel_id: channel,
        file_uploads: [{ file: planFile, filename: `workflow-${workflowId}-plan.yaml` }],
      });
    } catch (err) {
      this.log('slack', 'error', `[PLAN] Failed to upload workflow plan (channel=${channel}, workflow=${workflowId}): ${err}`);
      await this.postMessage(
        { text: `Could not upload the workflow plan YAML: ${err instanceof Error ? err.message : String(err)}`, blocks: [] },
        channel,
      );
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

      const text = (msg.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
      if (!text) return;

      // /plan is a deterministic command and takes priority, mirroring the
      // @mention handler's ordering: it must run before resolveConfirm, or a
      // pending unrelated confirmation's "not a yes/no" fallback swallows it
      // (deletes the pending confirm and replies instead of ever reaching
      // this branch).
      if (/^\/plan\s*$/i.test(text) || /^\/plan\s+.+/i.test(text)) {
        const context = this.loadPlanningContext(msg.thread_ts);
        if (!context) {
          await say({ text: 'This thread has no pinned repository context yet. @mention me first to start planning.', thread_ts: msg.thread_ts });
          return;
        }
        if (/^\/plan\s*$/i.test(text)) {
          await this.handleExplicitPlanAction(channel, msg.thread_ts, msg.user ?? 'unknown', say);
          return;
        }
        await this.stagePlanIntentConfirm(msg.thread_ts, channel, {
          kind: 'plan_intent',
          requestText: text.replace(/^\/plan\s+/i, ''),
          userId: msg.user ?? 'unknown',
          context,
          channel,
        }, say);
        return;
      }

      if (await this.resolveConfirm(msg.thread_ts, text, say, channel)) return;

      const rebind = await this.maybeRebindThreadRepo(channel, msg.thread_ts, msg.user, text, say);
      if (rebind.rebound || rebind.blocked) return;

      const localRequest = parseLocalRequest(text);
      if (localRequest) {
        const context = rebind.context;
        const preparedContext = context
          ? await this.preparePlanningContextForSession(msg.thread_ts, context, say)
          : undefined;
        if (context && !preparedContext) return;
        if (localRequest.kind !== 'command') {
          const conversation = await this.getSession(
            channel,
            msg.thread_ts,
            msg.user ?? 'unknown',
            !!preparedContext,
            preparedContext ? this.sessionOptionsFromContext(preparedContext, 'agent') : undefined,
          );
          if (!conversation) return;
          await this.handleConversationMessage(conversation, localRequest.text, msg.thread_ts, say, channel, undefined,
            preparedContext ? { userId: msg.user ?? 'unknown', context: preparedContext } : undefined);
          return;
        }
        const preset = this.resolveHarnessPreset(preparedContext?.presetKey ?? this.defaultHarnessPreset);
        await this.handleLocalRequest(localRequest, preset, msg.thread_ts, say, channel, {
          userId: msg.user,
          repoUrl: preparedContext?.repoUrl,
          workingDir: preparedContext?.workingDir,
        });
        return;
      }

      const conversation = await this.getSession(channel, msg.thread_ts, msg.user ?? 'unknown', false);
      if (!conversation) return;

      this.log('slack', 'info', `[PASSIVE_THREAD_CONTEXT] thread_ts=${msg.thread_ts} user=${msg.user} preview="${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`);
    });
  }

  // ── Shared Conversation Message Handler ────────────────

  private async handleConversationMessage(
    conversation: ConversationLike,
    text: string,
    threadTs: string,
    say: SayFn,
    channel: string = this.lobbyChannelId,
    sourceEventTs?: string,
    planIntentContext?: { userId: string; context: PlanningContext },
  ): Promise<void> {
    const tEntry = Date.now();
    this.log('slack', 'info', `[TRACE] handleConversationMessage (thread_ts=${threadTs}, text="${text.slice(0, 80)}")`);

    const typingStarted = await this.startTypingIndicator(channel, threadTs);
    const tSetup = Date.now();

    const heartbeatMs = (this.planningHeartbeatIntervalSeconds ?? 120) * 1_000;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    const heartbeatTimestamps: string[] = [];
    let heartbeatInFlight = false;
    const cleanupHeartbeats = async (): Promise<void> => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      for (const hbTs of heartbeatTimestamps) {
        try {
          await this.deleteMessage(channel, hbTs);
        } catch (err) {
          this.log('slack', 'warn', `[HEARTBEAT] Failed to delete heartbeat message ${hbTs}: ${err}`);
        }
      }
    };
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
      this.log('slack', 'info', `[TRACE] conversation.sendMessage returned (threadTs=${threadTs}, replyLen=${reply.length}, planSubmitted=${conversation.planSubmitted})`);

      if (typingStarted) {
        await this.stopTypingIndicator(channel, threadTs);
      }

      const renderedReply = reply;
      const chunks = splitForSlack(sanitizeSlackOutbound(renderedReply));
      const blocks: unknown[] = [];
      const firstMessage = {
        text: chunks[0],
        thread_ts: threadTs,
        ...(blocks.length > 0 ? { blocks } : {}),
      };
      const revision = process.env.INVOKER_REVISION ?? process.env.GIT_COMMIT ?? 'unknown';
      this.log('slack', 'info',
        `[RESPONSE_PROVENANCE] instance=${this.instanceId} thread_ts=${threadTs} source_event_ts=${sourceEventTs ?? threadTs} mode=${conversation.conversationMode} revision=${revision} reply_chars=${renderedReply.length} chunks=${chunks.length}`);

      const ackTs = this.ackMessages.get(threadTs);
      if (ackTs) {
        const updated = await this.updateMessage(channel, ackTs, {
          text: chunks[0],
          blocks: blocks as SlackMessage['blocks'],
        });
        this.ackMessages.delete(threadTs);
        if (updated) {
          this.log('slack', 'info', `[RESPONSE_POSTED] instance=${this.instanceId} thread_ts=${threadTs} source_event_ts=${sourceEventTs ?? threadTs} reply_ts=${ackTs} disposition=ack-replaced`);
        } else {
          this.log('slack', 'warn', `[ACK] Failed to replace ack, falling back to new message (thread_ts=${threadTs}, ack_ts=${ackTs})`);
          await this.deleteMessage(channel, ackTs);
          const posted = await this.sayWithRateLimitRetry(say, firstMessage);
          this.logResponsePosted(threadTs, sourceEventTs, posted?.ts, 'new-message');
        }
      } else {
        const posted = await this.sayWithRateLimitRetry(say, firstMessage);
        this.logResponsePosted(threadTs, sourceEventTs, posted?.ts, 'new-message');
      }

      for (let i = 1; i < chunks.length; i++) {
        await this.sleep(this.messagePacingMs);
        const posted = await this.sayWithRateLimitRetry(say, { text: chunks[i], thread_ts: threadTs });
        this.logResponsePosted(threadTs, sourceEventTs, posted?.ts, 'chunk');
      }
      const tPosting = Date.now();

      if (planIntentContext && conversation.lastTurnPlanIntentSignal?.wantsPlan) {
        try {
          await this.stagePlanIntentConfirm(threadTs, channel, {
            kind: 'plan_intent',
            requestText: text,
            userId: planIntentContext.userId,
            context: planIntentContext.context,
            channel,
            // The turn's text was already sent above (this.log'd as
            // "conversation.sendMessage returned" right before this block) -
            // Approve must not replay it, or the model answers it twice.
            alreadySent: true,
          }, say);
        } catch (err) {
          this.log('slack', 'error', `[PLAN_INTENT_CONFIRM] failed to stage from auto-detect thread_ts=${threadTs}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }

      if (this.conversationalPlanning && conversation.conversationMode === 'plan' && conversation.lastTurnDraftPlanText) {
        try {
          await this.stageDraftReviewFromPlannerOutput(reply, conversation, channel, threadTs,
            planIntentContext?.userId ?? 'unknown', say, { silentWhenNotReady: true });
        } catch (err) {
          this.log('slack', 'error', `[DRAFT_STAGE] failed to stage conversational draft thread_ts=${threadTs}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }

      await this.uploadLinkedArtifacts(reply, conversation.workingDir, channel, threadTs);
      await cleanupHeartbeats();
      const tHeartbeatCleanup = Date.now();

      const tEnd = Date.now();

      this.log('slack', 'info', `[PERF] thread_ts=${threadTs} setup=${tSetup - tEntry}ms cursor=${tCursor - tSetup}ms posting=${tPosting - tCursor}ms heartbeatCleanup=${tHeartbeatCleanup - tPosting}ms chunks=${chunks.length} total=${tEnd - tEntry}ms`);
    } catch (err) {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
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
      try {
        await this.sayWithRateLimitRetry(say, {
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          thread_ts: threadTs,
        });
      } finally {
        await cleanupHeartbeats();
      }
    }
  }

  private logResponsePosted(threadTs: string, sourceEventTs: string | undefined, replyTs: string | undefined, disposition: string): void {
    this.log('slack', 'info', `[RESPONSE_POSTED] instance=${this.instanceId} thread_ts=${threadTs} source_event_ts=${sourceEventTs ?? threadTs} reply_ts=${replyTs ?? 'unknown'} disposition=${disposition}`);
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
    say: SayFn,
    msg: { text: string; thread_ts: string; blocks?: unknown[] },
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
    opts?: ConversationSessionOptions,
  ): Promise<ConversationLike | null> {
    this.log('slack', 'info', `[TRACE] getSession (channelId=${channelId}, threadTs=${threadTs}, userId=${userId}, create=${create}, hasSessionManager=${!!this.sessionManager})`);
    if (this.sessionManager) {
      if (!create) {
        // Look up existing session without creating — used by message handler
        // to avoid creating empty sessions for random thread replies
        this.log('slack', 'info', `[TRACE] findSession (threadTs=${threadTs})`);
        const found = await this.sessionManager.getSession(
          new SessionIdentifier(channelId, threadTs),
          userId,
          opts,
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
        mode: opts?.mode ?? 'agent',
        planningCommandBuilder: this.planningCommandBuilder,
        workingDir: opts?.workingDir ?? this.workingDir,
        threadTs,
        conversationRepo: this.conversationRepo,
        defaultBranch: this.defaultBranch,
        repoUrl: opts?.repoUrl ?? this.defaultRepoUrl,
        timeoutMs: (this.planningTimeoutSeconds ?? 7_200) * 1_000,
        plannerRetryLimit: this.plannerRetryLimit,
        plannerRetryBaseDelayMs: this.plannerRetryBaseDelayMs,
        conversationalPlanning: this.conversationalPlanning,
        harnessSessionDriver: opts?.harnessSessionDriver,
        harnessSessionId: opts?.harnessSessionId,
        onHarnessSessionId: (sessionId) => this.persistHarnessSessionId(threadTs, sessionId),
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
  private cleanupSession(threadTs: string, reason: string, channelId = this.channelId): void {
    if (this.sessionManager) {
      this.sessionManager.markPlanSubmitted(new SessionIdentifier(channelId, threadTs));
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
          const context = this.loadPlanningContext(entry.threadTs);
          if (context && !this.harnessPresets[context.presetKey]) {
            this.log('slack', 'error', `[SESSION_RECOVERY] Unknown persisted harness preset "${context.presetKey}" for ${entry.threadTs}`);
            this.sessionMetrics.errors++;
            continue;
          }
          const harness = this.resolveHarnessPreset(context?.presetKey ?? this.defaultHarnessPreset);
          const workingDir = await this.prepareRecoveredWorkingDir(entry.threadTs, context);
          if (workingDir === undefined && this.shouldPrepareRepoCheckout(context?.repoUrl)) continue;
          const id = new SessionIdentifier(
            entry.channelId || this.channelId,
            entry.threadTs,
          );
          await this.sessionManager.getOrCreateSession(id, entry.userId, {
            tool: harness.tool,
            model: harness.model,
            workingDir,
            mode: entry.mode ?? 'plan',
            repoUrl: context?.repoUrl ?? this.defaultRepoUrl,
            ...this.harnessDriverSessionOpts(harness, context ?? {}),
          });
          this.sessionMetrics.recovered++;
        }
      } else {
        // Fallback: direct Map recovery
        for (const entry of active) {
          const context = this.loadPlanningContext(entry.threadTs);
          if (context && !this.harnessPresets[context.presetKey]) {
            this.log('slack', 'error', `[SESSION_RECOVERY] Unknown persisted harness preset "${context.presetKey}" for ${entry.threadTs}`);
            this.sessionMetrics.errors++;
            continue;
          }
          const harness = this.resolveHarnessPreset(context?.presetKey ?? this.defaultHarnessPreset);
          const workingDir = await this.prepareRecoveredWorkingDir(entry.threadTs, context);
          if (workingDir === undefined && this.shouldPrepareRepoCheckout(context?.repoUrl)) continue;
          const conversation = new PlanConversation({
            cursorCommand: this.cursorCommand,
            tool: harness.tool,
            model: harness.model,
            mode: entry.mode ?? 'plan',
            planningCommandBuilder: this.planningCommandBuilder,
            workingDir,
            threadTs: entry.threadTs,
            conversationRepo: this.conversationRepo,
            defaultBranch: this.defaultBranch,
            repoUrl: context?.repoUrl ?? this.defaultRepoUrl,
            plannerRetryLimit: this.plannerRetryLimit,
            plannerRetryBaseDelayMs: this.plannerRetryBaseDelayMs,
            conversationalPlanning: this.conversationalPlanning,
            ...this.harnessDriverSessionOpts(harness, context ?? {}),
            onHarnessSessionId: (sessionId) => this.persistHarnessSessionId(entry.threadTs, sessionId),
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

  private async prepareRecoveredWorkingDir(threadTs: string, context: PlanningContext | undefined): Promise<string | undefined> {
    const prepareRepoCheckout = this.prepareRepoCheckout;
    if (!this.shouldPrepareRepoCheckout(context?.repoUrl) || !prepareRepoCheckout) {
      return context?.workingDir ?? this.workingDir;
    }
    try {
      const workingDir = await prepareRepoCheckout(context.repoUrl);
      if (context) this.savePlanningContext(threadTs, { ...context, workingDir });
      return workingDir;
    } catch (err) {
      this.log('slack', 'error', `[SESSION_RECOVERY] Failed to prepare repo checkout for ${threadTs}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
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

  private async postMessage(message: SlackMessage, channel = this.lobbyChannelId, threadTs?: string): Promise<string | undefined> {
    try {
      const result = await this.app.client.chat.postMessage({
        channel,
        text: message.text,
        blocks: message.blocks as any,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      this.log('slack', 'info', `Posted message: "${message.text.slice(0, 80)}..."`);
      return result.ts;
    } catch (err) {
      this.log('slack', 'error', `Failed to post message: ${err}`);
      return undefined;
    }
  }

  private async uploadLinkedArtifacts(
    reply: string,
    workingDir: string | undefined,
    channel: string,
    threadTs: string,
  ): Promise<void> {
    if (!workingDir) return;

    const { paths, rejected } = extractArtifactPaths(reply, workingDir);
    for (const entry of rejected) {
      this.log('slack', 'warn', `[UPLOAD] Skipped artifact (thread_ts=${threadTs}, reason=${entry.reason}): ${entry.path}`);
    }

    const uploads: { file: string; filename: string }[] = [];
    let batchBytes = 0;
    for (const filePath of paths) {
      let size: number;
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) {
          this.log('slack', 'warn', `[UPLOAD] Skipped artifact (not a regular file): ${filePath}`);
          continue;
        }
        size = stat.size;
      } catch (err) {
        this.log('slack', 'warn', `[UPLOAD] Skipped unreadable artifact ${filePath}: ${err}`);
        continue;
      }
      if (batchBytes + size > MAX_ARTIFACT_BATCH_BYTES) {
        this.log('slack', 'warn', `[UPLOAD] Skipped artifact (batch would exceed ${MAX_ARTIFACT_BATCH_BYTES} bytes): ${filePath}`);
        continue;
      }
      batchBytes += size;
      uploads.push({ file: filePath, filename: basename(filePath) });
    }

    if (uploads.length === 0) return;

    try {
      await this.app.client.files.uploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file_uploads: uploads,
      });
      this.log('slack', 'info', `[UPLOAD] Uploaded ${uploads.length} artifact(s) (thread_ts=${threadTs})`);
    } catch (err) {
      const names = uploads.map((u) => u.filename).join(', ');
      this.log('slack', 'error', `[UPLOAD] files.uploadV2 failed (channel=${channel}, thread_ts=${threadTs}, files=${names}): ${err}`);
      await this.postMessage(
        { text: `Could not upload ${names} to this thread: ${err instanceof Error ? err.message : String(err)}`, blocks: [] },
        channel,
        threadTs,
      );
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
