import { spawnSync } from 'node:child_process';

import type { SystemDiagnostics, SystemToolStatus } from '@invoker/contracts';

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

export function collectSystemDiagnostics(args: {
  appVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  bundledSkills?: SystemDiagnostics['bundledSkills'];
  cliInstaller?: SystemDiagnostics['cliInstaller'];
}): SystemDiagnostics {
  return {
    platform: args.platform,
    arch: args.arch,
    appVersion: args.appVersion,
    isPackaged: args.isPackaged,
    bundledSkills: args.bundledSkills,
    cliInstaller: args.cliInstaller,
    tools: [
      detectTool('git', 'Git', 'git', ['--version'], 'Install Git before running workflows.', true),
      detectTool('node', 'Node.js', 'node', ['--version'], 'Install Node.js 26 for repo-based workflows.'),
      detectTool('pnpm', 'pnpm', 'pnpm', ['--version'], 'Install pnpm for repo-based workflows that use the default provision command.'),
      detectTool('claude', 'Claude CLI', 'claude', ['--version'], 'Install Claude CLI if you want Claude-backed execution or fix flows.'),
      detectTool('codex', 'Codex CLI', 'codex', ['--version'], 'Install Codex CLI if you want Codex-backed execution or fix flows.'),
      detectTool('docker', 'Docker', 'docker', ['--version'], 'Install Docker if you want Docker executor support.'),
    ],
  };
}
