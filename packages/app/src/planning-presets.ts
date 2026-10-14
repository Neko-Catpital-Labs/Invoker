import {
  BUILTIN_PLANNING_PRESETS,
  DEFAULT_PLANNING_PRESET,
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
  const preset = presets[preferredPresetKey] ?? presets[fallbackPresetKey] ?? BUILTIN_PLANNING_PRESETS[DEFAULT_PLANNING_PRESET];
  const presetKey = presets[preferredPresetKey] ? preferredPresetKey : fallbackPresetKey;
  return {
    presetKey,
    tool: preset.tool,
    model: preset.model,
  };
}
