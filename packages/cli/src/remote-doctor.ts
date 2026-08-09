import {
  buildSshConnectionArgs,
  execRemoteCapture,
  shellPosixSingleQuote,
  type SshTargetConnection,
} from '@invoker/execution-engine';
import type { PrerequisiteCheck } from '@invoker/contracts';

const REQUIRED_REMOTE_TOOLS = [
  { id: 'git', name: 'Git (remote)', command: 'git' },
  { id: 'node', name: 'Node (remote)', command: 'node' },
  { id: 'pnpm', name: 'pnpm (remote)', command: 'pnpm' },
] as const;

const DISK_WARN_THRESHOLD_KB = 1 * 1024 * 1024; // 1 GiB, df -Pk reports 1024-byte blocks

export type ExecRemoteCaptureImpl = typeof execRemoteCapture;

export interface RunRemoteDoctorChecksOptions {
  target: SshTargetConnection;
  repoUrl: string;
  execRemoteCaptureImpl?: ExecRemoteCaptureImpl;
}

function buildDoctorScript(repoUrl: string): string {
  const toolChecks = REQUIRED_REMOTE_TOOLS
    .map((tool) => `if command -v ${tool.command} >/dev/null 2>&1; then echo "check:${tool.id}:ok"; else echo "check:${tool.id}:missing"; fi`)
    .join('\n');

  return [
    'set -u',
    'export GIT_TERMINAL_PROMPT=0',
    'export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"',
    toolChecks,
    'disk_kb=$(df -Pk "$HOME" 2>/dev/null | awk \'NR==2{print $4}\')',
    'echo "disk_kb:${disk_kb:-unknown}"',
    `if timeout 30 git ls-remote ${shellPosixSingleQuote(repoUrl)} >/dev/null 2>&1; then echo "check:push-auth:ok"; else echo "check:push-auth:missing"; fi`,
    'exit 0',
  ].join('\n');
}

function parseDoctorOutput(stdout: string): RunRemoteDoctorChecksResults {
  const lines = stdout.split('\n');
  const checkStatus = new Map<string, 'ok' | 'missing'>();
  let diskKb: number | undefined;

  for (const line of lines) {
    const checkMatch = line.match(/^check:([a-z-]+):(ok|missing)$/);
    if (checkMatch) {
      checkStatus.set(checkMatch[1], checkMatch[2] as 'ok' | 'missing');
      continue;
    }
    const diskMatch = line.match(/^disk_kb:(\d+|unknown)$/);
    if (diskMatch && diskMatch[1] !== 'unknown') {
      diskKb = Number.parseInt(diskMatch[1], 10);
    }
  }

  return { checkStatus, diskKb };
}

interface RunRemoteDoctorChecksResults {
  checkStatus: Map<string, 'ok' | 'missing'>;
  diskKb: number | undefined;
}

function toolCheckResult(id: string, name: string, status: 'ok' | 'missing' | undefined): PrerequisiteCheck {
  if (status === 'ok') {
    return { id, name, status: 'ok', detail: `${name} found on remote box` };
  }
  return {
    id,
    name,
    status: 'error',
    detail: status === 'missing' ? `${name} not found on remote box` : `${name} check did not report a result`,
    remediation: 'Install the missing tool on the remote box, then re-run `invoker-cli setup machines`.',
  };
}

function diskCheckResult(diskKb: number | undefined): PrerequisiteCheck {
  if (diskKb === undefined) {
    return {
      id: 'disk-space',
      name: 'Disk space (remote)',
      status: 'warn',
      detail: 'Could not determine free disk space on the remote box',
    };
  }
  if (diskKb < DISK_WARN_THRESHOLD_KB) {
    return {
      id: 'disk-space',
      name: 'Disk space (remote)',
      status: 'warn',
      detail: `Only ${Math.round(diskKb / 1024)} MiB free on the remote box (below the ${Math.round(DISK_WARN_THRESHOLD_KB / 1024)} MiB warning threshold)`,
      remediation: 'Free up disk space on the remote box before routing heavy tasks to it.',
    };
  }
  return {
    id: 'disk-space',
    name: 'Disk space (remote)',
    status: 'ok',
    detail: `${Math.round(diskKb / 1024)} MiB free on the remote box`,
  };
}

function pushAuthCheckResult(repoUrl: string, status: 'ok' | 'missing' | undefined): PrerequisiteCheck {
  if (status === 'ok') {
    return { id: 'push-auth', name: 'GitHub push credentials (remote)', status: 'ok', detail: `Remote box can reach ${repoUrl}` };
  }
  return {
    id: 'push-auth',
    name: 'GitHub push credentials (remote)',
    status: 'error',
    detail: `Remote box could not reach ${repoUrl} with its own git credentials`,
    remediation: 'Give the remote box its own way to authenticate to GitHub (deploy key, ssh-agent forwarding, or an HTTPS credential helper), then re-run `invoker-cli setup machines`.',
  };
}

/**
 * Runs a bundle of readiness probes on a remote SSH target in a single round trip:
 * required tools present, free disk space, and whether the box's own git credentials
 * can reach the task's repo. `repoUrl`'s `sshKeyPath` never enters this remote script —
 * git push authenticates independently on the remote box, so this is the only way to
 * catch a missing push credential before a real task fails at the finish line.
 */
export async function runRemoteDoctorChecks(options: RunRemoteDoctorChecksOptions): Promise<PrerequisiteCheck[]> {
  const sshArgs = buildSshConnectionArgs(options.target, { batchMode: true });
  const script = buildDoctorScript(options.repoUrl);
  const runCapture = options.execRemoteCaptureImpl ?? execRemoteCapture;

  let stdout: string;
  try {
    stdout = await runCapture({ sshArgs, script, phase: 'remote-doctor' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = `Could not run readiness checks on the remote box: ${message}`;
    return [
      ...REQUIRED_REMOTE_TOOLS.map((tool) => ({ id: tool.id, name: tool.name, status: 'error' as const, detail })),
      { id: 'disk-space', name: 'Disk space (remote)', status: 'warn' as const, detail },
      { id: 'push-auth', name: 'GitHub push credentials (remote)', status: 'error' as const, detail },
    ];
  }

  const { checkStatus, diskKb } = parseDoctorOutput(stdout);

  return [
    ...REQUIRED_REMOTE_TOOLS.map((tool) => toolCheckResult(tool.id, tool.name, checkStatus.get(tool.id))),
    diskCheckResult(diskKb),
    pushAuthCheckResult(options.repoUrl, checkStatus.get('push-auth')),
  ];
}
