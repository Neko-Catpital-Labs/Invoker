import {
  BUILTIN_PLANNING_PRESETS,
  DEFAULT_PLANNING_PRESET,
  resolvePlanningPresetByKey,
  type PlanningPresetSpec,
} from '@invoker/contracts';

export { BUILTIN_PLANNING_PRESETS, DEFAULT_PLANNING_PRESET };

export function resolvePlanningPreset(
  harnessPreset: string | undefined,
  slackHarnessPresets: Record<string, PlanningPresetSpec> | undefined,
  defaultSlackHarnessPreset: string | undefined,
): PlanningPresetSpec & { presetKey: string } {
  const presets = {
    ...BUILTIN_PLANNING_PRESETS,
    ...(slackHarnessPresets ?? {}),
  };
  const preferredPresetKey = harnessPreset ?? defaultSlackHarnessPreset ?? DEFAULT_PLANNING_PRESET;
  const fallbackPresetKey = defaultSlackHarnessPreset ?? DEFAULT_PLANNING_PRESET;
  const preferred = resolvePlanningPresetByKey(presets, preferredPresetKey);
  if (preferred) {
    return {
      presetKey: preferredPresetKey,
      tool: preferred.tool as PlanningPresetSpec['tool'],
      model: preferred.model,
    };
  }
  const fallback = resolvePlanningPresetByKey(presets, fallbackPresetKey)
    ?? BUILTIN_PLANNING_PRESETS[DEFAULT_PLANNING_PRESET];
  return {
    presetKey: fallbackPresetKey,
    tool: fallback.tool as PlanningPresetSpec['tool'],
    model: fallback.model,
  };
}
