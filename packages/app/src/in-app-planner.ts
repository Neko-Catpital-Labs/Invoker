import type { InAppPlanRequest, InAppPlanResponse } from '@invoker/contracts';
import {
  BUILTIN_HARNESS_PRESETS,
  DEFAULT_HARNESS_PRESET,
  PlanConversation,
  extractYamlPlan,
} from '@invoker/surfaces';
import type { HarnessPreset, LogFn, PlanningCommandBuilder } from '@invoker/surfaces';

export interface LoadedGeneratedPlanPreview {
  planName: string;
  workflowId: string;
}

export interface InAppPlannerDeps {
  workingDir?: string;
  cursorCommand?: string;
  model?: string;
  defaultBranch?: string;
  repoUrl?: string;
  timeoutMs?: number;
  experimentalPlanner?: boolean;
  planningCommandBuilder?: PlanningCommandBuilder;
  plannerHarnessPresets?: Record<string, HarnessPreset>;
  defaultPlannerHarnessPreset?: string;
  loadGeneratedPlan: (planText: string) => LoadedGeneratedPlanPreview | Promise<LoadedGeneratedPlanPreview>;
  log?: LogFn;
}

function error(message: string): InAppPlanResponse {
  return { ok: false, error: message };
}

function messageForError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function planFromGoal(
  request: InAppPlanRequest,
  deps: InAppPlannerDeps,
): Promise<InAppPlanResponse> {
  const rawRequest = request as InAppPlanRequest | null | undefined;
  const goal = typeof rawRequest?.goal === 'string' ? rawRequest.goal.trim() : '';
  if (!goal) return error('Describe a goal first.');

  const presets = deps.plannerHarnessPresets ?? BUILTIN_HARNESS_PRESETS;
  const presetKey = typeof rawRequest?.preset === 'string' && rawRequest.preset.trim() !== ''
    ? rawRequest.preset.trim()
    : (deps.defaultPlannerHarnessPreset ?? DEFAULT_HARNESS_PRESET);
  const preset = presets[presetKey];
  if (!preset) return error(`Unknown planner preset "${presetKey}".`);

  try {
    const conversation = new PlanConversation({
      cursorCommand: deps.cursorCommand,
      tool: preset.tool,
      model: preset.model ?? deps.model,
      workingDir: deps.workingDir,
      defaultBranch: deps.defaultBranch,
      repoUrl: deps.repoUrl,
      timeoutMs: deps.timeoutMs,
      experimentalPlanner: deps.experimentalPlanner,
      planningCommandBuilder: deps.planningCommandBuilder,
      log: deps.log,
    });

    const reply = await conversation.sendMessage(goal);
    const planText = extractYamlPlan(reply);
    if (!planText) return error('Planner did not return a valid YAML plan.');

    const loaded = await deps.loadGeneratedPlan(planText);
    return {
      ok: true,
      planName: loaded.planName,
      workflowId: loaded.workflowId,
    };
  } catch (err) {
    return error(messageForError(err));
  }
}
