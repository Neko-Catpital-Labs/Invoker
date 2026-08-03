import { spawn } from 'node:child_process';

export interface RemoteTargetInput {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
  maxConcurrentTasks?: number;
  provisionCommand?: string;
}

export interface RemoteTargetOnboardingConfig {
  remoteTargets?: RemoteTargetInput[];
  [key: string]: unknown;
}

export interface AddRemoteTargetError {
  code: 'duplicate-host';
  host: string;
  message: string;
}

export type AddRemoteTargetResult =
  | { ok: true; config: RemoteTargetOnboardingConfig }
  | { ok: false; error: AddRemoteTargetError };

export function addRemoteTarget(
  config: RemoteTargetOnboardingConfig,
  input: RemoteTargetInput,
): AddRemoteTargetResult {
  const existing = config.remoteTargets ?? [];
  if (existing.some((target) => target.host === input.host)) {
    return {
      ok: false,
      error: {
        code: 'duplicate-host',
        host: input.host,
        message: `A remote target with host "${input.host}" already exists`,
      },
    };
  }
  return { ok: true, config: { ...config, remoteTargets: [...existing, input] } };
}

export interface RemoteTargetConnectivityResult {
  reachable: boolean;
  detail: string;
}

export type RemoteTargetConnectivityImpl = (
  target: RemoteTargetInput,
) => RemoteTargetConnectivityResult | Promise<RemoteTargetConnectivityResult>;

export interface CheckRemoteTargetConnectivityOptions {
  impl?: RemoteTargetConnectivityImpl;
  connectTimeoutSeconds?: number;
}

export async function checkRemoteTargetConnectivity(
  target: RemoteTargetInput,
  opts: CheckRemoteTargetConnectivityOptions = {},
): Promise<RemoteTargetConnectivityResult> {
  if (typeof opts.impl === 'function') {
    return opts.impl(target);
  }
  return probeSshReachability(target, opts.connectTimeoutSeconds ?? 10);
}

function probeSshReachability(
  target: RemoteTargetInput,
  connectTimeoutSeconds: number,
): Promise<RemoteTargetConnectivityResult> {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${connectTimeoutSeconds}`,
    '-i',
    target.sshKeyPath,
    '-p',
    String(target.port ?? 22),
    `${target.user}@${target.host}`,
    'true',
  ];

  return new Promise((resolve) => {
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({ reachable: false, detail: `Failed to run ssh: ${error.message}` });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ reachable: true, detail: `Connected to ${target.user}@${target.host}` });
      } else {
        resolve({
          reachable: false,
          detail: stderr.trim() || `ssh exited with code ${code}`,
        });
      }
    });
  });
}
