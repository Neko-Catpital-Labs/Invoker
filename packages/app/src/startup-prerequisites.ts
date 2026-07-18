import { spawnSync } from 'node:child_process';
import {
  checkDefaultPresetTool,
  checkPlanningToolsPresent,
  type IsInstalled,
  type PlanningPresetSpec,
  type PrerequisiteCheck,
} from '@invoker/contracts';
import { BUILTIN_PLANNING_PRESETS } from './planning-presets.js';

/** True when `command` resolves on PATH. */
export function commandExists(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${command} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

/**
 * Config-aware launch checks: is the effective default planning preset's tool installed, and is
 * any planning tool present. Returns only failing checks so callers can warn (never block) on launch.
 *
 * Invoker never declares what a host has installed — it only probes PATH here. Whether a chosen
 * harness can actually run is the host's provisioning responsibility; a missing binary surfaces as
 * a runtime failure from the tool itself, not a pre-declared capability gate.
 */
export function runStartupPrerequisites(
  presets: Record<string, PlanningPresetSpec>,
  defaultPreset: string,
  isInstalled: IsInstalled = commandExists,
): PrerequisiteCheck[] {
  const availablePresets = { ...BUILTIN_PLANNING_PRESETS, ...presets };
  const checks = [
    checkPlanningToolsPresent(availablePresets, isInstalled),
    checkDefaultPresetTool(availablePresets, defaultPreset, isInstalled),
  ];
  return checks.filter((c) => c.status !== 'ok');
}
