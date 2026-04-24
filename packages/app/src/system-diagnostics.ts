import { spawnSync } from 'node:child_process';

import type { SystemDiagnostics, SystemToolStatus } from '@invoker/contracts';

function detectTool(
  id: string,
  name: string,
  command: string,
  versionArgs: string[],
  installHint: string,
  required = false,
): SystemToolStatus {
  const result = spawnSync(command, versionArgs, { encoding: 'utf8' });
  if (result.error) {
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
}): SystemDiagnostics {
  return {
    platform: args.platform,
    arch: args.arch,
    appVersion: args.appVersion,
    isPackaged: args.isPackaged,
    bundledSkills: args.bundledSkills,
    tools: [
      detectTool('git', 'Git', 'git', ['--version'], 'Install Git before running workflows.', true),
      detectTool('node', 'Node.js', 'node', ['--version'], 'Install Node.js 22 or newer for repo-based workflows.'),
      detectTool('pnpm', 'pnpm', 'pnpm', ['--version'], 'Install pnpm for repo-based workflows that use the default provision command.'),
      detectTool('claude', 'Claude CLI', 'claude', ['--version'], 'Install Claude CLI if you want Claude-backed execution or fix flows.'),
      detectTool('codex', 'Codex CLI', 'codex', ['--version'], 'Install Codex CLI if you want Codex-backed execution or fix flows.'),
      detectTool('docker', 'Docker', 'docker', ['--version'], 'Install Docker if you want Docker executor support.'),
    ],
  };
}
