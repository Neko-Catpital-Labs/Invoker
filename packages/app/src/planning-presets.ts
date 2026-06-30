import type { PlanningPresetSpec } from '@invoker/contracts';

export const BUILTIN_PLANNING_PRESETS: Record<string, PlanningPresetSpec> = {
  'cursor+claude': { tool: 'cursor', model: 'claude' },
  'cursor+codex': { tool: 'cursor', model: 'codex' },
  'omp+claude': { tool: 'omp', model: 'claude' },
  'omp+codex': { tool: 'omp', model: 'codex' },
  omp: { tool: 'omp' },
  codex: { tool: 'codex' },
};

export const DEFAULT_PLANNING_PRESET = 'cursor+claude';

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
  const preferredPreset = presets[preferredPresetKey];
  const fallbackPreset = presets[fallbackPresetKey];
  const preset = preferredPreset ?? fallbackPreset ?? BUILTIN_PLANNING_PRESETS[DEFAULT_PLANNING_PRESET];
  const presetKey = preferredPreset
    ? preferredPresetKey
    : fallbackPreset
      ? fallbackPresetKey
      : DEFAULT_PLANNING_PRESET;
  return {
    presetKey,
    tool: preset.tool,
    model: preset.model,
  };
}
