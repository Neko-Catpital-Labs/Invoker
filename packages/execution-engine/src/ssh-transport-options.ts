export interface SshTargetConnection {
  sshKeyPath: string;
  port?: number;
  user: string;
  host: string;
}

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 15;
const DEFAULT_SERVER_ALIVE_INTERVAL_SECONDS = 30;
const DEFAULT_SERVER_ALIVE_COUNT_MAX = 3;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function buildSshTransportOptions(opts: { batchMode: boolean }): string[] {
  const connectTimeout = readPositiveIntEnv(
    'INVOKER_SSH_CONNECT_TIMEOUT_SECONDS',
    DEFAULT_CONNECT_TIMEOUT_SECONDS,
  );
  const serverAliveInterval = readPositiveIntEnv(
    'INVOKER_SSH_SERVER_ALIVE_INTERVAL_SECONDS',
    DEFAULT_SERVER_ALIVE_INTERVAL_SECONDS,
  );
  const serverAliveCountMax = readPositiveIntEnv(
    'INVOKER_SSH_SERVER_ALIVE_COUNT_MAX',
    DEFAULT_SERVER_ALIVE_COUNT_MAX,
  );

  return [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${connectTimeout}`,
    '-o', `ServerAliveInterval=${serverAliveInterval}`,
    '-o', `ServerAliveCountMax=${serverAliveCountMax}`,
    ...(opts.batchMode ? ['-o', 'BatchMode=yes'] : []),
  ];
}

export function buildSshConnectionArgs(
  target: SshTargetConnection,
  opts: { batchMode: boolean },
): string[] {
  return [
    '-i', target.sshKeyPath,
    '-p', String(target.port ?? 22),
    ...buildSshTransportOptions({ batchMode: opts.batchMode }),
    `${target.user}@${target.host}`,
  ];
}
