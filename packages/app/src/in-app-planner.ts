import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type {
  InAppPlanRequest,
  InAppPlanResponse,
  InAppPlanningChatLine,
  InAppPlanningChatRequest,
  InAppPlanningChatResponse,
  InAppPlanningCreateSessionRequest,
  InAppPlanningCreateSessionResponse,
  InAppPlanningGetSessionRequest,
  InAppPlanningGetSessionResponse,
  InAppPlanningListSessionsResponse,
  InAppPlanningPlanSummary,
  InAppPlanningResetRequest,
  InAppPlanningResetResponse,
  InAppPlanningSessionStatus,
  InAppPlanningSessionSummary,
  InAppPlanningSubmitRequest,
  InAppPlanningSubmitResponse,
  PlanningPresetOption,
} from '@invoker/contracts';
import type { InvokerConfig } from './config.js';

export interface LoadedGeneratedPlan {
  planName: string;
  workflowId: string;
  workflowIds?: string[];
  workflowCount?: number;
}

export interface PlannerPreset {
  tool: string;
  model?: string;
  command?: string;
}

export interface InAppPlanningSessionRecord {
  id: string;
  title: string;
  presetKey: string;
  status: InAppPlanningSessionStatus;
  messages: InAppPlanningChatLine[];
  draftPlanSummary?: InAppPlanningPlanSummary;
  draftPlanText?: string;
  submittedWorkflowId?: string;
  submittedPlanName?: string;
  pendingResponse: boolean;
  createdAt: string;
  updatedAt: string;
}

export type InAppPlanningSessionPatch = Partial<Pick<
  InAppPlanningSessionRecord,
  | 'title'
  | 'status'
  | 'messages'
  | 'draftPlanSummary'
  | 'draftPlanText'
  | 'submittedWorkflowId'
  | 'submittedPlanName'
  | 'pendingResponse'
  | 'updatedAt'
>>;

export interface InAppPlanningSessionStore {
  upsertInAppPlanningSession(record: InAppPlanningSessionRecord): void;
  updateInAppPlanningSession?(sessionId: string, patch: InAppPlanningSessionPatch): void;
  deleteInAppPlanningSession(sessionId: string): void;
}

export interface PlanningCommandBuilderOptions {
  tool: string;
  model?: string;
  prompt: string;
}

export type PlanningCommandBuilder = (
  options: PlanningCommandBuilderOptions,
) => { command: string; args: string[] };

export interface InAppPlannerDeps {
  config: InvokerConfig;
  loadGeneratedPlan: (planText: string) => LoadedGeneratedPlan | Promise<LoadedGeneratedPlan>;
  workingDir?: string;
  planningCommandBuilder?: PlanningCommandBuilder;
  planningSessionStore?: InAppPlanningSessionStore;
  plannerReplyOverride?: (formattedMessage: string) => string | Promise<string>;
  log?: (source: string, level: string, message: string) => void;
}

export interface InAppPlanningChatSession {
  id: string;
  title: string;
  presetKey: string;
  status: InAppPlanningSessionStatus;
  messages: InAppPlanningChatLine[];
  conversation: PlannerConversation;
  draftPlanSummary?: InAppPlanningPlanSummary;
  draftPlanText?: string;
  submittedWorkflowId?: string;
  submittedPlanName?: string;
  createdAt: string;
  updatedAt: string;
  nextMessageId: number;
  pendingSend?: Promise<void>;
  pendingSubmit?: Promise<InAppPlanningSubmitResponse>;
}

export type InAppPlanningChatSessions = Map<string, InAppPlanningChatSession>;

const DEFAULT_PRESET_KEY = 'codex';
const BUILTIN_PLANNER_PRESETS: Record<string, PlannerPreset> = {
  codex: { tool: 'codex' },
  cursor: { tool: 'agent' },
};

interface PlannerConversationConfig {
  cursorCommand?: string;
  model?: string;
  workingDir?: string;
  timeoutMs?: number;
  defaultBranch?: string;
  repoUrl?: string;
  log?: (source: string, level: string, message: string) => void;
}

interface PlannerConversation {
  sendMessage(message: string): Promise<string>;
  getDraftedPlan?: () => string | null;
  init?: () => Promise<void> | void;
}

interface PlannerSurfacesModule {
  PlanConversation: new (config: PlannerConversationConfig) => PlannerConversation;
  extractYamlPlan: (output: string) => string | null;
}

function isModuleResolutionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes('Cannot find module')
    || error.message.includes('Cannot find package')
    || error.message.includes('Failed to resolve entry for package')
    || error.message.includes('ERR_MODULE_NOT_FOUND')
    || error.message.includes('ERR_UNKNOWN_FILE_EXTENSION')
  );
}

async function loadPlannerSurfaces(): Promise<PlannerSurfacesModule> {
  const packageName = '@invoker/surfaces';
  try {
    return await import(/* @vite-ignore */ packageName) as PlannerSurfacesModule;
  } catch (packageError) {
    if (!isModuleResolutionError(packageError)) {
      throw packageError;
    }
    const builtSurfacesModulePath = '../../surfaces/dist/index.js';
    try {
      return await import(/* @vite-ignore */ builtSurfacesModulePath) as PlannerSurfacesModule;
    } catch (distError) {
      if (!isModuleResolutionError(distError)) {
        throw distError;
      }
      if (process.versions.electron) {
        throw new Error('Unable to load @invoker/surfaces. Build packages/surfaces first so dist/index.js exists.');
      }

      const sourceSurfacesModulePath = '../../surfaces/src/index.js';
      try {
        return await import(/* @vite-ignore */ sourceSurfacesModulePath) as PlannerSurfacesModule;
      } catch (sourceJsError) {
        if (!isModuleResolutionError(sourceJsError)) {
          throw sourceJsError;
        }
        const sourceTsModulePath = '../../surfaces/src/index.ts';
        return await import(/* @vite-ignore */ sourceTsModulePath) as PlannerSurfacesModule;
      }
    }
  }
}

export function createInAppPlanningChatSessions(): InAppPlanningChatSessions {
  return new Map();
}

function configRecord(config: InvokerConfig): Record<string, unknown> {
  return config as Record<string, unknown>;
}

function asPresetMap(value: unknown): Record<string, PlannerPreset> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, PlannerPreset>;
}

function resolvePlannerPresets(config: InvokerConfig): Record<string, PlannerPreset> {
  const raw = configRecord(config);
  return {
    ...BUILTIN_PLANNER_PRESETS,
    ...asPresetMap(raw.slackHarnessPresets),
    ...asPresetMap(raw.plannerHarnessPresets),
  };
}

function resolveDefaultPresetKey(config: InvokerConfig): string {
  const raw = configRecord(config);
  const configured = raw.defaultPlannerHarnessPreset ?? raw.defaultSlackHarnessPreset;
  return typeof configured === 'string' && configured.trim()
    ? configured.trim()
    : DEFAULT_PRESET_KEY;
}

function labelForPresetKey(key: string): string {
  switch (key) {
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
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

function titleFromMessage(message: string): string {
  const firstLine = message.split('\n', 1)[0]?.trim() ?? '';
  if (!firstLine) return 'Untitled plan';
  return firstLine.length > 56 ? `${firstLine.slice(0, 53).trimEnd()}...` : firstLine;
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
    ...(tone ? { tone } : {}),
    createdAt,
  });
  session.nextMessageId += 1;
  session.updatedAt = createdAt;
}

function hasDraftPlan(session: Pick<InAppPlanningChatSession, 'draftPlanSummary' | 'draftPlanText'>): boolean {
  return Boolean(session.draftPlanText || session.draftPlanSummary);
}

function sessionToRecord(session: InAppPlanningChatSession, pendingResponse: boolean): InAppPlanningSessionRecord {
  return {
    id: session.id,
    title: session.title,
    presetKey: session.presetKey,
    status: session.status,
    messages: session.messages,
    ...(session.draftPlanSummary ? { draftPlanSummary: session.draftPlanSummary } : {}),
    ...(session.draftPlanText ? { draftPlanText: session.draftPlanText } : {}),
    ...(session.submittedWorkflowId ? { submittedWorkflowId: session.submittedWorkflowId } : {}),
    ...(session.submittedPlanName ? { submittedPlanName: session.submittedPlanName } : {}),
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
    draftPlanAvailable: hasDraftPlan(session),
    ...(session.draftPlanSummary ? { draftPlanSummary: session.draftPlanSummary } : {}),
    ...(session.draftPlanText ? { draftPlanText: session.draftPlanText } : {}),
    ...(session.submittedWorkflowId ? { submittedWorkflowId: session.submittedWorkflowId } : {}),
    ...(session.submittedPlanName ? { submittedPlanName: session.submittedPlanName } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function persistPlanningSession(
  session: InAppPlanningChatSession,
  store: InAppPlanningSessionStore | undefined,
  pendingResponse: boolean,
): void {
  store?.upsertInAppPlanningSession(sessionToRecord(session, pendingResponse));
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

function getConversationDraftedPlan(conversation: PlannerConversation): string | null {
  return conversation.getDraftedPlan?.() ?? null;
}

async function createConversation(
  preset: PlannerPreset,
  deps: Pick<InAppPlannerDeps, 'config' | 'workingDir' | 'log'>,
): Promise<PlannerConversation> {
  const { PlanConversation } = await loadPlannerSurfaces();
  const timeoutMs = (deps.config.planningTimeoutSeconds ?? 7_200) * 1_000;
  return new PlanConversation({
    cursorCommand: preset.command ?? preset.tool,
    model: preset.model,
    workingDir: deps.workingDir,
    timeoutMs,
    defaultBranch: deps.config.defaultBranch,
    repoUrl: configRecord(deps.config).defaultRepoUrl as string | undefined,
    log: deps.log,
  });
}

function createLoadedResponse(loaded: LoadedGeneratedPlan): Extract<InAppPlanResponse, { ok: true }> {
  return {
    ok: true,
    planName: loaded.planName,
    workflowId: loaded.workflowId,
    ...(loaded.workflowIds ? { workflowIds: loaded.workflowIds } : {}),
    ...(loaded.workflowCount ? { workflowCount: loaded.workflowCount } : {}),
  };
}

function summarizeTaskSteps(rawTasks: unknown): string[] | null {
  if (!Array.isArray(rawTasks)) return [];
  const steps: string[] = [];
  for (const task of rawTasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
    const candidate = task as Record<string, unknown>;
    if (typeof candidate.description === 'string' && candidate.description.trim()) {
      steps.push(candidate.description.trim());
    } else if (typeof candidate.id === 'string' && candidate.id.trim()) {
      steps.push(candidate.id.trim());
    } else {
      return null;
    }
  }
  return steps;
}

export function summarizePlanText(planText: string): InAppPlanningPlanSummary | null {
  try {
    const raw = parseYaml(planText) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const plan = raw as Record<string, unknown>;

    if (Array.isArray(plan.workflows)) {
      const workflows = plan.workflows.filter((workflow): workflow is Record<string, unknown> => (
        Boolean(workflow) && typeof workflow === 'object' && !Array.isArray(workflow)
      ));
      if (workflows.length === 0) return null;
      let taskCount = 0;
      const steps: string[] = [];
      const taskGroups: NonNullable<InAppPlanningPlanSummary['taskGroups']> = [];
      workflows.forEach((workflow, index) => {
        const workflowName =
          typeof workflow.name === 'string' && workflow.name.trim()
            ? workflow.name.trim()
            : typeof workflow.id === 'string' && workflow.id.trim()
              ? workflow.id.trim()
              : `Workflow ${index + 1}`;
        steps.push(workflowName);
        const taskSteps = summarizeTaskSteps(workflow.tasks);
        if (taskSteps === null) {
          return;
        }
        taskCount += Array.isArray(workflow.tasks) ? workflow.tasks.length : 0;
        taskGroups.push({
          name: workflowName,
          ...(typeof workflow.id === 'string' && workflow.id.trim() ? { workflowId: workflow.id.trim() } : {}),
          taskCount: taskSteps.length,
          steps: taskSteps,
        });
      });
      if (taskGroups.length !== workflows.length) return null;
      return {
        name: typeof plan.name === 'string' && plan.name.trim() ? plan.name.trim() : 'Untitled plan',
        taskCount,
        workflowCount: workflows.length,
        steps,
        taskGroups,
      };
    }

    if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) return null;
    const steps = summarizeTaskSteps(plan.tasks);
    if (!steps) return null;
    return {
      name: typeof plan.name === 'string' && plan.name.trim() ? plan.name.trim() : 'Untitled plan',
      taskCount: plan.tasks.length,
      steps,
    };
  } catch {
    return null;
  }
}

async function createSession(
  request: Partial<InAppPlanningCreateSessionRequest> | null | undefined,
  deps: InAppPlannerDeps & { sessions: InAppPlanningChatSessions },
): Promise<InAppPlanningChatSession | { error: string }> {
  const presets = resolvePlannerPresets(deps.config);
  const requestedPresetKey = typeof request?.presetKey === 'string' && request.presetKey.trim()
    ? request.presetKey.trim()
    : undefined;
  const presetKey = requestedPresetKey ?? resolveDefaultPresetKey(deps.config);
  const preset = presets[presetKey];
  if (!preset) {
    return { error: `Unknown planner preset "${presetKey}".` };
  }

  const createdAt = new Date().toISOString();
  const session: InAppPlanningChatSession = {
    id: randomUUID(),
    title: typeof request?.title === 'string' && request.title.trim() ? request.title.trim() : 'Untitled plan',
    presetKey,
    status: 'still_discussing',
    messages: [{
      id: 1,
      role: 'system',
      text: 'Ask Invoker what you want to build.',
      tone: 'muted',
      createdAt,
    }],
    conversation: await createConversation(preset, deps),
    createdAt,
    updatedAt: createdAt,
    nextMessageId: 2,
  };
  deps.sessions.set(session.id, session);
  persistPlanningSession(session, deps.planningSessionStore, false);
  return session;
}

export function listInAppPlanningPresets(config: InvokerConfig): PlanningPresetOption[] {
  const presets = resolvePlannerPresets(config);
  const defaultPresetKey = resolveDefaultPresetKey(config);
  return Object.entries(presets).map(([key, preset]) => ({
    key,
    label: labelForPresetKey(key),
    tool: preset.tool,
    ...(preset.model ? { model: preset.model } : {}),
    isDefault: key === defaultPresetKey,
  }));
}

export function createPlanningCommandBuilderFromRegistry(
  registry: { getPlanningOrThrow(tool: string): { buildPlanningCommand(prompt: string, opts?: { model?: string }): { command: string; args: string[] } } },
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

  const presets = resolvePlannerPresets(deps.config);
  const requestedPreset = rawRequest?.presetKey ?? rawRequest?.preset;
  const presetKey = typeof requestedPreset === 'string' && requestedPreset.trim()
    ? requestedPreset.trim()
    : resolveDefaultPresetKey(deps.config);
  const preset = presets[presetKey];
  if (!preset) {
    return { ok: false, error: `Unknown planner preset "${presetKey}".` };
  }

  try {
    const { extractYamlPlan } = await loadPlannerSurfaces();
    const conversation = await createConversation(preset, deps);
    const plannerOutput = await conversation.sendMessage(goal);
    const planText = extractYamlPlan(plannerOutput);
    if (!planText) {
      return { ok: false, error: 'Planner did not return a valid YAML plan.' };
    }
    const loaded = await deps.loadGeneratedPlan(planText);
    return createLoadedResponse(loaded);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createPlanningChatSession(
  request: InAppPlanningCreateSessionRequest | undefined,
  deps: InAppPlannerDeps & { sessions: InAppPlanningChatSessions },
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

export function getPlanningChatSession(
  request: InAppPlanningGetSessionRequest,
  deps: { sessions: InAppPlanningChatSessions },
): InAppPlanningGetSessionResponse {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : '';
  const session = sessionId ? deps.sessions.get(sessionId) : undefined;
  if (!session) {
    return { ok: false, error: 'Planning session not found.' };
  }
  return { ok: true, session: sessionToSummary(session) };
}

export const getPlanningChat = getPlanningChatSession;

export async function sendPlanningChatMessage(
  request: InAppPlanningChatRequest,
  deps: InAppPlannerDeps & { sessions: InAppPlanningChatSessions },
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
      appendSessionMessage(activeSession, 'user', message);
      if (activeSession.title === 'Untitled plan') {
        activeSession.title = titleFromMessage(message);
      }
      persistPlanningSession(activeSession, deps.planningSessionStore, true);

      try {
        const { extractYamlPlan } = await loadPlannerSurfaces();
        const formattedMessage = formatConversationalPlanningMessage(message);
        const reply = deps.plannerReplyOverride
          ? await deps.plannerReplyOverride(formattedMessage)
          : await activeSession.conversation.sendMessage(formattedMessage);
        const planText = getConversationDraftedPlan(activeSession.conversation) ?? extractYamlPlan(reply);
        if (!planText) {
          activeSession.draftPlanSummary = undefined;
          activeSession.draftPlanText = undefined;
          activeSession.status = reply.includes('?') ? 'waiting_for_answer' : 'still_discussing';
          appendSessionMessage(activeSession, 'assistant', reply);
          persistPlanningSession(activeSession, deps.planningSessionStore, false);
          return { ok: true, sessionId: activeSession.id, reply, draftPlanAvailable: false };
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
          draftPlanAvailable: true,
          draftPlanSummary: summary,
          draftPlanText: planText,
        };
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

  const planText = session.draftPlanText ?? getConversationDraftedPlan(session.conversation);
  if (!planText) {
    return { ok: false, error: 'No complete plan drafted yet. Ask the AI to create a full plan, then submit again.' };
  }

  const submitAttempt = (async (): Promise<InAppPlanningSubmitResponse> => {
    try {
      const loaded = await deps.loadGeneratedPlan(planText);
      session.status = 'submitted';
      session.submittedPlanName = loaded.planName;
      session.submittedWorkflowId = loaded.workflowId;
      session.updatedAt = new Date().toISOString();
      appendSessionMessage(
        session,
        'system',
        loaded.workflowCount && loaded.workflowCount > 1
          ? `Plan "${loaded.planName}" submitted as ${loaded.workflowCount} stacked workflows. Review them, then Run.`
          : `Plan "${loaded.planName}" submitted to Invoker. Review it, then Run.`,
        'success',
      );
      persistPlanningSession(session, deps.planningSessionStore, false);
      return createLoadedResponse(loaded);
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

export async function restorePlanningChatSessions(
  records: InAppPlanningSessionRecord[],
  deps: InAppPlannerDeps & { sessions: InAppPlanningChatSessions },
): Promise<void> {
  if (records.length === 0) return;
  const presets = resolvePlannerPresets(deps.config);

  for (const record of records) {
    const preset = presets[record.presetKey];
    if (!preset) continue;

    const conversation = await createConversation(preset, deps);
    await conversation.init?.();

    const nextMessageId = Math.max(0, ...record.messages.map((message) => message.id)) + 1;
    const draftedPlan = record.draftPlanText ?? getConversationDraftedPlan(conversation);
    const rebuiltSummary = draftedPlan && !record.draftPlanSummary
      ? summarizePlanText(draftedPlan)
      : null;
    const session: InAppPlanningChatSession = {
      id: record.id,
      title: record.title,
      presetKey: record.presetKey,
      status: record.status,
      messages: [...record.messages],
      conversation,
      ...(record.draftPlanSummary ? { draftPlanSummary: record.draftPlanSummary } : {}),
      ...(rebuiltSummary ? { draftPlanSummary: rebuiltSummary } : {}),
      ...(draftedPlan ? { draftPlanText: draftedPlan } : {}),
      ...(record.submittedWorkflowId ? { submittedWorkflowId: record.submittedWorkflowId } : {}),
      ...(record.submittedPlanName ? { submittedPlanName: record.submittedPlanName } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      nextMessageId,
    };

    let shouldPersist = Boolean(rebuiltSummary || (draftedPlan && draftedPlan !== record.draftPlanText));
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

    deps.sessions.set(session.id, session);
    if (shouldPersist) {
      persistPlanningSession(session, deps.planningSessionStore, false);
    }
  }
}
