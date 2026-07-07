// Config-aware prerequisite checks shared by `invoker-cli doctor` and the app launch check.
// Pure and browser-safe: callers inject the `isInstalled` probe (Node `spawn`) and the parsed
// config, so this module never imports `node:child_process`/`node:fs` (the UI bundles contracts).

import { DEFAULT_TOOL_REQUIREMENTS, type ToolRequirement } from './external-dependencies.ts';

export type PrerequisiteStatus = 'ok' | 'warn' | 'error';

export interface PrerequisiteCheck {
  id: string;
  name: string;
  status: PrerequisiteStatus;
  detail: string;
  remediation?: string;
}

export interface PlanningPresetSpec {
  tool: string;
  model?: string;
}

export type IsInstalled = (command: string) => boolean;


export function checkTool(req: ToolRequirement, isInstalled: IsInstalled): PrerequisiteCheck {
  if (isInstalled(req.command)) {
    return { id: req.id, name: req.name, status: 'ok', detail: `${req.command} found` };
  }
  return {
    id: req.id,
    name: req.name,
    status: req.required ? 'error' : 'warn',
    detail: `${req.command} not found (needed for ${req.requiredFor})`,
    remediation: req.installHint,
  };
}

/** Config readiness from a pre-read parse state, so this stays free of `node:fs`. */
export function checkConfig(state: { path: string; exists: boolean; error?: string }): PrerequisiteCheck {
  if (!state.exists) {
    return { id: 'config', name: 'Config file', status: 'ok', detail: `No config at ${state.path}; using defaults` };
  }
  if (!state.error) {
    return { id: 'config', name: 'Config file', status: 'ok', detail: `Parsed ${state.path}` };
  }
  return {
    id: 'config',
    name: 'Config file',
    status: 'error',
    detail: `Invalid JSON at ${state.path}`,
    remediation: `Fix the JSON syntax: ${state.error}`,
  };
}

/** The default planning preset must map to a tool on PATH — the gap behind silent cursor fallbacks. */
export function checkDefaultPresetTool(
  presets: Record<string, PlanningPresetSpec>,
  defaultPresetKey: string,
  isInstalled: IsInstalled,
): PrerequisiteCheck {
  const keys = Object.keys(presets);
  const preset = presets[defaultPresetKey];
  if (!preset) {
    return {
      id: 'default-preset',
      name: 'Default planning preset',
      status: 'error',
      detail: `Default preset "${defaultPresetKey}" is not defined`,
      remediation: keys.length
        ? `Set defaultSlackHarnessPreset to one of: ${keys.join(', ')}`
        : 'Define slackHarnessPresets and defaultSlackHarnessPreset in config',
    };
  }
  if (!isInstalled(preset.tool)) {
    return {
      id: 'default-preset',
      name: 'Default planning preset',
      status: 'error',
      detail: `Default preset "${defaultPresetKey}" needs "${preset.tool}", which is not on PATH`,
      remediation: `Install ${preset.tool}, or set defaultSlackHarnessPreset to a preset whose tool is installed`,
    };
  }
  return {
    id: 'default-preset',
    name: 'Default planning preset',
    status: 'ok',
    detail: `"${defaultPresetKey}" -> ${preset.tool} (installed)`,
  };
}

/** At least one configured preset's tool is installed, so some planning works. */
export function checkPlanningToolsPresent(
  presets: Record<string, PlanningPresetSpec>,
  isInstalled: IsInstalled,
): PrerequisiteCheck {
  const tools = [...new Set(Object.values(presets).map((p) => p.tool))];
  const installed = tools.filter(isInstalled);
  if (installed.length > 0) {
    return { id: 'planning-tools', name: 'Planning tools', status: 'ok', detail: `Installed: ${installed.join(', ')}` };
  }
  const wanted = tools.length ? tools.join(', ') : 'cursor, omp, codex';
  return {
    id: 'planning-tools',
    name: 'Planning tools',
    status: 'error',
    detail: `No planning tool installed (need one of: ${wanted})`,
    remediation: `Install at least one of: ${wanted}`,
  };
}

export interface PrerequisiteReport {
  ok: boolean;
  checks: PrerequisiteCheck[];
}

export function buildReport(checks: PrerequisiteCheck[]): PrerequisiteReport {
  return { ok: checks.every((c) => c.status !== 'error'), checks };
}

const STATUS_LABEL: Record<PrerequisiteStatus, string> = { ok: 'ok  ', warn: 'warn', error: 'FAIL' };

export function formatReport(report: PrerequisiteReport, options: { json?: boolean } = {}): string {
  if (options.json) return JSON.stringify(report);
  return report.checks
    .map((c) => {
      const head = `${STATUS_LABEL[c.status]}  ${c.name}: ${c.detail}`;
      return c.remediation && c.status !== 'ok' ? `${head}\n        -> ${c.remediation}` : head;
    })
    .join('\n');
}

export { DEFAULT_TOOL_REQUIREMENTS, type ToolRequirement };

export interface ReadinessInput {
  tools: ToolRequirement[];
  isInstalled: IsInstalled;
  config?: { path: string; exists: boolean; error?: string };
  /** Effective Slack planning presets (config or built-ins); empty skips preset checks. */
  presets?: Record<string, PlanningPresetSpec>;
  defaultPreset?: string;
}

/** Ordered prerequisite checks shared by `invoker-cli doctor` and the app launch check. */
export function assembleReadinessChecks(input: ReadinessInput): PrerequisiteCheck[] {
  const checks: PrerequisiteCheck[] = [];
  if (input.config) checks.push(checkConfig(input.config));
  for (const tool of input.tools) checks.push(checkTool(tool, input.isInstalled));
  const presets = input.presets ?? {};
  if (Object.keys(presets).length > 0) {
    checks.push(checkPlanningToolsPresent(presets, input.isInstalled));
    if (input.defaultPreset) checks.push(checkDefaultPresetTool(presets, input.defaultPreset, input.isInstalled));
  }
  return checks;
}
