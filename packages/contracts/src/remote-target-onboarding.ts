import { execFile } from 'node:child_process';

import type { InvokerConfigRecord } from './invoker-config-io.ts';

export interface RemoteTargetSpec {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
  maxConcurrentTasks?: number;
  provisionCommand?: string;
  [key: string]: unknown;
}

export interface AddRemoteTargetInput extends RemoteTargetSpec {
  name: string;
}

export type AddRemoteTargetErrorCode = 'duplicate-host' | 'duplicate-name' | 'invalid-remote-targets';

export type AddRemoteTargetResult =
  | { ok: true; config: InvokerConfigRecord }
  | { ok: false; error: { code: AddRemoteTargetErrorCode; message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function addRemoteTarget(config: InvokerConfigRecord, input: AddRemoteTargetInput): AddRemoteTargetResult {
  const existing = config.remoteTargets;
  if (existing !== undefined && !isRecord(existing)) {
    return {
      ok: false,
      error: { code: 'invalid-remote-targets', message: 'remoteTargets must be an object keyed by target id' },
    };
  }

  const targets = existing ?? {};
  if (Object.prototype.hasOwnProperty.call(targets, input.name)) {
    return {
      ok: false,
      error: { code: 'duplicate-name', message: `remote target "${input.name}" already exists` },
    };
  }
  for (const [name, target] of Object.entries(targets)) {
    if (isRecord(target) && target.host === input.host) {
      return {
        ok: false,
        error: { code: 'duplicate-host', message: `host "${input.host}" is already used by remote target "${name}"` },
      };
    }
  }

  const { name, ...spec } = input;
  const entry: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (value !== undefined) entry[key] = value;
  }

  return { ok: true, config: { ...config, remoteTargets: { ...targets, [name]: entry } } };
}

export interface RemoteTargetConnectivityResult {
  ok: boolean;
  message?: string;
}

export type RemoteTargetConnectivityImpl = (
  target: RemoteTargetSpec,
) => RemoteTargetConnectivityResult | Promise<RemoteTargetConnectivityResult>;

export interface CheckRemoteTargetConnectivityOptions {
  impl?: RemoteTargetConnectivityImpl;
  timeoutSeconds?: number;
}

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;

export function remoteTargetProbeArgs(target: RemoteTargetSpec, timeoutSeconds: number): string[] {
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
  args.push(`${target.user}@${target.host}`, 'true');
  return args;
}

export async function checkRemoteTargetConnectivity(
  target: RemoteTargetSpec,
  opts: CheckRemoteTargetConnectivityOptions = {},
): Promise<RemoteTargetConnectivityResult> {
  if (typeof opts.impl === 'function') {
    return await opts.impl(target);
  }

  const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
  const args = remoteTargetProbeArgs(target, timeoutSeconds);

  return await new Promise((resolve) => {
    execFile('ssh', args, { timeout: (timeoutSeconds + 5) * 1000 }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve({ ok: true });
        return;
      }
      const detail = stderr.trim() || error.message;
      resolve({ ok: false, message: `ssh probe to ${target.user}@${target.host} failed: ${detail}` });
    });
  });
}
