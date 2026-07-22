import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export interface SlackConsumerLockRecord {
  pid: number;
  instanceId: string;
  acquiredAt: number;
}

export interface SlackConsumerLock {
  readonly path: string;
  readonly record: SlackConsumerLockRecord;
  release(): void;
}

export class SlackConsumerLockHeldError extends Error {
  constructor(readonly holder: SlackConsumerLockRecord, readonly lockPath: string) {
    super(`Slack Socket Mode is already owned by pid ${holder.pid} (instance ${holder.instanceId}). Lock: ${lockPath}`);
    this.name = 'SlackConsumerLockHeldError';
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readRecord(lockPath: string): SlackConsumerLockRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<SlackConsumerLockRecord>;
    if (
      !Number.isInteger(record.pid)
      || record.pid! <= 0
      || typeof record.instanceId !== 'string'
      || !Number.isFinite(record.acquiredAt)
    ) return undefined;
    return record as SlackConsumerLockRecord;
  } catch {
    return undefined;
  }
}

export function acquireSlackConsumerLock(
  invokerHome: string,
  instanceId: string,
  pid = process.pid,
): SlackConsumerLock {
  const locksDir = join(invokerHome, 'locks');
  const lockPath = join(locksDir, 'slack-socket-consumer.lock');
  const record: SlackConsumerLockRecord = { pid, instanceId, acquiredAt: Date.now() };
  mkdirSync(locksDir, { recursive: true });

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, JSON.stringify(record));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        path: lockPath,
        record,
        release(): void {
          if (released) return;
          released = true;
          const current = existsSync(lockPath) ? readRecord(lockPath) : undefined;
          if (current?.pid === record.pid && current.acquiredAt === record.acquiredAt) {
            unlinkSync(lockPath);
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readRecord(lockPath);
      if (holder && isProcessAlive(holder.pid)) throw new SlackConsumerLockHeldError(holder, lockPath);
      try {
        unlinkSync(lockPath);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
      }
    }
  }
  throw new Error(`Could not acquire Slack Socket Mode lock: ${lockPath}`);
}
