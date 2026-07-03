import type { InAppPlanRequest, InAppPlanResponse } from '@invoker/contracts';
import type { HarnessPreset, PlanningCommandBuilder } from '@invoker/surfaces';
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
