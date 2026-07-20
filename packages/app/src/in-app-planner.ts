import { randomUUID } from 'node:crypto';
import type {
  InAppPlanRequest,
  InAppPlanResponse,
  InAppPlanningChatLine,
  InAppPlanningChatRequest,
  InAppPlanningChatResponse,
  InAppPlanningCreateSessionRequest,
  InAppPlanningCreateSessionResponse,
  InAppPlanningListSessionsResponse,
  InAppPlanningPlanSummary,
  InAppPlanningResetRequest,
  InAppPlanningResetResponse,
  InAppPlanningSetTerminalModeRequest,
  InAppPlanningSetTerminalModeResponse,
  InAppPlanningSessionStatus,
  InAppPlanningSessionSummary,
  InAppPlanningStreamEvent,
  InAppPlanningSubmitRequest,
  InAppPlanningSubmitResponse,
  PlanningTerminalMode,
  PlanningPresetOption,
} from '@invoker/contracts';
import type {
  ConversationMessageEntry,
  ConversationRepository,
  InAppPlanningSessionPatch,
  InAppPlanningSessionRecord,
} from '@invoker/data-store';
import type { AgentRegistry } from '@invoker/execution-engine';
import type { HarnessPreset, PlanConversation, PlanConversationConfig, PlanningCommandBuilder } from '@invoker/surfaces';
import type { InvokerConfig } from './config.js';

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
  conversationRepo?: ConversationRepository;
  plannerReplyOverride?: (formattedMessage: string) => Promise<string>;
  onRawPlannerOutput?: (event: InAppPlanningStreamEvent) => void;
}

export interface InAppPlanningChatSession {
  id: string;
  title: string;
  presetKey: string;
  status: InAppPlanningSessionStatus;
  messages: InAppPlanningChatLine[];
  conversation: PlanConversation;
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
  summarizePlanText: (planText: string) => InAppPlanningPlanSummary | null;
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
  return value.replace(/\s+/g, ' ').trim();
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
): string {
  const snapshot = outputSnapshot ?? '';
  const bridge = buildPlanningTerminalSummaryBridge(session);
  const startIndex = snapshot.indexOf(PLANNING_TERMINAL_SUMMARY_BRIDGE_START);
  if (startIndex === -1) {
    return `${bridge}${snapshot}`;
  }
  const endIndex = snapshot.indexOf(PLANNING_TERMINAL_SUMMARY_BRIDGE_END, startIndex);
  if (endIndex === -1) {
    return snapshot;
  }
  const suffixStartIndex = endIndex + PLANNING_TERMINAL_SUMMARY_BRIDGE_END.length;
  const prefix = snapshot.slice(0, startIndex);
  const suffix = snapshot.slice(suffixStartIndex).replace(/^(?:\r?\n){1,2}/, '');
  return `${prefix}${bridge}${suffix}`;
}

function titleFromMessage(message: string): string {
  const firstLine = message.split('\n', 1)[0]?.trim() ?? '';
  if (!firstLine) return 'Untitled plan';
  return firstLine.length > 56 ? `${firstLine.slice(0, 53).trimEnd()}…` : firstLine;
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

function sessionToRecord(session: InAppPlanningChatSession, pendingResponse: boolean): InAppPlanningSessionRecord {
  return {
    id: session.id,
    title: session.title,
    presetKey: session.presetKey,
    status: session.status,
    messages: session.messages,
    draftPlanSummary: session.draftPlanSummary,
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

function sessionToSummary(session: InAppPlanningChatSession): InAppPlanningSessionSummary {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    presetKey: session.presetKey,
    messages: session.messages,
    draftPlanAvailable: Boolean(session.draftPlanSummary),
    draftPlanSummary: session.draftPlanSummary,
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
  if (session.status === 'draft_ready' && !session.draftPlanSummary) {
    throw new Error(`Planning session "${session.id}" is draft_ready without a draft summary.`);
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

function persistPlanningSession(
  session: InAppPlanningChatSession,
  store: InAppPlanningSessionStore | undefined,
  pendingResponse: boolean,
): void {
  if (!store) return;
  assertPersistablePlanningSession(session, pendingResponse);
  store.upsertInAppPlanningSession(sessionToRecord(session, pendingResponse));
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

function formatConversationalPlanningMessage(message: string): string {
  return [
    message,
    '',
    'In-app planning chat rule:',
    '- Treat this as a conversation before a plan.',
    '- Talk through edge cases, corner cases, architecture, and ambiguity with the human.',
    '- Resolve those points before producing a YAML plan.',
    '- If anything important is unclear, ask concise questions instead of drafting.',
    '- Draft YAML only after the human asks you to draft/proceed, or after the conversation has already resolved the important choices.',
  ].join('\n');
}

function planConversationConfig(
  preset: HarnessPreset,
  deps: Pick<InAppPlannerDeps, 'config' | 'workingDir' | 'planningCommandBuilder' | 'conversationRepo' | 'onRawPlannerOutput'>,
  threadTs: string,
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
    preferStackedWorkflows: true,
    planningCommandBuilder: deps.planningCommandBuilder,
    plannerRetryLimit: deps.config.plannerRetryLimit,
    plannerRetryBaseDelayMs: deps.config.plannerRetryBaseDelayMs,
    onRawPlannerOutput: deps.onRawPlannerOutput
      ? (chunk) => deps.onRawPlannerOutput?.({ sessionId: threadTs, chunk })
      : undefined,
  };
}

async function createSession(
  request: Partial<InAppPlanningCreateSessionRequest> | null | undefined,
  deps: InAppPlannerDeps & {
    sessions: InAppPlanningChatSessions;
    planningCommandBuilder: PlanningCommandBuilder;
    planningSessionStore?: InAppPlanningSessionStore;
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

  const { PlanConversation } = await loadPlannerSurfaces();
  const createdAt = new Date().toISOString();
  const id = randomUUID();
  const session: InAppPlanningChatSession = {
    id,
    title: typeof request?.title === 'string' && request.title.trim() ? request.title.trim() : 'Untitled plan',
    presetKey,
    status: 'still_discussing',
    messages: [],
    conversation: new PlanConversation(planConversationConfig(preset, deps, id)),
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

export async function listInAppPlanningPresets(config: InvokerConfig): Promise<PlanningPresetOption[]> {
  const presets = await resolveHarnessPresets(config);
  const defaultPresetKey = await resolveDefaultPresetKey(config);
  return Object.entries(presets).map(([key, preset]) => ({
    key,
    label: labelForPresetKey(key),
    tool: preset.tool,
    model: preset.model,
    isDefault: key === defaultPresetKey,
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
    const { PlanConversation, extractYamlPlan } = await loadPlannerSurfaces();
    const conversation = new PlanConversation(planConversationConfig(preset, deps, randomUUID()));
    const plannerOutput = await conversation.sendMessage(goal);
    const planText = extractYamlPlan(plannerOutput);
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
  deps: { sessions: InAppPlanningChatSessions },
): InAppPlanningListSessionsResponse {
  const sessions = [...deps.sessions.values()]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map(sessionToSummary);
  return { ok: true, sessions };
}

export async function sendPlanningChatMessage(
  request: InAppPlanningChatRequest,
  deps: InAppPlannerDeps & {
    sessions: InAppPlanningChatSessions;
    planningCommandBuilder: PlanningCommandBuilder;
    planningSessionStore?: InAppPlanningSessionStore;
  },
): Promise<InAppPlanningChatResponse> {
  const rawRequest = request as Partial<InAppPlanningChatRequest> | null | undefined;
  const message = typeof rawRequest?.message === 'string' ? rawRequest.message.trim() : '';
  if (!message) {
    return { ok: false, sessionId: rawRequest?.sessionId, error: 'Type a message first.' };
  }

  let sessionId = rawRequest?.sessionId;
  try {
    let session = rawRequest?.sessionId ? deps.sessions.get(rawRequest.sessionId) : undefined;
    if (!session) {
      const created = await createSession({
        presetKey: rawRequest?.presetKey,
        title: titleFromMessage(message),
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
    const previousSend = activeSession.pendingSend ?? Promise.resolve();
    const turn = previousSend.then(async (): Promise<InAppPlanningChatResponse> => {
      clearStarterPromptIfUnused(activeSession);
      appendSessionMessage(activeSession, 'user', message);
      if (activeSession.title === 'Untitled plan') {
        activeSession.title = titleFromMessage(message);
      }
      persistPlanningSession(activeSession, deps.planningSessionStore, true);

      try {
        const { extractYamlPlan, summarizePlanText } = await loadPlannerSurfaces();
        const formattedMessage = formatConversationalPlanningMessage(message);
        const reply = deps.plannerReplyOverride
          ? await deps.plannerReplyOverride(formattedMessage)
          : await activeSession.conversation.sendMessage(formattedMessage);
        if (deps.plannerReplyOverride) {
          saveOverrideConversation(deps.conversationRepo, activeSession.id, formattedMessage, reply);
        }
        const reasoningParts = deps.plannerReplyOverride
          ? []
          : activeSession.conversation.lastTurnReasoning;
        const reasoning = reasoningParts.length > 0 ? reasoningParts.join('\n\n') : undefined;
        const planText = activeSession.conversation.getDraftedPlan() ?? extractYamlPlan(reply);
        if (!planText) {
          activeSession.draftPlanSummary = undefined;
          activeSession.draftPlanText = undefined;
          activeSession.status = reply.includes('?') ? 'waiting_for_answer' : 'still_discussing';
          appendSessionMessage(activeSession, 'assistant', reply);
          persistPlanningSession(activeSession, deps.planningSessionStore, false);
          return { ok: true, sessionId: activeSession.id, reply, reasoning, draftPlanAvailable: false } as InAppPlanningChatResponse;
        }

        const summary = summarizePlanText(planText);
        if (!summary) {
          const fallbackReply = 'I drafted a plan, but I could not turn it into simple steps. Ask me to regenerate it before submitting.';
          activeSession.draftPlanSummary = undefined;
          activeSession.draftPlanText = undefined;
          activeSession.status = 'still_discussing';
          appendSessionMessage(activeSession, 'assistant', fallbackReply);
          persistPlanningSession(activeSession, deps.planningSessionStore, false);
          return {
            ok: true,
            sessionId: activeSession.id,
            reply: fallbackReply,
            draftPlanAvailable: false,
          };
        }
        activeSession.draftPlanSummary = summary;
        activeSession.draftPlanText = planText;
        activeSession.status = 'draft_ready';
        appendSessionMessage(activeSession, 'assistant', reply);
        persistPlanningSession(activeSession, deps.planningSessionStore, false);
        return {
          ok: true,
          sessionId: activeSession.id,
          reply,
          reasoning,
          draftPlanAvailable: true,
          draftPlanSummary: summary,
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
  if (session.pendingSubmit) {
    return session.pendingSubmit;
  }

  const planText = session.conversation.getDraftedPlan() ?? session.draftPlanText;
  if (!planText) {
    return { ok: false, error: 'No complete plan drafted yet. Ask the AI to create a full plan, then submit again.' };
  }

  const submitAttempt = (async (): Promise<InAppPlanningSubmitResponse> => {
    try {
      const { summarizePlanText } = await loadPlannerSurfaces();
      if (!summarizePlanText(planText)) {
        return { ok: false, error: 'I found a draft plan but could not read it. Ask the AI to regenerate the plan, then submit again.' };
      }

      const loaded = await deps.loadGeneratedPlan(planText);
      session.status = 'submitted';
      session.submittedPlanName = loaded.planName;
      session.submittedWorkflowId = loaded.workflowId;
      session.updatedAt = new Date().toISOString();
      appendSessionMessage(
        session,
        'system',
        loaded.workflowCount && loaded.workflowCount > 1
          ? `Plan "${loaded.planName}" submitted as ${loaded.workflowCount} stacked workflows. Review them, then use Start ready work.`
          : `Plan "${loaded.planName}" submitted to Invoker. Review it, then use Start ready work.`,
        'success',
      );
      persistPlanningSession(session, deps.planningSessionStore, false);
      return {
        ok: true,
        planName: loaded.planName,
        workflowId: loaded.workflowId,
        workflowIds: loaded.workflowIds,
        workflowCount: loaded.workflowCount,
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
  },
): Promise<void> {
  // Nothing persisted → skip loading @invoker/surfaces. The built required-fast CI app
  // boots without surfaces/dist, so an eager load here would crash startup with no sessions.
  if (records.length === 0) return;
  const presets = await resolveHarnessPresets(deps.config);
  const { PlanConversation, summarizePlanText } = await loadPlannerSurfaces();

  for (const record of records) {
    const preset = presets[record.presetKey];
    if (!preset) continue;

    const conversation = new PlanConversation(planConversationConfig(preset, deps, record.id));
    await conversation.init();

    const nextMessageId = Math.max(0, ...record.messages.map((message) => message.id)) + 1;
    const session: InAppPlanningChatSession = {
      id: record.id,
      title: record.title,
      presetKey: record.presetKey,
      status: record.status,
      messages: [...record.messages],
      conversation,
      draftPlanSummary: record.draftPlanSummary,
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

    const draftedPlan = conversation.getDraftedPlan();
    if (session.status === 'draft_ready') {
      if (!draftedPlan) {
        session.status = 'still_discussing';
        session.draftPlanSummary = undefined;
        session.draftPlanText = undefined;
        appendSessionMessage(
          session,
          'system',
          'The saved draft could not be restored. Ask the planner to draft it again.',
          'error',
        );
        shouldPersist = true;
      } else {
        session.draftPlanText = draftedPlan;
        if (!session.draftPlanSummary) {
          const restoredSummary = summarizePlanText(draftedPlan);
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
            shouldPersist = true;
          } else {
            session.draftPlanSummary = restoredSummary;
            shouldPersist = true;
          }
        }
      }
    } else if (draftedPlan) {
      session.draftPlanText = draftedPlan;
    }

    deps.sessions.set(session.id, session);
    if (shouldPersist) {
      persistPlanningSession(session, deps.planningSessionStore, false);
    }
  }
}
