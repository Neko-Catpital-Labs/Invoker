import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveInvokerHomeRoot } from '@invoker/contracts';

export type RecoveryWorkerState = 'created' | 'running' | 'stopped';

export interface RecoveryWorkerRuntimeStatus {
  kind: string;
  command: string;
  instanceId: string;
  ownerId?: string;
  pid: number;
  state: RecoveryWorkerState;
  intervalMs: number;
  tickCount: number;
  wakeCount: number;
  startedAt?: string;
  stoppedAt?: string;
  lastWakeupAt?: string;
  lastWakeupReason?: string;
  lastScanAt?: string;
  lastScanReason?: string;
  lastSubmitAt?: string;
  lastSubmitReason?: string;
  lastSkipAt?: string;
  lastSkipReason?: string;
  lastError?: string;
  updatedAt: string;
}

interface RecoveryWorkerStatusDocument {
  version: 1;
  updatedAt: string;
  workers: Record<string, RecoveryWorkerRuntimeStatus>;
}

export function recoveryWorkerStatusPath(invokerHomeRoot: string = resolveInvokerHomeRoot()): string {
  return join(invokerHomeRoot, 'recovery-worker-status.json');
}

function emptyDocument(): RecoveryWorkerStatusDocument {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    workers: {},
  };
}

function workerKey(status: Pick<RecoveryWorkerRuntimeStatus, 'kind' | 'instanceId'>): string {
  return `${status.kind}:${status.instanceId}`;
}

function readDocument(invokerHomeRoot: string): RecoveryWorkerStatusDocument {
  const file = recoveryWorkerStatusPath(invokerHomeRoot);
  if (!existsSync(file)) return emptyDocument();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<RecoveryWorkerStatusDocument>;
    if (parsed.version !== 1 || !parsed.workers || typeof parsed.workers !== 'object') {
      return emptyDocument();
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      workers: parsed.workers as Record<string, RecoveryWorkerRuntimeStatus>,
    };
  } catch {
    return emptyDocument();
  }
}

export function recordRecoveryWorkerStatus(
  status: RecoveryWorkerRuntimeStatus,
  invokerHomeRoot: string = resolveInvokerHomeRoot(),
): void {
  mkdirSync(invokerHomeRoot, { recursive: true });
  const document = readDocument(invokerHomeRoot);
  const updatedAt = new Date().toISOString();
  document.updatedAt = updatedAt;
  document.workers[workerKey(status)] = { ...status, updatedAt };

  const file = recoveryWorkerStatusPath(invokerHomeRoot);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export function readRecoveryWorkerStatuses(
  invokerHomeRoot: string = resolveInvokerHomeRoot(),
): RecoveryWorkerRuntimeStatus[] {
  return Object.values(readDocument(invokerHomeRoot).workers)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
