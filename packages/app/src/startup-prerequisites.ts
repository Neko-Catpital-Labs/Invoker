import { spawnSync } from 'node:child_process';
import {
  checkDefaultPresetTool,
  checkPlanningToolsPresent,
  type IsInstalled,
  type PlanningPresetSpec,
  type PrerequisiteCheck,
} from '@invoker/contracts';

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
  isInstalled: IsInstalled = commandExists,
): PrerequisiteCheck[] {
  if (Object.keys(presets).length === 0) return [];
  const checks = [
    checkPlanningToolsPresent(presets, isInstalled),
    checkDefaultPresetTool(presets, defaultPreset, isInstalled),
  ];
  return checks.filter((c) => c.status !== 'ok');
}
