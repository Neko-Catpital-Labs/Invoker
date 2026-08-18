import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { trimPreservingEscapeSequences } from './embedded-terminal-manager.js';
import type {
  InAppPlanRequest,
  InAppPlanResponse,
  InAppPlanningChatLine,
  InAppPlanningChatRequest,
  InAppPlanningChatResponse,
  InAppPlanningCreateSessionRequest,
  InAppPlanningCreateSessionResponse,
  InAppPlanningDeleteRequest,
  InAppPlanningDeleteResponse,
  InAppPlanningDeleteSubmittedResponse,
  InAppPlanningDiscardDraftRequest,
  InAppPlanningDiscardDraftResponse,
  InAppPlanningListSessionsResponse,
  InAppPlanningRepoBinding,
  InAppPlanningPlanSummary,
  InAppPlanningRebindRepoRequest,
  InAppPlanningRebindRepoResponse,
  InAppPlanningResetRequest,
  InAppPlanningResetResponse,
  InAppPlanningSetTerminalModeRequest,
  InAppPlanningSetTerminalModeResponse,
  InAppPlanningSessionStatus,
  InAppPlanningSessionSummary,
  InAppPlanningStreamEvent,
  InAppPlanningSubmitRequest,
  InAppPlanningSubmitResponse,
  Logger,
  PlanningConfirmationMode,
  PlanningTerminalMode,
  PlanningPresetOption,
} from '@invoker/contracts';
import { resolveInvokerHomeRoot } from '@invoker/contracts';
import type {
  ConversationMessageEntry,
  ConversationRepository,
  InAppPlanningSessionPatch,
  InAppPlanningSessionRecord,
} from '@invoker/data-store';
import type { AgentRegistry } from '@invoker/execution-engine';
import {
  decideWorktreeBinding,
  evaluatePlanningTurn,
  formatPlanningHostedTurn,
  hasExplicitDraftIntent as hasCoreExplicitDraftIntent,
  isDraftingAuthorized,
  preparePlanningReview,
  submitPlanningReview,
  summarizePlanText,
  type PlanningMessage,
} from '@invoker/planning-core';
import type { HarnessPreset, PlanConversation, PlanConversationConfig, PlanningCommandBuilder } from '@invoker/surfaces';
import type { InvokerConfig } from './config.js';
import {
  ensurePlanningWorktreeReady,
  planningMcpConfigPath,
  provisionPlanningWorktree,
  releasePlanningWorktree,
  type PlanningRepoPool,
} from './planning-chat-worktree.js';

function logPlanningWorktreeReadyError(sessionId: string, step: string, error: unknown): void {
  console.error(`[planning-chat] ensurePlanningWorktreeReady ${step} failed session="${sessionId}": ${
    error instanceof Error ? error.message : String(error)
  }`);
}

export interface LoadedGeneratedPlan {
  planName: string;
  workflowId: string;
  workflowIds?: string[];
  workflowCount?: number;
}

export interface InAppPlanningSessionStore {
  upsertInAppPlanningSession(record: InAppPlanningSessionRecord): void;
  updateInAppPlanningSession(sessionId: string, patch: InAppPlanningSessionPatch): void;
  deleteInAppPlanningSession(sessionId: string): void;
}

export interface InAppPlannerDeps {
  config: InvokerConfig;
  loadGeneratedPlan: (planText: string) => LoadedGeneratedPlan | Promise<LoadedGeneratedPlan>;
  workingDir?: string;
  planningCommandBuilder?: PlanningCommandBuilder;
  executionAgentRegistry?: Pick<AgentRegistry, 'get' | 'getSessionDriver'>;
  conversationRepo?: ConversationRepository;
  logger?: Logger;
  plannerReplyOverride?: (formattedMessage: string) => Promise<string>;
  onRawPlannerOutput?: (event: InAppPlanningStreamEvent) => void;
  /** Canonical full skill-doctor script. Kept separate from target worktrees. */
  planDoctorScriptPath?: string;
}

export interface InAppPlanningChatSession {
  id: string;
  title: string;
  presetKey: string;
  confirmationMode: PlanningConfirmationMode;
  status: InAppPlanningSessionStatus;
  messages: InAppPlanningChatLine[];
  conversation: PlanConversation;
  repoUrl?: string;
  baseBranch?: string;
  baseCommit?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  draftPlanSummary?: InAppPlanningPlanSummary;
  draftPlanText?: string;
  submittedWorkflowId?: string;
  submittedPlanName?: string;
  terminalMode?: PlanningTerminalMode;
  terminalSessionId?: string;
  terminalStatus?: 'running' | 'exited';
  terminalExitCode?: number;
  terminalOutputSnapshot?: string;
  terminalUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
  nextMessageId: number;
  pendingSend?: Promise<void>;
  pendingSubmit?: Promise<InAppPlanningSubmitResponse>;
}

export type InAppPlanningChatSessions = Map<string, InAppPlanningChatSession>;

export function createInAppPlanningChatSessions(): InAppPlanningChatSessions {
  return new Map();
}

function isModuleResolutionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes('Cannot find module')
    || error.message.includes('Cannot find package')
    || error.message.includes('ERR_MODULE_NOT_FOUND')
    || error.message.includes('ERR_UNKNOWN_FILE_EXTENSION')
  );
}

type PlanConversationConstructor = new (config: PlanConversationConfig) => PlanConversation;

interface PlannerSurfacesModule {
  BUILTIN_HARNESS_PRESETS: Record<string, HarnessPreset>;
  DEFAULT_HARNESS_PRESET: string;
  PlanConversation: PlanConversationConstructor;
  extractYamlPlan: (output: string) => string | null;
  selectHarnessSessionDriver: (
    preset: HarnessPreset,
    deps: Pick<InAppPlannerDeps, 'executionAgentRegistry' | 'planningCommandBuilder'> & { mcpConfigPath?: string },
  ) => PlanConversationConfig['harnessSessionDriver'];
}

async function loadPlannerSurfaces(): Promise<PlannerSurfacesModule> {
  try {
    // Static import cannot work in required-fast CI because that job boots the built app
    // before the workspace @invoker/surfaces package has produced dist/index.js.
    return await import('@invoker/surfaces');
  } catch (packageError) {
    if (!isModuleResolutionError(packageError)) {
      throw packageError;
    }
    const builtSurfacesModulePath = '../../surfaces/dist/index.js';
    try {
      // Runtime fallback: built Electron tests may run before workspace package exports resolve.
      return await import(builtSurfacesModulePath);
    } catch (distError) {
      if (!isModuleResolutionError(distError)) {
        throw distError;
      }
      if (process.versions.electron) {
        throw new Error('Unable to load @invoker/surfaces. Build packages/surfaces first so dist/index.js exists.');
      }
      const sourceSurfacesModulePath = '../../surfaces/src/index.ts';
      // Runtime fallback: Vitest can execute TypeScript sources before package dist exists.
      return await import(sourceSurfacesModulePath);
    }
  }
}

async function resolveHarnessPresets(config: InvokerConfig): Promise<Record<string, HarnessPreset>> {
  const { BUILTIN_HARNESS_PRESETS } = await loadPlannerSurfaces();
  return {
    ...BUILTIN_HARNESS_PRESETS,
    ...(config.slackHarnessPresets ?? {}),
  };
}

async function resolveDefaultPresetKey(config: InvokerConfig): Promise<string> {
  const { DEFAULT_HARNESS_PRESET } = await loadPlannerSurfaces();
  return config.defaultSlackHarnessPreset ?? DEFAULT_HARNESS_PRESET;
}

function labelForPresetKey(key: string): string {
  switch (key) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'omp':
      return 'OMP';
    case 'omp+claude':
      return 'Claude via OMP';
    case 'omp+codex':
      return 'Codex via OMP';
    case 'cursor+claude':
      return 'Cursor + Claude';
    case 'cursor+codex':
      return 'Cursor + Codex';
    default:
      return key.replaceAll('+', ' + ');
  }
}

export const PLANNING_TERMINAL_SUMMARY_BRIDGE_START = '=== Invoker planning tmux bridge ===';
export const PLANNING_TERMINAL_SUMMARY_BRIDGE_END = '=== End Invoker planning tmux bridge ===';

const PLANNING_TERMINAL_BRIDGE_TEXT_LIMIT = 220;
const PLANNING_TERMINAL_BRIDGE_STEP_LIMIT = 3;

function oneLine(value: string): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFencedYamlPlanText(text: string): string | null {
  const fenceStart = text.lastIndexOf('```yaml\n');
  if (fenceStart === -1) return null;
  const contentStart = fenceStart + '```yaml\n'.length;
  const rest = text.slice(contentStart);
  const closeMatch = rest.match(/^```\s*$/m);
  const yamlContent = closeMatch && closeMatch.index !== undefined
    ? rest.slice(0, closeMatch.index)
    : rest;
  const trimmed = yamlContent.trim();
  return trimmed ? trimmed : null;
}

function truncatedLine(value: string, limit = PLANNING_TERMINAL_BRIDGE_TEXT_LIMIT): string {
  const normalized = oneLine(value);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function planningStatusLabel(status: InAppPlanningSessionStatus): string {
  switch (status) {
    case 'still_discussing':
      return 'still discussing';
    case 'waiting_for_answer':
      return 'waiting for answer';
    case 'draft_ready':
      return 'draft ready';
    case 'submitted':
      return 'submitted';
  }
}

function latestMessage(
  session: InAppPlanningChatSession,
  role: InAppPlanningChatLine['role'],
): InAppPlanningChatLine | undefined {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message?.role === role) return message;
  }
  return undefined;
}

function draftSummaryLine(summary: InAppPlanningPlanSummary): string {
  const workflowText = summary.workflowCount && summary.workflowCount > 1
    ? `${summary.workflowCount} workflows, `
    : '';
  const taskText = `${summary.taskCount} ${summary.taskCount === 1 ? 'task' : 'tasks'}`;
  const steps = summary.steps
    .slice(0, PLANNING_TERMINAL_BRIDGE_STEP_LIMIT)
    .map((step) => truncatedLine(step, 96))
    .filter(Boolean)
    .join('; ');
  return steps
    ? `${truncatedLine(summary.name, 96)} (${workflowText}${taskText}) - ${steps}`
    : `${truncatedLine(summary.name, 96)} (${workflowText}${taskText})`;
}

function planningNextActionLine(session: InAppPlanningChatSession): string {
  switch (session.status) {
    case 'still_discussing':
      return 'Next: Continue the planning chat to resolve the plan, or use this shell for repo inspection.';
    case 'waiting_for_answer':
      return 'Next: Answer the planner in chat, or inspect context here before replying.';
    case 'draft_ready':
      return 'Next: Review or submit the draft in chat; use this shell for manual context checks.';
    case 'submitted':
      return 'Next: Review the submitted workflow in Invoker; submitted planning sessions stay read-only.';
  }
}

export function buildPlanningTerminalSummaryBridge(session: InAppPlanningChatSession): string {
  const presetLabel = labelForPresetKey(session.presetKey);
  const latestUser = latestMessage(session, 'user');
  const latestAssistant = latestMessage(session, 'assistant');
  const lines = [
    PLANNING_TERMINAL_SUMMARY_BRIDGE_START,
    `Planning session: ${truncatedLine(session.title, 96)}`,
    `Status: ${planningStatusLabel(session.status)}`,
    `Preset: ${presetLabel} (${session.presetKey})`,
  ];

  if (latestUser) {
    lines.push(`Latest user: ${truncatedLine(latestUser.text)}`);
  }
  if (session.draftPlanSummary) {
    lines.push(`Draft plan: ${draftSummaryLine(session.draftPlanSummary)}`);
  } else if (latestAssistant) {
    lines.push(`Latest assistant: ${truncatedLine(latestAssistant.text)}`);
  }
  if (session.submittedPlanName || session.submittedWorkflowId) {
    const submittedName = session.submittedPlanName
      ? truncatedLine(session.submittedPlanName, 96)
      : 'unnamed plan';
    const workflowText = session.submittedWorkflowId
      ? ` (workflow ${session.submittedWorkflowId})`
      : '';
    lines.push(`Submitted plan: ${submittedName}${workflowText}`);
  }

  lines.push(planningNextActionLine(session), PLANNING_TERMINAL_SUMMARY_BRIDGE_END, '');
  return `${lines.join('\n')}\n`;
}

export function ensurePlanningTerminalSummaryBridge(
  session: InAppPlanningChatSession,
  outputSnapshot: string | null | undefined,
  maxLength?: number,
): string {
  const snapshot = outputSnapshot ?? '';
  const bridge = buildPlanningTerminalSummaryBridge(session);
  const startIndex = snapshot.indexOf(PLANNING_TERMINAL_SUMMARY_BRIDGE_START);
  let prefix = '';
  let suffix: string;
  if (startIndex === -1) {
    suffix = snapshot;
  } else {
    const endIndex = snapshot.indexOf(PLANNING_TERMINAL_SUMMARY_BRIDGE_END, startIndex);
    if (endIndex === -1) {
      return maxLength === undefined || snapshot.length <= maxLength
        ? snapshot
        : snapshot.slice(snapshot.length - maxLength);
    }
    const suffixStartIndex = endIndex + PLANNING_TERMINAL_SUMMARY_BRIDGE_END.length;
    prefix = snapshot.slice(0, startIndex);
    suffix = snapshot.slice(suffixStartIndex).replace(/^(?:\r?\n){1,2}/, '');
  }
  if (maxLength === undefined) {
    return `${prefix}${bridge}${suffix}`;
  }
  // Reserve room for the full bridge so a near-cap persisted snapshot can't push it
  // out immediately; trim the older raw output instead of the freshly composed bridge.
  const rest = `${prefix}${suffix}`;
  const keepableRestLength = Math.max(0, maxLength - bridge.length);
  const trimmedRest = trimPreservingEscapeSequences(rest, keepableRestLength);
  return `${bridge}${trimmedRest}`;
}

function titleFromMessage(message: string): string {
  const firstLine = message.split('\n', 1)[0]?.trim() ?? '';
  if (!firstLine) return 'Untitled plan';
  return firstLine.length > 56 ? `${firstLine.slice(0, 53).trimEnd()}…` : firstLine;
}
function normalizePlanningConfirmationMode(
  _value: string | null | undefined,
  _fallback: PlanningConfirmationMode = 'require',
): PlanningConfirmationMode {
  return 'require';
}

function resolveDefaultPlanningConfirmationMode(config: InvokerConfig): PlanningConfirmationMode {
  return normalizePlanningConfirmationMode(config.defaultPlanningTerminalConfirmationMode, 'require');
}

function extractPlanningConfirmationOverride(message: string): {
  message: string;
  confirmationMode?: PlanningConfirmationMode;
} {
  const match = /^\[auto-submit\]\s*/i.exec(message);
  if (!match) return { message };
  return {
    message: message.slice(match[0].length),
    confirmationMode: 'auto_submit',
  };
}

function appendSessionMessage(
  session: InAppPlanningChatSession,
  role: InAppPlanningChatLine['role'],
  text: string,
  tone?: InAppPlanningChatLine['tone'],
): void {
  const createdAt = new Date().toISOString();
  session.messages.push({
    id: session.nextMessageId,
    role,
    text,
    tone,
    createdAt,
  });
  session.nextMessageId += 1;
  session.updatedAt = createdAt;
}
function clearStarterPromptIfUnused(session: InAppPlanningChatSession): void {
  if (
    session.messages.length === 1
    && session.messages[0]?.role === 'system'
    && session.messages[0]?.tone === 'muted'
    && session.messages[0]?.text === 'Ask Invoker what you want to build.'
  ) {
    session.messages = [];
    session.nextMessageId = 1;
  }
}

function hasDraftPlan(session: Pick<InAppPlanningChatSession, 'draftPlanSummary' | 'draftPlanText'>): boolean {
  return Boolean(session.draftPlanText || session.draftPlanSummary);
}

function planningRepositoryContext(session: InAppPlanningChatSession): string {
  if (!session.repoUrl || !session.baseBranch) return '';
  return [
    'Current planning repository binding:',
    `- Default every workflow repoUrl to exactly: ${session.repoUrl}`,
    `- Default every workflow baseBranch to exactly: ${session.baseBranch}`,
    '- Only target another repository when the user explicitly asks for that repository.',
  ].join('\n');
}

async function silentRepoMismatch(
  session: InAppPlanningChatSession,
  planText: string,
): Promise<string | undefined> {
  if (!session.repoUrl) return undefined;
  const { parsePlanSubmissionBundle } = await import('./plan-parser.js');
  const submission = parsePlanSubmissionBundle(planText);
  const userText = session.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.text)
    .join('\n');
  return submission.plans
    .map((plan) => plan.repoUrl)
    .find((repoUrl): repoUrl is string => Boolean(
      repoUrl
      && repoUrl !== session.repoUrl
      && !userText.includes(repoUrl),
    ));
}

const NO_COMPLETE_PLAN_DRAFTED_ERROR = 'No complete plan drafted yet. Ask the AI to create a full plan, then submit again.';

function sessionToRecord(session: InAppPlanningChatSession, pendingResponse: boolean): InAppPlanningSessionRecord {
  return {
    id: session.id,
    title: session.title,
    presetKey: session.presetKey,
    status: session.status,
    confirmationMode: session.confirmationMode ?? 'require',
    repoUrl: session.repoUrl,
    baseBranch: session.baseBranch,
    baseCommit: session.baseCommit,
    worktreePath: session.worktreePath,
    worktreeBranch: session.worktreeBranch,
    messages: session.messages,
    draftPlanSummary: session.draftPlanSummary,
    draftPlanText: session.draftPlanText,
    submittedWorkflowId: session.submittedWorkflowId,
    submittedPlanName: session.submittedPlanName,
    terminalMode: session.terminalMode ?? 'chat',
    terminalSessionId: session.terminalSessionId,
    terminalStatus: session.terminalStatus,
    terminalExitCode: session.terminalExitCode,
    terminalOutputSnapshot: session.terminalOutputSnapshot ?? '',
    terminalUpdatedAt: session.terminalUpdatedAt,
    pendingResponse,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function hydrateRemotePlanningTerminalSession(summary: InAppPlanningSessionSummary): InAppPlanningChatSession {
  return {
    id: summary.id,
    title: summary.title,
    presetKey: summary.presetKey,
    repoUrl: summary.repoUrl,
    baseBranch: summary.baseBranch,
    baseCommit: summary.baseCommit,
    confirmationMode: summary.confirmationMode ?? 'require',
    status: summary.status,
    messages: summary.messages,
    conversation: null as unknown as PlanConversation,
    draftPlanSummary: summary.draftPlanSummary,
    submittedWorkflowId: summary.submittedWorkflowId,
    submittedPlanName: summary.submittedPlanName,
    terminalMode: summary.terminalMode,
    terminalSessionId: summary.terminalSessionId,
    terminalStatus: summary.terminalStatus,
    terminalExitCode: summary.terminalExitCode,
    terminalOutputSnapshot: summary.terminalOutputSnapshot,
    terminalUpdatedAt: summary.terminalUpdatedAt,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    nextMessageId: summary.messages.length + 1,
  };
}

function sessionToSummary(session: InAppPlanningChatSession): InAppPlanningSessionSummary {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    presetKey: session.presetKey,
    confirmationMode: session.confirmationMode ?? 'require',
    messages: session.messages,
    draftPlanAvailable: hasDraftPlan(session),
    draftPlanSummary: session.draftPlanSummary,
    draftPlanText: session.draftPlanText,
    repoUrl: session.repoUrl,
    baseBranch: session.baseBranch,
    baseCommit: session.baseCommit,
    submittedWorkflowId: session.submittedWorkflowId,
    submittedPlanName: session.submittedPlanName,
    terminalMode: session.terminalMode ?? 'chat',
    terminalSessionId: session.terminalSessionId,
    terminalStatus: session.terminalStatus,
    terminalExitCode: session.terminalExitCode,
    terminalOutputSnapshot: session.terminalOutputSnapshot ?? '',
    terminalUpdatedAt: session.terminalUpdatedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function assertPersistablePlanningSession(
  session: InAppPlanningChatSession,
  pendingResponse: boolean,
): void {
  if (session.status === 'draft_ready' && (!session.draftPlanSummary || !session.draftPlanText)) {
    throw new Error(`Planning session "${session.id}" is draft_ready without an approved draft.`);
  }
  if (session.status === 'submitted') {
    if (pendingResponse) {
      throw new Error(`Planning session "${session.id}" cannot stay pending after submission.`);
    }
    if (!session.submittedWorkflowId || !session.submittedPlanName) {
      throw new Error(`Planning session "${session.id}" is submitted without submission metadata.`);
    }
  }
}

function planDraftSidecarPath(sessionId: string): string {
  return join(resolveInvokerHomeRoot(), 'plan-drafts', `${sessionId}.yaml`);
}

function logPlanDraftSidecarError(sessionId: string, step: string, error: unknown): void {
  console.error(`[planning-chat] plan draft sidecar ${step} failed session="${sessionId}": ${
    error instanceof Error ? error.message : String(error)
  }`);
}

function writePlanDraftSidecar(sessionId: string, planText: string): void {
  try {
    const sidecarPath = planDraftSidecarPath(sessionId);
    mkdirSync(dirname(sidecarPath), { recursive: true });
    writeFileSync(sidecarPath, planText, 'utf8');
  } catch (error) {
    logPlanDraftSidecarError(sessionId, 'write', error);
  }
}

function removePlanDraftSidecarIfPresent(sessionId: string): void {
  try {
    rmSync(planDraftSidecarPath(sessionId), { force: true });
  } catch (error) {
    logPlanDraftSidecarError(sessionId, 'remove', error);
  }
}

function syncPlanDraftSidecar(session: Pick<InAppPlanningChatSession, 'id' | 'draftPlanText'>): void {
  if (session.draftPlanText && session.draftPlanText.trim()) {
    writePlanDraftSidecar(session.id, session.draftPlanText);
  } else {
    removePlanDraftSidecarIfPresent(session.id);
  }
}

function persistPlanningSession(
  session: InAppPlanningChatSession,
  store: InAppPlanningSessionStore | undefined,
  pendingResponse: boolean,
): void {
  if (!store) return;
  assertPersistablePlanningSession(session, pendingResponse);
  store.upsertInAppPlanningSession(sessionToRecord(session, pendingResponse));
  syncPlanDraftSidecar(session);
}

function saveOverrideConversation(
  repo: ConversationRepository | undefined,
  sessionId: string,
  formattedMessage: string,
  reply: string,
): void {
  if (!repo) return;
  const existing = repo.loadConversation(sessionId);
  const priorMessages: ConversationMessageEntry[] = existing?.messages.map((message) => ({
    role: message.role,
    content: message.content,
  })) ?? [];
  repo.saveConversation(
    sessionId,
    [
      ...priorMessages,
      { role: 'user', content: formattedMessage },
      { role: 'assistant', content: reply },
    ],
    null,
    false,
    undefined,
    undefined,
    'plan',
  );
}

export function hasExplicitDraftIntent(message: string): boolean {
  return hasCoreExplicitDraftIntent(message);
}

export function isDraftingAuthorizedByTurn(message: string, messagesBeforeTurn: InAppPlanningChatLine[]): boolean {
  const normalizedMessages: PlanningMessage[] = messagesBeforeTurn.map((entry) => ({
    role: entry.role,
    content: entry.text,
  }));
  return isDraftingAuthorized(message, normalizedMessages);
}

function planConversationConfig(
  preset: HarnessPreset,
  deps: Pick<InAppPlannerDeps, 'config' | 'workingDir' | 'planningCommandBuilder' | 'executionAgentRegistry' | 'conversationRepo' | 'logger' | 'onRawPlannerOutput' | 'planDoctorScriptPath'> & { mcpConfigPath?: string },
  threadTs: string,
  selectHarnessSessionDriver: PlannerSurfacesModule['selectHarnessSessionDriver'],
  options: { conversationalPlanning?: boolean; draftingPreauthorized?: boolean } = {},
): PlanConversationConfig {
  return {
    threadTs,
    conversationRepo: deps.conversationRepo,
    tool: preset.tool,
    model: preset.model,
    workingDir: deps.workingDir,
    timeoutMs: (deps.config.planningTimeoutSeconds ?? 7200) * 1000,
    defaultBranch: deps.config.defaultBranch,
    repoUrl: deps.config.defaultRepoUrl,
    experimentalPlanner: deps.config.experimentalPlanner,
    conversationalPlanning: options.conversationalPlanning ?? false,
    planningSurface: options.conversationalPlanning ? 'in_app' : undefined,
    draftingPreauthorized: options.draftingPreauthorized ?? false,
    preferStackedWorkflows: true,
    planningCommandBuilder: deps.planningCommandBuilder,
    harnessSessionDriver: selectHarnessSessionDriver(preset, {
      executionAgentRegistry: deps.executionAgentRegistry,
      planningCommandBuilder: deps.planningCommandBuilder,
      mcpConfigPath: deps.mcpConfigPath,
    }),
    plannerRetryLimit: deps.config.plannerRetryLimit,
    plannerRetryBaseDelayMs: deps.config.plannerRetryBaseDelayMs,
    planDoctorScriptPath: deps.planDoctorScriptPath,
    onRawPlannerOutput: deps.onRawPlannerOutput
      ? (chunk) => deps.onRawPlannerOutput?.({ sessionId: threadTs, chunk })
      : undefined,
    log: deps.logger
      ? (_source, level, message) => {
        if (level === 'error') deps.logger?.error(message, { module: 'planning-chat' });
        else if (level === 'warn') deps.logger?.warn(message, { module: 'planning-chat' });
        else deps.logger?.info(message, { module: 'planning-chat' });
      }
      : undefined,
  };
}

async function createSession(
  request: Partial<InAppPlanningCreateSessionRequest> | null | undefined,
  deps: InAppPlannerDeps & {
    sessions: InAppPlanningChatSessions;
    planningCommandBuilder: PlanningCommandBuilder;
    planningSessionStore?: InAppPlanningSessionStore;
    repoPool?: PlanningRepoPool;
  },
): Promise<InAppPlanningChatSession | { error: string }> {
  const presets = await resolveHarnessPresets(deps.config);
  const requestedPresetKey = typeof request?.presetKey === 'string' && request.presetKey
    ? request.presetKey
    : undefined;
  const presetKey = requestedPresetKey ?? await resolveDefaultPresetKey(deps.config);
  const preset = presets[presetKey];
  if (!preset) {
    return { error: `Unknown planner preset "${presetKey}".` };
  }

  const { PlanConversation, selectHarnessSessionDriver } = await loadPlannerSurfaces();
  const createdAt = new Date().toISOString();
  const id = randomUUID();
  const confirmationMode = normalizePlanningConfirmationMode(
    request?.confirmationMode,
    resolveDefaultPlanningConfirmationMode(deps.config),
  );

  const repoBinding = request?.repoBinding ?? resolvePlanningRepoBinding(deps.config);
  const session: InAppPlanningChatSession = {
    id,
    title: typeof request?.title === 'string' && request.title.trim() ? request.title.trim() : 'Untitled plan',
    presetKey,
    confirmationMode,
    status: 'still_discussing',
    messages: [],
    conversation: new PlanConversation(planConversationConfig(preset, deps, id, selectHarnessSessionDriver, { conversationalPlanning: true })),
    repoUrl: repoBinding?.repoUrl,
    baseBranch: repoBinding?.baseBranch,
    createdAt,
    updatedAt: createdAt,
    nextMessageId: 1,
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
  };
  deps.sessions.set(session.id, session);
  persistPlanningSession(session, deps.planningSessionStore, false);
  return session;
}

export function resolvePlanningRepoBinding(config: InvokerConfig): InAppPlanningRepoBinding | undefined {
  const repoUrl = config.defaultRepoUrl?.trim();
  if (!repoUrl) return undefined;
  return { repoUrl, baseBranch: config.defaultBranch ?? 'main' };
}

async function activatePlanningSessionWorktree(
  session: InAppPlanningChatSession,
  deps: InAppPlannerDeps & { repoPool?: PlanningRepoPool },
): Promise<boolean> {
  if (!deps.repoPool || !session.repoUrl || !session.baseBranch || session.worktreePath) return false;

  const provisioned = await provisionPlanningWorktree(deps.repoPool, {
    repoUrl: session.repoUrl,
    baseBranch: session.baseBranch,
    sessionId: session.id,
  });
  const presets = await resolveHarnessPresets(deps.config);
  const preset = presets[session.presetKey];
  if (!preset) throw new Error(`Unknown planner preset "${session.presetKey}".`);
  const { PlanConversation, selectHarnessSessionDriver } = await loadPlannerSurfaces();
  const conversationDeps = {
    ...deps,
    workingDir: provisioned.worktreePath,
    mcpConfigPath: planningMcpConfigPath(provisioned.worktreePath),
  };

  session.baseCommit = provisioned.baseCommit;
  session.worktreePath = provisioned.worktreePath;
  session.worktreeBranch = provisioned.branch;
  session.conversation = new PlanConversation(planConversationConfig(
    preset,
    conversationDeps,
    session.id,
    selectHarnessSessionDriver,
    { conversationalPlanning: true },
  ));
  return true;
}

export async function listInAppPlanningPresets(config: InvokerConfig): Promise<PlanningPresetOption[]> {
  const presets = await resolveHarnessPresets(config);
  const defaultPresetKey = await resolveDefaultPresetKey(config);
  const defaultConfirmationMode = resolveDefaultPlanningConfirmationMode(config);
  return Object.entries(presets).map(([key, preset]) => ({
    key,
    label: labelForPresetKey(key),
    tool: preset.tool,
    model: preset.model,
    isDefault: key === defaultPresetKey,
    defaultConfirmationMode,
  }));
}

export function createPlanningCommandBuilderFromRegistry(
  registry: Pick<AgentRegistry, 'getPlanningOrThrow'>,
): PlanningCommandBuilder {
  return (opts) => registry.getPlanningOrThrow(opts.tool).buildPlanningCommand(opts.prompt, { model: opts.model });
}

export async function planFromGoal(
  request: InAppPlanRequest,
  deps: InAppPlannerDeps,
): Promise<InAppPlanResponse> {
  const rawRequest = request as Partial<InAppPlanRequest> | null | undefined;
  const goal = typeof rawRequest?.goal === 'string' ? rawRequest.goal.trim() : '';
  if (!goal) {
    return { ok: false, error: 'Describe a goal first.' };
  }

  const presets = await resolveHarnessPresets(deps.config);
  const presetKey = request.presetKey ?? await resolveDefaultPresetKey(deps.config);
  const preset = presets[presetKey];
  if (!preset) {
    return { ok: false, error: `Unknown planner preset "${presetKey}".` };
  }

  try {
    const { PlanConversation, extractYamlPlan, selectHarnessSessionDriver } = await loadPlannerSurfaces();
    const conversation = new PlanConversation(planConversationConfig(preset, deps, randomUUID(), selectHarnessSessionDriver, { conversationalPlanning: true, draftingPreauthorized: true }));
    const plannerOutput = await conversation.sendMessage(goal);
    const planText = conversation.lastTurnDraftPlanText ?? extractYamlPlan(plannerOutput);
    if (!planText) {
      return { ok: false, error: 'Planner did not return a valid YAML plan.' };
    }

    const loaded = await deps.loadGeneratedPlan(planText);
    return {
      ok: true,
      planName: loaded.planName,
      workflowId: loaded.workflowId,
      workflowIds: loaded.workflowIds,
      workflowCount: loaded.workflowCount,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createPlanningChatSession(
  request: InAppPlanningCreateSessionRequest | undefined,
  deps: InAppPlannerDeps & {
    sessions: InAppPlanningChatSessions;
    planningCommandBuilder: PlanningCommandBuilder;
    planningSessionStore?: InAppPlanningSessionStore;
    repoPool?: PlanningRepoPool;
  },
): Promise<InAppPlanningCreateSessionResponse> {
  try {
    const session = await createSession(request, deps);
    if ('error' in session) {
      return { ok: false, error: session.error };
    }
    return { ok: true, session: sessionToSummary(session) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function listPlanningChatSessions(
  deps: { sessions: InAppPlanningChatSessions; config: InvokerConfig },
): InAppPlanningListSessionsResponse {
  const sessions = [...deps.sessions.values()]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map(sessionToSummary);
  return { ok: true, sessions, repoBinding: resolvePlanningRepoBinding(deps.config) };
}

export async function sendPlanningChatMessage(
  request: InAppPlanningChatRequest,
  deps: InAppPlannerDeps & {
    sessions: InAppPlanningChatSessions;
    planningCommandBuilder: PlanningCommandBuilder;
    planningSessionStore?: InAppPlanningSessionStore;
    repoPool?: PlanningRepoPool;
  },
): Promise<InAppPlanningChatResponse> {
  const rawRequest = request as Partial<InAppPlanningChatRequest> | null | undefined;
  const rawMessage = typeof rawRequest?.message === 'string' ? rawRequest.message.trim() : '';
  const taggedMessage = extractPlanningConfirmationOverride(rawMessage);
  const message = taggedMessage.message.trim();
  const requestedConfirmationMode = normalizePlanningConfirmationMode(
    taggedMessage.confirmationMode ?? rawRequest?.confirmationMode,
    resolveDefaultPlanningConfirmationMode(deps.config),
  );
  if (!message) {
    return { ok: false, sessionId: rawRequest?.sessionId, error: 'Type a message first.' };
  }

  const suppliedSessionId = typeof rawRequest?.sessionId === 'string'
    ? rawRequest.sessionId
    : undefined;
  let sessionId = suppliedSessionId;
  try {
    let session = suppliedSessionId === undefined
      ? undefined
      : deps.sessions.get(suppliedSessionId);
    if (suppliedSessionId !== undefined && !session) {
      return {
        ok: false,
        sessionId: suppliedSessionId,
        error: `Planning session "${suppliedSessionId}" was not found.`,
      };
    }
    if (!session) {
      const created = await createSession({
        presetKey: rawRequest?.presetKey,
        title: titleFromMessage(message),
        confirmationMode: requestedConfirmationMode,
        repoBinding: rawRequest?.repoBinding,
      }, deps);
      if ('error' in created) {
        return { ok: false, sessionId, error: created.error };
      }
      session = created;
      sessionId = session.id;
    }
    if (session.status === 'submitted') {
      return { ok: false, sessionId: session.id, error: 'This planning session was already submitted. Start a new planning chat for changes.' };
    }

    const activeSession = session;
    activeSession.confirmationMode = requestedConfirmationMode;
    const previousSend = activeSession.pendingSend ?? Promise.resolve();
    const turn = previousSend.then(async (): Promise<InAppPlanningChatResponse> => {
      clearStarterPromptIfUnused(activeSession);
      const messagesBeforeTurn: PlanningMessage[] = activeSession.messages.map((entry) => ({
        role: entry.role,
        content: entry.text,
      }));
      appendSessionMessage(activeSession, 'user', message);
      if (activeSession.title === 'Untitled plan') {
        activeSession.title = titleFromMessage(message);
      }
      persistPlanningSession(activeSession, deps.planningSessionStore, true);

      try {
        const activatedWorktree = await activatePlanningSessionWorktree(activeSession, deps);
        persistPlanningSession(activeSession, deps.planningSessionStore, false);
        const repositoryContext = planningRepositoryContext(activeSession);
        const hostedMessage = [repositoryContext, formatPlanningHostedTurn('in_app', message)]
          .filter(Boolean)
          .join('\n\n');
        if (!activatedWorktree && deps.repoPool && activeSession.worktreePath && activeSession.repoUrl && activeSession.baseCommit) {
          try {
            await ensurePlanningWorktreeReady(deps.repoPool, {
              repoUrl: activeSession.repoUrl,
              baseCommit: activeSession.baseCommit,
              sessionId: activeSession.id,
              worktreePath: activeSession.worktreePath,
            });
          } catch (error) {
            logPlanningWorktreeReadyError(activeSession.id, 'before-send', error);
          }
        }
        const reply = deps.plannerReplyOverride
          ? await deps.plannerReplyOverride(hostedMessage)
          : await activeSession.conversation.sendMessage(message);
        if (deps.plannerReplyOverride) {
          saveOverrideConversation(deps.conversationRepo, activeSession.id, message, reply);
        }
        const reasoningParts = deps.plannerReplyOverride
          ? []
          : activeSession.conversation.lastTurnReasoning;
        const reasoning = reasoningParts.length > 0 ? reasoningParts.join('\n\n') : undefined;
        const immediateDraftPlanText = deps.plannerReplyOverride
          ? extractFencedYamlPlanText(reply)
          : activeSession.conversation.lastTurnDraftPlanText;
        const result = evaluatePlanningTurn({
          userMessage: message,
          messagesBeforeTurn,
          assistantReply: reply,
          immediateDraftPlanText,
          requireDraftAuthorization: hasDraftPlan(activeSession) || !immediateDraftPlanText,
          hasExistingDraft: hasDraftPlan(activeSession),
        });
        if (result.kind === 'message') {
          activeSession.status = hasDraftPlan(activeSession)
            ? 'draft_ready'
            : result.status;
          appendSessionMessage(activeSession, 'assistant', reply);
          persistPlanningSession(activeSession, deps.planningSessionStore, false);
          return {
            ok: true,
            sessionId: activeSession.id,
            reply,
            reasoning,
            confirmationMode: activeSession.confirmationMode,
            draftPlanAvailable: hasDraftPlan(activeSession),
            draftPlanSummary: activeSession.draftPlanSummary,
            draftPlanText: activeSession.draftPlanText,
          } as InAppPlanningChatResponse;
        }

        const review = preparePlanningReview({
          plannerOutput: reply,
          extractDraftPlanText: () => result.planText,
          confirmationMode: activeSession.confirmationMode,
        });
        if ('kind' in review) {
          activeSession.status = hasDraftPlan(activeSession)
            ? 'draft_ready'
            : 'still_discussing';
          appendSessionMessage(activeSession, 'assistant', review.reply);
          persistPlanningSession(activeSession, deps.planningSessionStore, false);
          return {
            ok: true,
            sessionId: activeSession.id,
            reply: review.reply,
            reasoning,
            confirmationMode: activeSession.confirmationMode,
            draftPlanAvailable: hasDraftPlan(activeSession),
            draftPlanSummary: activeSession.draftPlanSummary,
            draftPlanText: activeSession.draftPlanText,
          } as InAppPlanningChatResponse;
        }

        const mismatchedRepoUrl = await silentRepoMismatch(activeSession, review.planText);
        if (mismatchedRepoUrl) {
          const mismatchReply = `Draft rejected because it silently changed repositories to ${mismatchedRepoUrl}. `
            + `This planning session is bound to ${activeSession.repoUrl}. Name a different repository explicitly if that is intentional.`;
          removePlanDraftSidecarIfPresent(activeSession.id);
          activeSession.status = 'still_discussing';
          appendSessionMessage(activeSession, 'assistant', mismatchReply);
          persistPlanningSession(activeSession, deps.planningSessionStore, false);
          return {
            ok: true,
            sessionId: activeSession.id,
            reply: mismatchReply,
            reasoning,
            confirmationMode: activeSession.confirmationMode,
            draftPlanAvailable: false,
          } as InAppPlanningChatResponse;
        }

        activeSession.draftPlanSummary = review.summary;
        activeSession.draftPlanText = review.planText;
        activeSession.status = 'draft_ready';
        appendSessionMessage(activeSession, 'assistant', reply);
        persistPlanningSession(activeSession, deps.planningSessionStore, false);
        return {
          ok: true,
          sessionId: activeSession.id,
          reply,
          reasoning,
          confirmationMode: activeSession.confirmationMode,
          draftPlanAvailable: true,
          draftPlanSummary: review.summary,
          draftPlanText: review.planText,
        } as InAppPlanningChatResponse;
      } catch (error) {
        persistPlanningSession(activeSession, deps.planningSessionStore, false);
        return {
          ok: false,
          sessionId: activeSession.id,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    activeSession.pendingSend = turn.then(() => undefined, () => undefined);
    return await turn;
  } catch (error) {
    return {
      ok: false,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function submitPlanningChatDraft(
  request: InAppPlanningSubmitRequest,
  deps: {
    sessions: InAppPlanningChatSessions;
    loadGeneratedPlan: (planText: string) => LoadedGeneratedPlan | Promise<LoadedGeneratedPlan>;
    planningSessionStore?: InAppPlanningSessionStore;
  },
): Promise<InAppPlanningSubmitResponse> {
  const rawRequest = request as Partial<InAppPlanningSubmitRequest> | null | undefined;
  const sessionId = typeof rawRequest?.sessionId === 'string' ? rawRequest.sessionId.trim() : '';
  const session = sessionId ? deps.sessions.get(sessionId) : undefined;
  if (!session) {
    return { ok: false, error: 'No planning conversation yet.' };
  }
  if (session.status === 'submitted') {
    return { ok: false, error: 'This planning session was already submitted.' };
  }
  if (session.status !== 'draft_ready' || !session.draftPlanText?.trim()) {
    return { ok: false, error: NO_COMPLETE_PLAN_DRAFTED_ERROR };
  }
  if (session.pendingSubmit) {
    return session.pendingSubmit;
  }

  const submitAttempt = (async (): Promise<InAppPlanningSubmitResponse> => {
    try {
      const approved = await submitPlanningReview({
        planText: session.draftPlanText,
        loadPlan: deps.loadGeneratedPlan,
      });
      if (!approved.ok) {
        return approved;
      }
      session.status = 'submitted';
      session.submittedPlanName = approved.planName;
      session.submittedWorkflowId = approved.workflowId;
      session.updatedAt = new Date().toISOString();
      appendSessionMessage(
        session,
        'system',
        approved.workflowCount && approved.workflowCount > 1
          ? `Plan "${approved.planName}" submitted as ${approved.workflowCount} stacked workflows.`
          : `Plan "${approved.planName}" submitted to Invoker.`,
        'success',
      );
      persistPlanningSession(session, deps.planningSessionStore, false);
      return {
        ok: true,
        planName: approved.planName,
        workflowId: approved.workflowId,
        workflowIds: approved.workflowIds,
        workflowCount: approved.workflowCount,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      session.pendingSubmit = undefined;
    }
  })();
  session.pendingSubmit = submitAttempt;
  return submitAttempt;
}

export function discardPlanningChatDraft(
  request: InAppPlanningDiscardDraftRequest,
  deps: { sessions: InAppPlanningChatSessions; planningSessionStore?: InAppPlanningSessionStore },
): InAppPlanningDiscardDraftResponse {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : '';
  const session = sessionId ? deps.sessions.get(sessionId) : undefined;
  if (!session) {
    return { ok: false, error: 'No planning conversation yet.' };
  }
  if (!hasDraftPlan(session)) {
    return { ok: false, error: 'No saved draft to discard.' };
  }
  if (session.status === 'submitted') {
    return { ok: false, error: 'This planning session was already submitted.' };
  }
  session.status = 'still_discussing';
  session.draftPlanSummary = undefined;
  session.draftPlanText = undefined;
  appendSessionMessage(session, 'system', 'Draft discarded. Ask Invoker to draft it again.');
  persistPlanningSession(session, deps.planningSessionStore, false);
  return { ok: true };
}

export function resetPlanningChat(
  request: InAppPlanningResetRequest,
  deps: { sessions: InAppPlanningChatSessions; planningSessionStore?: InAppPlanningSessionStore },
): InAppPlanningResetResponse {
  deps.sessions.delete(request.sessionId);
  deps.planningSessionStore?.deleteInAppPlanningSession(request.sessionId);
  return { ok: true };
}

export function setPlanningChatTerminalMode(
  request: InAppPlanningSetTerminalModeRequest,
  deps: { sessions: InAppPlanningChatSessions; planningSessionStore?: InAppPlanningSessionStore },
): InAppPlanningSetTerminalModeResponse {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : '';
  const session = sessionId ? deps.sessions.get(sessionId) : undefined;
  if (!session) {
    return { ok: false, error: 'No planning conversation yet.' };
  }
  if (request.mode !== 'chat' && request.mode !== 'tmux') {
    return { ok: false, error: 'Unknown planning terminal mode.' };
  }

  const updatedAt = new Date().toISOString();
  session.terminalMode = request.mode;
  session.updatedAt = updatedAt;
  deps.planningSessionStore?.updateInAppPlanningSession(session.id, {
    terminalMode: request.mode,
    updatedAt,
  });
  return { ok: true };
}

export async function rebindPlanningChatRepo(
  request: InAppPlanningRebindRepoRequest,
  deps: {
    config: InvokerConfig;
    sessions: InAppPlanningChatSessions;
    planningSessionStore?: InAppPlanningSessionStore;
    repoPool?: PlanningRepoPool;
    workingDir?: string;
    planDoctorScriptPath?: string;
  },
): Promise<InAppPlanningRebindRepoResponse> {
  const rawRequest = request as Partial<InAppPlanningRebindRepoRequest> | null | undefined;
  const sessionId = typeof rawRequest?.sessionId === 'string' ? rawRequest.sessionId.trim() : '';
  const session = sessionId ? deps.sessions.get(sessionId) : undefined;
  if (!session) {
    return { ok: false, error: 'No planning conversation yet.' };
  }
  if (session.status === 'submitted') {
    return { ok: false, error: 'This planning session was already submitted. Start a new planning chat for changes.' };
  }
  if (!deps.repoPool) {
    return { ok: false, error: 'Worktree provisioning is not available.' };
  }
  const repoPool = deps.repoPool;

  const requestedRepoUrl = rawRequest?.repoUrl?.trim() || deps.config.defaultRepoUrl;
  if (!requestedRepoUrl) {
    return { ok: false, error: 'No repository specified.' };
  }
  const requestedBaseBranch = rawRequest?.baseBranch?.trim() || deps.config.defaultBranch || 'main';

  try {
    await repoPool.ensureCloneThroughRepoQueue(requestedRepoUrl);
    const requestedHeadSha = await repoPool.resolveBaseCommit(requestedRepoUrl, requestedBaseBranch);

    const decision = decideWorktreeBinding({
      storedRepoUrl: session.repoUrl,
      storedHeadSha: session.baseCommit,
      requestedRepoUrl,
      requestedHeadSha,
      hasDraft: hasDraftPlan(session),
    });

    if (decision.action === 'reuse') {
      return { ok: true, action: 'reuse' };
    }

    if (session.repoUrl && session.baseCommit && session.worktreePath) {
      try {
        await releasePlanningWorktree(repoPool, {
          repoUrl: session.repoUrl,
          baseCommit: session.baseCommit,
          sessionId: session.id,
        });
      } catch (error) {
        logPlanningWorktreeReadyError(session.id, 'rebind-release', error);
      }
    }

    const provisioned = await provisionPlanningWorktree(repoPool, {
      repoUrl: requestedRepoUrl,
      baseBranch: requestedBaseBranch,
      sessionId: session.id,
    });

    const presets = await resolveHarnessPresets(deps.config);
    const preset = presets[session.presetKey];
    if (!preset) {
      return { ok: false, error: `Unknown planner preset "${session.presetKey}".` };
    }
    const { PlanConversation, selectHarnessSessionDriver } = await loadPlannerSurfaces();
    const conversationDeps = {
      ...deps,
      planDoctorScriptPath: deps.planDoctorScriptPath,
      workingDir: provisioned.worktreePath,
      mcpConfigPath: planningMcpConfigPath(provisioned.worktreePath),
    };
    const conversation = new PlanConversation(planConversationConfig(
      preset,
      conversationDeps,
      session.id,
      selectHarnessSessionDriver,
      { conversationalPlanning: true },
    ));
    await conversation.init();

    session.repoUrl = requestedRepoUrl;
    session.baseBranch = requestedBaseBranch;
    session.baseCommit = provisioned.baseCommit;
    session.worktreePath = provisioned.worktreePath;
    session.worktreeBranch = provisioned.branch;
    session.conversation = conversation;

    if (decision.action === 'invalidate_and_block_submit') {
      session.draftPlanSummary = undefined;
      session.draftPlanText = undefined;
      if (session.status === 'draft_ready') {
        session.status = 'still_discussing';
      }
      appendSessionMessage(
        session,
        'system',
        'The target repository changed. The previous draft was cleared — ask Invoker to draft it again.',
        'error',
      );
    }

    persistPlanningSession(session, deps.planningSessionStore, false);
    return { ok: true, action: decision.action };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface PlanningChatTerminalStatePatch {
  terminalMode?: PlanningTerminalMode;
  terminalSessionId?: string;
  terminalStatus?: 'running' | 'exited';
  terminalExitCode?: number;
  terminalOutputSnapshot?: string;
  terminalUpdatedAt?: string;
  touchSessionUpdatedAt?: boolean;
}

export function updatePlanningChatTerminalState(
  sessionId: string,
  patch: PlanningChatTerminalStatePatch,
  deps: { sessions: InAppPlanningChatSessions; planningSessionStore?: InAppPlanningSessionStore },
): boolean {
  const session = deps.sessions.get(sessionId);
  if (!session) return false;

  const terminalUpdatedAt = patch.terminalUpdatedAt ?? new Date().toISOString();
  const storePatch: InAppPlanningSessionPatch = { terminalUpdatedAt };
  if (Object.hasOwn(patch, 'terminalMode')) {
    session.terminalMode = patch.terminalMode;
    storePatch.terminalMode = patch.terminalMode;
  }
  if (Object.hasOwn(patch, 'terminalSessionId')) {
    session.terminalSessionId = patch.terminalSessionId;
    storePatch.terminalSessionId = patch.terminalSessionId;
  }
  if (Object.hasOwn(patch, 'terminalStatus')) {
    session.terminalStatus = patch.terminalStatus;
    storePatch.terminalStatus = patch.terminalStatus;
  }
  if (Object.hasOwn(patch, 'terminalExitCode')) {
    session.terminalExitCode = patch.terminalExitCode;
    storePatch.terminalExitCode = patch.terminalExitCode;
  }
  if (Object.hasOwn(patch, 'terminalOutputSnapshot')) {
    session.terminalOutputSnapshot = patch.terminalOutputSnapshot;
    storePatch.terminalOutputSnapshot = patch.terminalOutputSnapshot;
  }
  session.terminalUpdatedAt = terminalUpdatedAt;
  if (patch.touchSessionUpdatedAt) {
    session.updatedAt = terminalUpdatedAt;
    storePatch.updatedAt = terminalUpdatedAt;
  }
  deps.planningSessionStore?.updateInAppPlanningSession(session.id, storePatch);
  return true;
}

export async function restorePlanningChatSessions(
  records: InAppPlanningSessionRecord[],
  deps: InAppPlannerDeps & {
    sessions: InAppPlanningChatSessions;
    planningCommandBuilder: PlanningCommandBuilder;
    planningSessionStore?: InAppPlanningSessionStore;
    repoPool?: PlanningRepoPool;
  },
): Promise<void> {
  // Nothing persisted → skip loading @invoker/surfaces. The built required-fast CI app
  // boots without surfaces/dist, so an eager load here would crash startup with no sessions.
  if (records.length === 0) return;
  const presets = await resolveHarnessPresets(deps.config);
  const { PlanConversation, selectHarnessSessionDriver } = await loadPlannerSurfaces();

  for (const record of records) {
    const preset = presets[record.presetKey];
    if (!preset) continue;

    let restoredWorktreePath: string | undefined;
    if (deps.repoPool && record.worktreePath && record.repoUrl && record.baseCommit) {
      try {
        const ready = await ensurePlanningWorktreeReady(deps.repoPool, {
          repoUrl: record.repoUrl,
          baseCommit: record.baseCommit,
          sessionId: record.id,
          worktreePath: record.worktreePath,
        });
        restoredWorktreePath = ready.worktreePath;
      } catch (error) {
        logPlanningWorktreeReadyError(record.id, 'restore', error);
      }
    }
    const conversationDeps = restoredWorktreePath
      ? {
          ...deps,
          planDoctorScriptPath: deps.planDoctorScriptPath,
          workingDir: restoredWorktreePath,
          mcpConfigPath: planningMcpConfigPath(restoredWorktreePath),
        }
      : deps;

    const conversation = new PlanConversation(planConversationConfig(preset, conversationDeps, record.id, selectHarnessSessionDriver, { conversationalPlanning: true }));
    await conversation.init();

    const nextMessageId = Math.max(0, ...record.messages.map((message) => message.id)) + 1;
    const session: InAppPlanningChatSession = {
      id: record.id,
      title: record.title,
      presetKey: record.presetKey,
      confirmationMode: normalizePlanningConfirmationMode(record.confirmationMode, resolveDefaultPlanningConfirmationMode(deps.config)),
      status: record.status,
      messages: [...record.messages],
      conversation,
      repoUrl: record.repoUrl,
      baseBranch: record.baseBranch,
      baseCommit: record.baseCommit,
      worktreePath: restoredWorktreePath ?? record.worktreePath,
      worktreeBranch: record.worktreeBranch,
      draftPlanSummary: record.draftPlanSummary,
      draftPlanText: record.draftPlanText,
      submittedWorkflowId: record.submittedWorkflowId,
      submittedPlanName: record.submittedPlanName,
      terminalMode: record.terminalMode ?? 'chat',
      terminalSessionId: record.terminalSessionId,
      terminalStatus: record.terminalStatus,
      terminalExitCode: record.terminalExitCode,
      terminalOutputSnapshot: record.terminalOutputSnapshot ?? '',
      terminalUpdatedAt: record.terminalUpdatedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      nextMessageId,
    };

    let shouldPersist = false;
    if (record.pendingResponse) {
      if (record.status !== 'submitted') {
        appendSessionMessage(
          session,
          'system',
          'Planner was interrupted before it could answer. Send another message to continue.',
          'error',
        );
      }
      shouldPersist = true;
    }

    if (session.status === 'draft_ready') {
      if (!session.draftPlanText) {
        session.status = 'still_discussing';
        session.draftPlanSummary = undefined;
        appendSessionMessage(
          session,
          'system',
          'The saved draft could not be restored. Ask the planner to draft it again.',
          'error',
        );
        shouldPersist = true;
      } else if (!session.draftPlanSummary) {
        const restoredSummary = summarizePlanText(session.draftPlanText);
        if (!restoredSummary) {
          session.status = 'still_discussing';
          session.draftPlanSummary = undefined;
          session.draftPlanText = undefined;
          appendSessionMessage(
            session,
            'system',
            'The saved draft could not be restored. Ask the planner to draft it again.',
            'error',
          );
        } else {
          session.draftPlanSummary = restoredSummary;
        }
        shouldPersist = true;
      }
    }

    deps.sessions.set(session.id, session);
    syncPlanDraftSidecar(session);
    if (shouldPersist) {
      persistPlanningSession(session, deps.planningSessionStore, false);
    }
  }
}

interface PlanningChatDeleteLogger {
  error(message: string, context?: Record<string, unknown>): void;
}

export interface PlanningChatDeleteDeps {
  sessions: InAppPlanningChatSessions;
  planningSessionStore?: Pick<InAppPlanningSessionStore, 'deleteInAppPlanningSession'>;
  conversationRepo?: Pick<ConversationRepository, 'deleteConversation'>;
  closeTerminal?: (terminalSessionId: string) => void;
  logger?: PlanningChatDeleteLogger;
}

function logPlanningChatDeleteError(
  deps: Pick<PlanningChatDeleteDeps, 'logger'>,
  sessionId: string,
  step: string,
  error: unknown,
): void {
  const message = `delete planning chat failed session="${sessionId}" step="${step}": ${
    error instanceof Error ? error.message : String(error)
  }`;
  if (deps.logger) {
    deps.logger.error(message, { module: 'planning-chat' });
    return;
  }
  console.error(`[planning-chat] ${message}`);
}

function runPlanningChatDeleteStep(
  deps: Pick<PlanningChatDeleteDeps, 'logger'>,
  sessionId: string,
  step: string,
  cleanup: () => void,
): void {
  try {
    cleanup();
  } catch (error) {
    logPlanningChatDeleteError(deps, sessionId, step, error);
  }
}

function cleanupPlanningChatSession(
  sessionId: string,
  session: InAppPlanningChatSession | undefined,
  deps: PlanningChatDeleteDeps,
): void {
  const terminalSessionId = session?.terminalSessionId;
  if (terminalSessionId) {
    runPlanningChatDeleteStep(deps, sessionId, 'close-terminal', () => {
      deps.closeTerminal?.(terminalSessionId);
    });
  }

  runPlanningChatDeleteStep(deps, sessionId, 'delete-memory-session', () => {
    deps.sessions.delete(sessionId);
  });
  runPlanningChatDeleteStep(deps, sessionId, 'delete-persisted-planning-session', () => {
    deps.planningSessionStore?.deleteInAppPlanningSession(sessionId);
  });
  runPlanningChatDeleteStep(deps, sessionId, 'delete-override-conversation', () => {
    deps.conversationRepo?.deleteConversation(sessionId);
  });
}

export function deletePlanningChat(
  request: InAppPlanningDeleteRequest,
  deps: PlanningChatDeleteDeps,
): InAppPlanningDeleteResponse {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : '';
  if (!sessionId) {
    return { ok: false, error: 'Planning session id is required.' };
  }

  cleanupPlanningChatSession(sessionId, deps.sessions.get(sessionId), deps);
  return { ok: true };
}

export function deleteSubmittedPlanningChats(
  deps: PlanningChatDeleteDeps,
): InAppPlanningDeleteSubmittedResponse {
  const submittedSessions = [...deps.sessions.values()]
    .filter((session) => session.status === 'submitted')
    .map((session) => ({ id: session.id, session }));
  const deletedSessionIds = submittedSessions.map(({ id }) => id);

  for (const { id, session } of submittedSessions) {
    cleanupPlanningChatSession(id, session, deps);
  }

  return { ok: true, deletedSessionIds };
}
