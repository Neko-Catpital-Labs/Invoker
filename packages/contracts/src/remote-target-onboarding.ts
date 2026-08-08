import { spawn } from 'node:child_process';

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

export type RemoteTargetOnboardingErrorCode = 'duplicate-host' | 'duplicate-name' | 'invalid-remote-targets';

export interface RemoteTargetOnboardingError {
  code: RemoteTargetOnboardingErrorCode;
  message: string;
  conflictingTargetId?: string;
}

export type AddRemoteTargetResult =
  | { ok: true; config: InvokerConfigRecord }
  | { ok: false; error: RemoteTargetOnboardingError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  const targets = existing ?? {};
  if (Object.prototype.hasOwnProperty.call(targets, input.name)) {
    return {
      ok: false,
      error: {
        code: 'duplicate-name',
        message: `remote target "${input.name}" already exists`,
        conflictingTargetId: input.name,
      },
    };
  }

  for (const [id, target] of Object.entries(targets)) {
    if (isRecord(target) && target.host === input.host) {
      return {
        ok: false,
        error: {
          code: 'duplicate-host',
          message: `host "${input.host}" is already configured as remote target "${id}"`,
          conflictingTargetId: id,
        },
      };
    }
  }

  const entry: Record<string, unknown> = {
    host: input.host,
    user: input.user,
    sshKeyPath: input.sshKeyPath,
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(input.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: input.maxConcurrentTasks } : {}),
    ...(input.provisionCommand !== undefined ? { provisionCommand: input.provisionCommand } : {}),
  };

  return {
    ok: true,
    config: { ...config, remoteTargets: { ...targets, [input.name]: entry } },
  };
}

export interface RemoteTargetConnection {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
}

export interface RemoteTargetConnectivityResult {
  reachable: boolean;
  message: string;
}

export type RemoteTargetConnectivityImpl = (
  target: RemoteTargetConnection,
) => RemoteTargetConnectivityResult | Promise<RemoteTargetConnectivityResult>;

export interface CheckRemoteTargetConnectivityOptions {
  impl?: RemoteTargetConnectivityImpl;
  connectTimeoutSeconds?: number;
}

const DEFAULT_PROBE_CONNECT_TIMEOUT_SECONDS = 10;

export function buildConnectivityProbeArgs(
  target: RemoteTargetConnection,
  connectTimeoutSeconds: number = DEFAULT_PROBE_CONNECT_TIMEOUT_SECONDS,
): string[] {
  return [
    '-i', target.sshKeyPath,
    '-p', String(target.port ?? 22),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
    `${target.user}@${target.host}`,
    'exit 0',
  ];
}

export async function checkRemoteTargetConnectivity(
  target: RemoteTargetConnection,
  opts: CheckRemoteTargetConnectivityOptions = {},
): Promise<RemoteTargetConnectivityResult> {
  if (typeof opts.impl === 'function') {
    return opts.impl(target);
  }

  return new Promise((resolve) => {
    const child = spawn('ssh', buildConnectivityProbeArgs(target, opts.connectTimeoutSeconds), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ reachable: false, message: `failed to run ssh: ${error.message}` });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ reachable: true, message: `ssh probe to ${target.user}@${target.host} succeeded` });
        return;
      }
      resolve({ reachable: false, message: stderr.trim() || `ssh probe exited with code ${code}` });
    });
  });
}
