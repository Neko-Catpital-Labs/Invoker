import type { InvokerConfigRecord } from './invoker-config-io.ts';

export interface RemoteTargetInput {
  id: string;
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
  maxConcurrentTasks?: number;
  provisionCommand?: string;
}

export interface AddRemoteTargetError {
  code: 'duplicate-id' | 'duplicate-host';
  message: string;
  conflictingTargetId: string;
}

export type AddRemoteTargetResult =
  | { ok: true; config: InvokerConfigRecord }
  | { ok: false; error: AddRemoteTargetError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function existingRemoteTargets(config: InvokerConfigRecord): Record<string, unknown> {
  return isRecord(config.remoteTargets) ? config.remoteTargets : {};
}

export function addRemoteTarget(config: InvokerConfigRecord, input: RemoteTargetInput): AddRemoteTargetResult {
  const targets = existingRemoteTargets(config);

  if (Object.prototype.hasOwnProperty.call(targets, input.id)) {
    return {
      ok: false,
      error: {
        code: 'duplicate-id',
        message: `remoteTargets already contains a target with id "${input.id}"`,
        conflictingTargetId: input.id,
      },
    };
  }

  for (const [id, target] of Object.entries(targets)) {
    if (isRecord(target) && target.host === input.host) {
      return {
        ok: false,
        error: {
          code: 'duplicate-host',
          message: `remoteTargets."${id}" already uses host "${input.host}"`,
          conflictingTargetId: id,
        },
      };
    }
  }

  const entry: Record<string, unknown> = {
    host: input.host,
    user: input.user,
    sshKeyPath: input.sshKeyPath,
  };
  if (input.port !== undefined) entry.port = input.port;
  if (input.maxConcurrentTasks !== undefined) entry.maxConcurrentTasks = input.maxConcurrentTasks;
  if (input.provisionCommand !== undefined) entry.provisionCommand = input.provisionCommand;

  return {
    ok: true,
    config: {
      ...config,
      remoteTargets: { ...targets, [input.id]: entry },
    },
  };
}

export interface RemoteTargetConnectionSpec {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
}

export interface RemoteTargetConnectivityResult {
  reachable: boolean;
  message?: string;
}

export type RemoteTargetConnectivityImpl = (
  target: RemoteTargetConnectionSpec,
) => RemoteTargetConnectivityResult | Promise<RemoteTargetConnectivityResult>;

export interface CheckRemoteTargetConnectivityOptions {
  impl?: RemoteTargetConnectivityImpl;
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export async function checkRemoteTargetConnectivity(
  target: RemoteTargetConnectionSpec,
  opts?: CheckRemoteTargetConnectivityOptions,
): Promise<RemoteTargetConnectivityResult> {
  if (typeof opts?.impl === 'function') {
    return await opts.impl(target);
  }
  return runSshProbe(target, opts?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
}

async function runSshProbe(
  target: RemoteTargetConnectionSpec,
  timeoutMs: number,
): Promise<RemoteTargetConnectivityResult> {
  // Lazy import keeps this module browser-safe for the UI bundle (see prerequisites.ts).
  const { spawn } = await import('node:child_process');
  const connectTimeoutSeconds = Math.max(1, Math.floor(timeoutMs / 1000));

  return new Promise((resolve) => {
    const child = spawn(
      'ssh',
      [
        '-i',
        target.sshKeyPath,
        '-p',
        String(target.port ?? 22),
        '-o',
        'BatchMode=yes',
        '-o',
        `ConnectTimeout=${connectTimeoutSeconds}`,
        '-o',
        'StrictHostKeyChecking=accept-new',
        `${target.user}@${target.host}`,
        'exit 0',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    let settled = false;
    const settle = (result: RemoteTargetConnectivityResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ reachable: false, message: `ssh probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      settle({ reachable: false, message: `failed to run ssh: ${error.message}` });
    });
    child.on('close', (code) => {
      if (code === 0) {
        settle({ reachable: true });
        return;
      }
      const detail = stderr.trim();
      settle({
        reachable: false,
        message: detail.length > 0 ? detail : `ssh exited with code ${code}`,
      });
    });
  });
}
