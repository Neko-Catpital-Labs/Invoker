import type { InAppPlanRequest, InAppPlanResponse } from '@invoker/contracts';
import {
  BUILTIN_HARNESS_PRESETS,
  DEFAULT_HARNESS_PRESET,
  PlanConversation,
  extractYamlPlan,
  type HarnessPreset,
} from '@invoker/surfaces';
import type { InvokerConfig } from './config.js';

export interface GeneratedPlanPreview {
  planName: string;
  workflowId: string;
}

export interface InAppPlannerDeps {
  config: Pick<
    InvokerConfig,
    | 'defaultBranch'
    | 'defaultRepoUrl'
    | 'experimentalPlanner'
    | 'planningTimeoutSeconds'
    | 'plannerHarnessPresets'
    | 'defaultPlannerHarnessPreset'
  >;
  workingDir?: string;
  loadGeneratedPlan: (planText: string) => GeneratedPlanPreview | Promise<GeneratedPlanPreview>;
  log?: (source: string, level: string, message: string) => void;
}

function plannerPresets(config: InAppPlannerDeps['config']): Record<string, HarnessPreset> {
  return {
    ...BUILTIN_HARNESS_PRESETS,
    ...(config.plannerHarnessPresets ?? {}),
  };
}

function plannerError(error: string): InAppPlanResponse {
  return { ok: false, error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function planFromGoal(
  request: InAppPlanRequest,
  deps: InAppPlannerDeps,
): Promise<InAppPlanResponse> {
  const goal = String(request?.goal ?? '').trim();
  if (!goal) {
    return plannerError('Describe a goal first.');
  }

  const presets = plannerPresets(deps.config);
  const presetKey = String(
    request?.preset?.trim() || deps.config.defaultPlannerHarnessPreset || DEFAULT_HARNESS_PRESET,
  );
  const preset = presets[presetKey];
  if (!preset) {
    return plannerError(`Unknown planner preset "${presetKey}".`);
  }

  const conversation = new PlanConversation({
    tool: preset.tool,
    model: preset.model,
    workingDir: deps.workingDir,
    defaultBranch: deps.config.defaultBranch,
    repoUrl: deps.config.defaultRepoUrl,
    experimentalPlanner: deps.config.experimentalPlanner,
    timeoutMs: (deps.config.planningTimeoutSeconds ?? 7_200) * 1_000,
    log: deps.log,
  });

  let reply: string;
  try {
    reply = await conversation.sendMessage(goal);
  } catch (error) {
    return plannerError(errorMessage(error));
  }

  const yamlPlan = extractYamlPlan(reply);
  if (!yamlPlan) {
    return plannerError('Planner did not return a valid YAML plan.');
  }

  try {
    const preview = await deps.loadGeneratedPlan(yamlPlan);
    return {
      ok: true,
      planName: preview.planName,
      workflowId: preview.workflowId,
    };
  } catch (error) {
    return plannerError(errorMessage(error));
  }
}
