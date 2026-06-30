import type { InAppPlanRequest, InAppPlanResponse } from '@invoker/contracts';
import {
  BUILTIN_HARNESS_PRESETS,
  DEFAULT_HARNESS_PRESET,
  extractYamlPlan,
  PlanConversation,
  type HarnessPreset,
  type PlanningCommandBuilder,
} from '@invoker/surfaces';
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

function resolveHarnessPresets(config: InvokerConfig): Record<string, HarnessPreset> {
  return {
    ...BUILTIN_HARNESS_PRESETS,
    ...(config.slackHarnessPresets ?? {}),
    ...(config.plannerHarnessPresets ?? {}),
  };
}

function resolveDefaultPresetKey(config: InvokerConfig): string {
  return config.defaultPlannerHarnessPreset
    ?? config.defaultSlackHarnessPreset
    ?? DEFAULT_HARNESS_PRESET;
}

export async function planFromGoal(
  request: InAppPlanRequest,
  deps: InAppPlannerDeps,
): Promise<InAppPlanResponse> {
  const goal = request.goal.trim();
  if (!goal) {
    return { ok: false, error: 'Describe a goal first.' };
  }

  const presets = resolveHarnessPresets(deps.config);
  const presetKey = request.presetKey ?? resolveDefaultPresetKey(deps.config);
  const preset = presets[presetKey];
  if (!preset) {
    return { ok: false, error: `Unknown planner preset "${presetKey}".` };
  }

  try {
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
