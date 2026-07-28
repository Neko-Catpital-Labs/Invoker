import {
  applyDelta,
  exportDelta,
  getSyncCursor,
  setSyncCursor,
  type ApplyDeltaResult,
  type DeltaBatch,
  type SyncCursor,
} from '@invoker/data-store';
import { buildSshConnectionArgs, type SshTargetConnection } from './ssh-transport-options.js';
import { execRemoteCapture } from './ssh-git-exec.js';
import {
  REMOTE_SYNC_PUSH_ACK,
  buildAppendRemoteSyncSpoolScript,
  buildReadRemoteProgressJournalScript,
  parseRemoteProgressDelta,
} from './remote-progress-journal.js';

export interface SshSyncCommand {
  script: string;
  phase: 'ssh_sync_pull' | 'ssh_sync_push';
}

export type SshSyncCommandRunner = (command: SshSyncCommand) => Promise<string>;
type SyncDb = Parameters<typeof applyDelta>[0];

export interface SshSyncChannelConfig {
  db: SyncDb;
  peerId: string;
  remoteInvokerHome?: string;
  intervalMs?: number;
  batchLimit?: number;
  target?: SshTargetConnection;
  commandRunner?: SshSyncCommandRunner;
}

export interface SshSyncPullResult extends ApplyDeltaResult {
  batch: DeltaBatch;
}

export interface SshSyncPushResult {
  batch: DeltaBatch;
  cursor: SyncCursor;
  pushedEntries: number;
}

export interface SshSyncTickResult {
  pull: SshSyncPullResult;
  push: SshSyncPushResult;
}

const DEFAULT_SYNC_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_LIMIT = 1000;

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

export class SshSyncChannel {
  private readonly db: SyncDb;
  private readonly peerId: string;
  private readonly remoteInvokerHome: string | undefined;
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly commandRunner: SshSyncCommandRunner;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<SshSyncTickResult> | undefined;

  constructor(config: SshSyncChannelConfig) {
    if (!config.peerId) throw new Error('SshSyncChannel requires peerId');
    this.db = config.db;
    this.peerId = config.peerId;
    this.remoteInvokerHome = config.remoteInvokerHome;
    this.intervalMs = positiveInteger(config.intervalMs, DEFAULT_SYNC_INTERVAL_MS);
    this.batchLimit = positiveInteger(config.batchLimit, DEFAULT_BATCH_LIMIT);
    this.commandRunner = config.commandRunner ?? this.buildDefaultCommandRunner(config.target);
  }

  private buildDefaultCommandRunner(target: SshTargetConnection | undefined): SshSyncCommandRunner {
    if (!target) {
      throw new Error('SshSyncChannel requires either target or commandRunner');
    }
    const sshArgs = buildSshConnectionArgs(target, { batchMode: true });
    return (command) => execRemoteCapture({
      sshArgs,
      script: command.script,
      phase: command.phase,
    });
  }

  getCursor(): SyncCursor | undefined {
    return getSyncCursor(this.db, this.peerId);
  }

  start(options: { immediate?: boolean } = {}): void {
    if (this.timer) return;
    if (options.immediate ?? true) {
      void this.syncOnce().catch((err) => {
        console.warn(
          `[ssh-sync] initial sync failed peer=${this.peerId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    this.timer = setInterval(() => {
      void this.syncOnce().catch((err) => {
        console.warn(
          `[ssh-sync] periodic sync failed peer=${this.peerId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async syncOnce(): Promise<SshSyncTickResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const pull = await this.pullOnce();
      const push = await this.pushOnce();
      return { pull, push };
    })();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  async pullOnce(): Promise<SshSyncPullResult> {
    const cursor = getSyncCursor(this.db, this.peerId);
    const sinceSeq = cursor?.lastReceivedSeq ?? 0;
    const script = buildReadRemoteProgressJournalScript({
      remoteInvokerHome: this.remoteInvokerHome,
      sinceSeq,
      limit: this.batchLimit,
    });
    const stdout = await this.commandRunner({ script, phase: 'ssh_sync_pull' });
    const batch = parseRemoteProgressDelta(stdout, sinceSeq);
    const result = applyDelta(this.db, batch, this.peerId);
    return { ...result, batch };
  }

  async pushOnce(): Promise<SshSyncPushResult> {
    const cursor = getSyncCursor(this.db, this.peerId);
    const sinceSeq = cursor?.lastSentSeq ?? 0;
    const batch = exportDelta(this.db, sinceSeq);
    if (batch.highWaterSeq <= sinceSeq && batch.entries.length === 0) {
      return {
        batch,
        cursor: cursor ?? setSyncCursor(this.db, {
          peerId: this.peerId,
          lastSentSeq: sinceSeq,
          lastReceivedSeq: cursor?.lastReceivedSeq ?? 0,
        }),
        pushedEntries: 0,
      };
    }

    const script = buildAppendRemoteSyncSpoolScript({
      remoteInvokerHome: this.remoteInvokerHome,
      batch,
    });
    const stdout = await this.commandRunner({ script, phase: 'ssh_sync_push' });
    const ackMatch = stdout.match(new RegExp(`${REMOTE_SYNC_PUSH_ACK}=(\\d+)`));
    const ackSeq = ackMatch ? Number(ackMatch[1]) : NaN;
    if (ackSeq !== batch.highWaterSeq) {
      throw new Error(
        `SSH sync push missing ack for seq ${batch.highWaterSeq}: ${stdout.trim().slice(0, 200)}`,
      );
    }

    const saved = setSyncCursor(this.db, {
      peerId: this.peerId,
      lastSentSeq: batch.highWaterSeq,
      lastReceivedSeq: cursor?.lastReceivedSeq ?? 0,
    });
    return {
      batch,
      cursor: saved,
      pushedEntries: batch.entries.length,
    };
  }
}
