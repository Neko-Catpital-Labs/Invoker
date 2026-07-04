import { randomUUID } from 'node:crypto';
import type {
  InAppPlanRequest,
  InAppPlanResponse,
  InAppPlanningChatRequest,
  InAppPlanningChatResponse,
  InAppPlanningResetRequest,
  InAppPlanningResetResponse,
  InAppPlanningSubmitRequest,
  InAppPlanningSubmitResponse,
  PlanningPresetOption,
} from '@invoker/contracts';
import type { AgentRegistry } from '@invoker/execution-engine';
import type { HarnessPreset, PlanConversation, PlanningCommandBuilder } from '@invoker/surfaces';
import type { InvokerConfig } from './config.js';

export interface LoadedGeneratedPlan {
  planName: string;
  workflowId: string;
}

export interface InAppPlannerDeps {
  config: InvokerConfig;
  loadGeneratedPlan: (planText: string) => LoadedGeneratedPlan | Promise<LoadedGeneratedPlan>;
  workingDir?: string;
  planningCommandBuilder?: PlanningCommandBuilder;
}

export interface InAppPlanningChatSession {
  id: string;
  presetKey: string;
  conversation: PlanConversation;
  pendingSend?: Promise<void>;
}

export type InAppPlanningChatSessions = Map<string, InAppPlanningChatSession>;

export function createInAppPlanningChatSessions(): InAppPlanningChatSessions {
  return new Map();
}

type PlannerSurfacesModule = typeof import('@invoker/surfaces');

async function loadPlannerSurfaces(): Promise<PlannerSurfacesModule> {
  try {
    return await import('@invoker/surfaces');
  } catch {
    return await import('../../surfaces/src/index.ts');
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
    const conversation = new PlanConversation({
      tool: preset.tool,
      model: preset.model,
      workingDir: deps.workingDir,
      timeoutMs: (deps.config.planningTimeoutSeconds ?? 7200) * 1000,
      defaultBranch: deps.config.defaultBranch,
      repoUrl: deps.config.defaultRepoUrl,
      experimentalPlanner: deps.config.experimentalPlanner,
      planningCommandBuilder: deps.planningCommandBuilder,
    });
    const plannerOutput = await conversation.sendMessage(goal);
    const planText = extractYamlPlan(plannerOutput);
    if (!planText) {
      return { ok: false, error: 'Planner did not return a valid YAML plan.' };
    }

    const loaded = await deps.loadGeneratedPlan(planText);
    return { ok: true, planName: loaded.planName, workflowId: loaded.workflowId };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatDraftPlanReply(summary: { name: string; steps: string[] }): string {
  const stepLines = summary.steps.map((step, index) => `${index + 1}. ${step}`);
  return [
    `I drafted "${summary.name}". Here is the simple version:`,
    '',
    ...stepLines,
    '',
    'If this looks right, choose Submit to Invoker.',
  ].join('\n');
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


export async function sendPlanningChatMessage(
  request: InAppPlanningChatRequest,
  deps: InAppPlannerDeps & {
    sessions: InAppPlanningChatSessions;
    planningCommandBuilder: PlanningCommandBuilder;
  },
): Promise<InAppPlanningChatResponse> {
  const rawRequest = request as Partial<InAppPlanningChatRequest> | null | undefined;
  const message = typeof rawRequest?.message === 'string' ? rawRequest.message.trim() : '';
  if (!message) {
    return { ok: false, sessionId: rawRequest?.sessionId, error: 'Type a message first.' };
  }

  let sessionId = rawRequest?.sessionId;
  try {
    const presets = await resolveHarnessPresets(deps.config);
    const defaultPresetKey = await resolveDefaultPresetKey(deps.config);
    const existingSession = rawRequest?.sessionId ? deps.sessions.get(rawRequest.sessionId) : undefined;
    const requestedPresetKey = typeof rawRequest?.presetKey === 'string' && rawRequest.presetKey
      ? rawRequest.presetKey
      : undefined;
    const effectivePresetKey = existingSession?.presetKey ?? requestedPresetKey ?? defaultPresetKey;
    const preset = presets[effectivePresetKey];
    if (!preset) {
      return {
        ok: false,
        sessionId: rawRequest?.sessionId,
        error: `Unknown planner preset "${effectivePresetKey}".`,
      };
    }

    let session = existingSession;
    if (!session) {
      const { PlanConversation } = await loadPlannerSurfaces();
      const newSessionId = randomUUID();
      session = {
        id: newSessionId,
        presetKey: effectivePresetKey,
        conversation: new PlanConversation({
          tool: preset.tool,
          model: preset.model,
          workingDir: deps.workingDir,
          timeoutMs: (deps.config.planningTimeoutSeconds ?? 7200) * 1000,
          defaultBranch: deps.config.defaultBranch,
          repoUrl: deps.config.defaultRepoUrl,
          experimentalPlanner: deps.config.experimentalPlanner,
          planningCommandBuilder: deps.planningCommandBuilder,
        }),
      };
      deps.sessions.set(newSessionId, session);
    }
    sessionId = session.id;

    const activeSession = session;
    const previousSend = activeSession.pendingSend ?? Promise.resolve();
    const turn = previousSend.then(async (): Promise<InAppPlanningChatResponse> => {
      const reply = await activeSession.conversation.sendMessage(formatConversationalPlanningMessage(message));
      const planText = activeSession.conversation.getDraftedPlan();
      if (!planText) {
        return { ok: true, sessionId: activeSession.id, reply, draftPlanAvailable: false };
      }

      const { summarizePlanText } = await loadPlannerSurfaces();
      const summary = summarizePlanText(planText);
      if (!summary) {
        return {
          ok: true,
          sessionId: activeSession.id,
          reply: 'I drafted a plan, but I could not turn it into simple steps. Ask me to regenerate it before submitting.',
          draftPlanAvailable: false,
        };
      }
      return {
        ok: true,
        sessionId: activeSession.id,
        reply: formatDraftPlanReply(summary),
        draftPlanAvailable: true,
        draftPlanSummary: summary,
      };
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
  },
): Promise<InAppPlanningSubmitResponse> {
  const rawRequest = request as Partial<InAppPlanningSubmitRequest> | null | undefined;
  const sessionId = typeof rawRequest?.sessionId === 'string' ? rawRequest.sessionId.trim() : '';
  const session = sessionId ? deps.sessions.get(sessionId) : undefined;
  if (!session) {
    return { ok: false, error: 'No planning conversation yet.' };
  }

  const planText = session.conversation.getDraftedPlan();
  if (!planText) {
    return { ok: false, error: 'No complete plan drafted yet. Ask the AI to create a full plan, then submit again.' };
  }

  try {
    const { summarizePlanText } = await loadPlannerSurfaces();
    if (!summarizePlanText(planText)) {
      return { ok: false, error: 'I found a draft plan but could not read it. Ask the AI to regenerate the plan, then submit again.' };
    }

    const loaded = await deps.loadGeneratedPlan(planText);
    deps.sessions.delete(sessionId);
    return { ok: true, planName: loaded.planName, workflowId: loaded.workflowId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function resetPlanningChat(
  request: InAppPlanningResetRequest,
  deps: { sessions: InAppPlanningChatSessions },
): InAppPlanningResetResponse {
  deps.sessions.delete(request.sessionId);
  return { ok: true };
}

