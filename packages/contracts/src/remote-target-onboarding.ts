// Shared write/check module for onboarding a machine into config.remoteTargets.
// `node:child_process` is imported lazily inside the real SSH probe so the module
// stays browser-safe for surfaces that bundle contracts.

import type { InvokerConfigRecord } from './invoker-config-io.ts';

export interface RemoteTargetInput {
  name: string;
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
  maxConcurrentTasks?: number;
  provisionCommand?: string;
}

export type AddRemoteTargetErrorCode = 'duplicate-host' | 'duplicate-name' | 'invalid-remote-targets';

export interface AddRemoteTargetError {
  code: AddRemoteTargetErrorCode;
  message: string;
  conflictingTargetName?: string;
}

export type AddRemoteTargetResult =
  | { ok: true; config: InvokerConfigRecord }
  | { ok: false; error: AddRemoteTargetError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildTargetEntry(input: RemoteTargetInput): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    host: input.host,
    user: input.user,
    sshKeyPath: input.sshKeyPath,
  };
  if (input.port !== undefined) entry.port = input.port;
  if (input.maxConcurrentTasks !== undefined) entry.maxConcurrentTasks = input.maxConcurrentTasks;
  if (input.provisionCommand !== undefined) entry.provisionCommand = input.provisionCommand;
  return entry;
}

export function addRemoteTarget(config: InvokerConfigRecord, input: RemoteTargetInput): AddRemoteTargetResult {
  const existing = config.remoteTargets;
  if (existing !== undefined && !isRecord(existing)) {
    return {
      ok: false,
      error: {
        code: 'invalid-remote-targets',
        message: 'remoteTargets must be an object keyed by target id',
      },
    };
  }

  const existingTargets = existing ?? {};
  if (Object.prototype.hasOwnProperty.call(existingTargets, input.name)) {
    return {
      ok: false,
      error: {
        code: 'duplicate-name',
        message: `remoteTargets already contains a target named "${input.name}"`,
        conflictingTargetName: input.name,
      },
    };
  }

  for (const [name, target] of Object.entries(existingTargets)) {
    if (isRecord(target) && target.host === input.host) {
      return {
        ok: false,
        error: {
          code: 'duplicate-host',
          message: `remoteTargets.${name} already uses host "${input.host}"`,
          conflictingTargetName: name,
        },
      };
    }
  }

  return {
    ok: true,
    config: {
      ...config,
      remoteTargets: { ...existingTargets, [input.name]: buildTargetEntry(input) },
    },
  };
}

export interface RemoteTargetConnectivitySpec {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
}

export interface RemoteTargetConnectivityResult {
  reachable: boolean;
  detail: string;
}

export type RemoteTargetConnectivityImpl = (
  target: RemoteTargetConnectivitySpec,
) => RemoteTargetConnectivityResult | Promise<RemoteTargetConnectivityResult>;

export interface CheckRemoteTargetConnectivityOptions {
  impl?: RemoteTargetConnectivityImpl;
  timeoutSeconds?: number;
}

export const DEFAULT_SSH_PROBE_TIMEOUT_SECONDS = 5;

export function sshProbeArgs(target: RemoteTargetConnectivitySpec, timeoutSeconds: number): string[] {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${timeoutSeconds}`,
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-i',
    target.sshKeyPath,
  ];
  if (target.port !== undefined) args.push('-p', String(target.port));
  args.push(`${target.user}@${target.host}`, 'exit 0');
  return args;
}

async function runSshProbe(
  target: RemoteTargetConnectivitySpec,
  timeoutSeconds: number,
): Promise<RemoteTargetConnectivityResult> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('ssh', sshProbeArgs(target, timeoutSeconds), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ reachable: false, detail: `ssh probe failed to start: ${error.message}` });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ reachable: true, detail: `ssh ${target.user}@${target.host} is reachable` });
        return;
      }
      resolve({
        reachable: false,
        detail: stderr.trim() || `ssh probe exited with code ${String(code)}`,
      });
    });
  });
}

export async function checkRemoteTargetConnectivity(
  target: RemoteTargetConnectivitySpec,
  opts: CheckRemoteTargetConnectivityOptions = {},
): Promise<RemoteTargetConnectivityResult> {
  if (typeof opts.impl === 'function') {
    return await opts.impl(target);
  }
  return runSshProbe(target, opts.timeoutSeconds ?? DEFAULT_SSH_PROBE_TIMEOUT_SECONDS);
}
