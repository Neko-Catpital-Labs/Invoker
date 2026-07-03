import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import {
  DEFAULT_TOOL_REQUIREMENTS,
  assembleReadinessChecks,
  type PlanningPresetSpec,
  type PrerequisiteCheck,
  type SystemDiagnostics,
  type SystemToolStatus,
} from '@invoker/contracts';

/**
 * Exported only so the regression test in
 * `__tests__/system-diagnostics.test.ts` can call this directly to verify
 * the spawnSync timeout protects the Electron main thread from a CLI whose
 * version probe hangs (e.g. `docker --version` when Docker Desktop has been
 * installed but is not running).
 */
export function detectTool(
  id: string,
  name: string,
  command: string,
  versionArgs: string[],
  installHint: string,
  required = false,
): SystemToolStatus {
  // CRITICAL: spawnSync blocks the Electron main thread. If a CLI's daemon
  // is unreachable (e.g. `docker --version` when Docker Desktop is not
  // running), the child can hang indefinitely and wedge the entire app.
  // The 3s timeout + SIGKILL guarantees startup cannot stall here.
  const result = spawnSync(command, versionArgs, {
    encoding: 'utf8',
    timeout: 3000,
    killSignal: 'SIGKILL',
  });
  if (result.error) {
    return { id, name, required, installed: false, installHint };
  }
  if (result.signal === 'SIGKILL') {
    return { id, name, required, installed: false, installHint };
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    return { id, name, required, installed: false, installHint };
  }

  const version = [result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .trim()
    .split('\n')[0]
    ?.trim();

  return {
    id,
    name,
    required,
    installed: true,
    version: version || undefined,
    installHint,
  };
}

export function commandIsOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (command.includes('/') || command.includes('\\')) {
    return isExecutableFile(command);
  }
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      if (isExecutableFile(join(dir, command + ext))) return true;
    }
  }
  return false;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function versionArgsForTool(id: string): string[] {
  return id === 'ssh' ? ['-V'] : ['--version'];
}
export function collectSystemDiagnostics(args: {
  appVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  bundledSkills?: SystemDiagnostics['bundledSkills'];
  cliInstaller?: SystemDiagnostics['cliInstaller'];
  config?: { path: string; exists: boolean; error?: string };
  presets?: Record<string, PlanningPresetSpec>;
  defaultPreset?: string;
  toolDetector?: typeof detectTool;
  isInstalled?: (command: string) => boolean;
}): SystemDiagnostics & { readiness: PrerequisiteCheck[] } {
  const toolDetector = args.toolDetector ?? detectTool;
  const isInstalled = args.isInstalled ?? commandIsOnPath;
  const tools = DEFAULT_TOOL_REQUIREMENTS.map((req) =>
    toolDetector(req.id, req.name, req.command, versionArgsForTool(req.id), req.installHint ?? '', req.required ?? false),
  );

  const readiness = assembleReadinessChecks({
    tools: DEFAULT_TOOL_REQUIREMENTS,
    isInstalled,
    config: args.config,
    presets: args.presets,
    defaultPreset: args.defaultPreset,
  });
  return {
    platform: args.platform,
    arch: args.arch,
    appVersion: args.appVersion,
    isPackaged: args.isPackaged,
    bundledSkills: args.bundledSkills,
    cliInstaller: args.cliInstaller,
    tools,
    readiness,
  };
}
