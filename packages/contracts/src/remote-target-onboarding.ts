import { spawn } from 'node:child_process';

import type { InvokerConfigRecord } from './invoker-config-io.ts';

export interface RemoteTargetSpec {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
  maxConcurrentTasks?: number;
  provisionCommand?: string;
  [extra: string]: unknown;
}

export interface AddRemoteTargetInput extends RemoteTargetSpec {
  id: string;
}

export type AddRemoteTargetErrorCode = 'duplicate-host' | 'duplicate-id';

export interface AddRemoteTargetError {
  code: AddRemoteTargetErrorCode;
  message: string;
  conflictingTargetId: string;
}

export type AddRemoteTargetResult =
  | { ok: true; config: InvokerConfigRecord }
  | { ok: false; error: AddRemoteTargetError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(
  code: AddRemoteTargetErrorCode,
  conflictingTargetId: string,
  message: string,
): AddRemoteTargetResult {
  return { ok: false, error: { code, message, conflictingTargetId } };
}

export function addRemoteTarget(
  config: InvokerConfigRecord,
  input: AddRemoteTargetInput,
): AddRemoteTargetResult {
  const existing = isRecord(config.remoteTargets) ? config.remoteTargets : {};

  if (Object.prototype.hasOwnProperty.call(existing, input.id)) {
    return failure(
      'duplicate-id',
      input.id,
      `remoteTargets.${input.id} already exists; choose a different target id`,
    );
  }

  for (const [id, target] of Object.entries(existing)) {
    if (isRecord(target) && target.host === input.host) {
      return failure(
        'duplicate-host',
        id,
        `remoteTargets.${id} already uses host ${input.host}`,
      );
    }
  }

  const { id, ...targetFields } = input;
  return {
    ok: true,
    config: {
      ...config,
      remoteTargets: { ...existing, [id]: targetFields },
    },
  };
}

export interface RemoteTargetConnectivityResult {
  reachable: boolean;
  detail: string;
}

export type RemoteTargetConnectivityImpl = (
  target: RemoteTargetSpec,
) => RemoteTargetConnectivityResult | Promise<RemoteTargetConnectivityResult>;

export interface CheckRemoteTargetConnectivityOptions {
  impl?: RemoteTargetConnectivityImpl;
  connectTimeoutSeconds?: number;
}

const DEFAULT_PROBE_CONNECT_TIMEOUT_SECONDS = 10;

export async function checkRemoteTargetConnectivity(
  target: RemoteTargetSpec,
  opts?: CheckRemoteTargetConnectivityOptions,
): Promise<RemoteTargetConnectivityResult> {
  if (typeof opts?.impl === 'function') {
    return await opts.impl(target);
  }
  return runSshReachabilityProbe(
    target,
    opts?.connectTimeoutSeconds ?? DEFAULT_PROBE_CONNECT_TIMEOUT_SECONDS,
  );
}

function runSshReachabilityProbe(
  target: RemoteTargetSpec,
  connectTimeoutSeconds: number,
): Promise<RemoteTargetConnectivityResult> {
  const destination = `${target.user}@${target.host}`;
  const args = [
    '-i', target.sshKeyPath,
    '-p', String(target.port ?? 22),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
    destination,
    'exit 0',
  ];

  return new Promise((resolve) => {
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ reachable: false, detail: `failed to run ssh: ${error.message}` });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ reachable: true, detail: `ssh probe to ${destination} succeeded` });
        return;
      }
      const trimmed = stderr.trim();
      resolve({
        reachable: false,
        detail: trimmed.length > 0
          ? `ssh probe to ${destination} exited with code ${code}: ${trimmed}`
          : `ssh probe to ${destination} exited with code ${code}`,
      });
    });
  });
}
