import { spawn } from 'node:child_process';

import type { InvokerConfigRecord } from './invoker-config-io.ts';

export interface RemoteTargetConnection {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
}

export interface RemoteTargetInput extends RemoteTargetConnection {
  id: string;
  maxConcurrentTasks?: number;
  provisionCommand?: string;
}

export type AddRemoteTargetErrorCode = 'duplicate-host' | 'duplicate-target-id' | 'invalid-remote-targets';

export interface AddRemoteTargetSuccess {
  ok: true;
  config: InvokerConfigRecord;
}

export interface AddRemoteTargetError {
  ok: false;
  code: AddRemoteTargetErrorCode;
  message: string;
}

export type AddRemoteTargetResult = AddRemoteTargetSuccess | AddRemoteTargetError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildRemoteTargetEntry(input: RemoteTargetInput): Record<string, unknown> {
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
      code: 'invalid-remote-targets',
      message: 'remoteTargets must be an object keyed by target id',
    };
  }

  const remoteTargets = existing ?? {};

  if (Object.prototype.hasOwnProperty.call(remoteTargets, input.id)) {
    return {
      ok: false,
      code: 'duplicate-target-id',
      message: `remoteTargets already contains a target named "${input.id}"`,
    };
  }

  for (const [id, target] of Object.entries(remoteTargets)) {
    if (isRecord(target) && target.host === input.host) {
      return {
        ok: false,
        code: 'duplicate-host',
        message: `remoteTargets.${id} already uses host "${input.host}"`,
      };
    }
  }

  return {
    ok: true,
    config: {
      ...config,
      remoteTargets: { ...remoteTargets, [input.id]: buildRemoteTargetEntry(input) },
    },
  };
}

export interface RemoteTargetConnectivityResult {
  reachable: boolean;
  detail: string;
}

export type RemoteTargetConnectivityImpl = (
  target: RemoteTargetConnection,
) => RemoteTargetConnectivityResult | Promise<RemoteTargetConnectivityResult>;

export interface CheckRemoteTargetConnectivityOptions {
  impl?: RemoteTargetConnectivityImpl;
}

const SSH_PROBE_CONNECT_TIMEOUT_SECONDS = 10;

function probeSshReachability(target: RemoteTargetConnection): Promise<RemoteTargetConnectivityResult> {
  const args = [
    '-i', target.sshKeyPath,
    '-p', String(target.port ?? 22),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${SSH_PROBE_CONNECT_TIMEOUT_SECONDS}`,
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
      resolve({ reachable: false, detail: `failed to launch ssh: ${error.message}` });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ reachable: true, detail: `ssh probe to ${target.user}@${target.host} succeeded` });
        return;
      }
      const trimmed = stderr.trim();
      resolve({
        reachable: false,
        detail: trimmed.length > 0 ? trimmed : `ssh probe exited with code ${code ?? 'unknown'}`,
      });
    });
  });
}

export async function checkRemoteTargetConnectivity(
  target: RemoteTargetConnection,
  opts?: CheckRemoteTargetConnectivityOptions,
): Promise<RemoteTargetConnectivityResult> {
  if (typeof opts?.impl === 'function') {
    return await opts.impl(target);
  }
  return probeSshReachability(target);
}
