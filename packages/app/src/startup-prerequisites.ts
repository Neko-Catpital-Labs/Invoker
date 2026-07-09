import { spawnSync } from 'node:child_process';
import {
  checkDefaultPresetTool,
  checkPlanningToolsPresent,
  type IsInstalled,
  type PlanningPresetSpec,
  type PrerequisiteCheck,
} from '@invoker/contracts';
import { resolveHarnessSelection, type MachineCapabilities } from '@invoker/execution-engine';
import { resolvePlanningPreset, BUILTIN_PLANNING_PRESETS } from './planning-presets.js';

/** True when `command` resolves on PATH. */
export function commandExists(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${command} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

/**
 * Config-aware launch checks: is the effective default planning preset's tool installed, and is
 * any planning tool present. Returns only failing checks so callers can warn (never block) on launch.
 */
export function runStartupPrerequisites(
  presets: Record<string, PlanningPresetSpec>,
  defaultPreset: string,
  capabilities?: MachineCapabilities,
  isInstalled: IsInstalled = commandExists,
): PrerequisiteCheck[] {
  const availablePresets = { ...BUILTIN_PLANNING_PRESETS, ...presets };
  const defaultPresetCheck = checkDefaultPresetTool(availablePresets, defaultPreset, isInstalled);
  const checks = [
    checkPlanningToolsPresent(availablePresets, isInstalled),
    defaultPresetCheck,
  ];
  if (capabilities && defaultPresetCheck.status === 'ok') {
    const resolvedPreset = resolvePlanningPreset(undefined, presets, defaultPreset);
    const match = resolveHarnessSelection(capabilities, {
      role: 'planning',
      harness: resolvedPreset.tool,
      model: resolvedPreset.model,
    });
    if (!match.ok) {
      checks.push({
        id: 'default-preset-capability',
        name: 'Default planning preset',
        status: 'error',
        detail: `Default preset "${resolvedPreset.presetKey}" is unsupported by this host: ${match.reason}`,
        remediation: 'Change defaultSlackHarnessPreset or update capabilities.planning on this host.',
      });
    }
  }
  return checks.filter((c) => c.status !== 'ok');
}
