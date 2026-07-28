import {
  applyDelta,
  exportDelta,
  getSyncCursor,
  setSyncCursor,
  type ApplyDeltaResult,
  type DeltaBatch,
  type SqliteExecutor,
  type SyncCursor,
} from '@invoker/data-store';
import { buildSshConnectionArgs, type SshTargetConnection } from './ssh-transport-options.js';
import {
  execRemoteCapture as defaultExecRemoteCapture,
  type SshExecOpts,
} from './ssh-git-exec.js';
import {
  buildReadRemoteProgressJournalScript,
  buildWriteRemoteDeltaSpoolScript,
  parseRemoteDeltaSpoolAck,
  parseRemoteProgressJournalLines,
  remoteProgressEntriesToDeltaBatch,
} from './remote-progress-journal.js';

export interface SshSyncLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface SshSyncChannelConfig extends SshTargetConnection {
  db: SqliteExecutor;
  remoteInvokerHome?: string;
  peerId?: string;
  intervalMs?: number;
  pullLimit?: number;
  logger?: SshSyncLogger;
  execRemoteCapture?: (opts: SshExecOpts) => Promise<string>;
}

export interface SshSyncPullResult {
  batch: DeltaBatch;
  applyResult: ApplyDeltaResult;
}

export interface SshSyncPushResult {
  batch: DeltaBatch;
  ackSeq: number;
  cursor: SyncCursor;
}

export interface SshSyncCycleResult {
  pull: SshSyncPullResult;
  push: SshSyncPushResult;
}

const DEFAULT_SYNC_INTERVAL_MS = 10_000;
const DEFAULT_PULL_LIMIT = 1000;

export class SshSyncChannel {
  private readonly db: SqliteExecutor;
  private readonly target: SshTargetConnection;
  private readonly remoteInvokerHome: string;
  private readonly peerIdValue: string;
  private readonly intervalMs: number;
  private readonly pullLimit: number;
  private readonly logger?: SshSyncLogger;
  private readonly execRemoteCaptureImpl: (opts: SshExecOpts) => Promise<string>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<SshSyncCycleResult | undefined> | undefined;

  constructor(config: SshSyncChannelConfig) {
    this.db = config.db;
    this.target = {
      host: config.host,
      user: config.user,
      sshKeyPath: config.sshKeyPath,
      port: config.port,
    };
    this.remoteInvokerHome = config.remoteInvokerHome ?? '~/.invoker';
    this.peerIdValue = config.peerId ?? `ssh:${config.user}@${config.host}:${config.port ?? 22}`;
    this.intervalMs = Number.isFinite(config.intervalMs) && (config.intervalMs ?? 0) > 0
      ? Math.trunc(config.intervalMs!)
      : DEFAULT_SYNC_INTERVAL_MS;
    this.pullLimit = Number.isFinite(config.pullLimit) && (config.pullLimit ?? 0) >= 0
      ? Math.trunc(config.pullLimit!)
      : DEFAULT_PULL_LIMIT;
    this.logger = config.logger;
    this.execRemoteCaptureImpl = config.execRemoteCapture ?? defaultExecRemoteCapture;
  }

  get peerId(): string {
    return this.peerIdValue;
  }

  get cursor(): SyncCursor | undefined {
    return getSyncCursor(this.db, this.peerIdValue);
  }

  start(): void {
    if (this.timer) return;
    void this.syncOnce().catch((err) => {
      this.logger?.warn?.('[ssh-sync] initial sync failed', { error: this.formatError(err) });
    });
    this.timer = setInterval(() => {
      void this.syncOnce().catch((err) => {
        this.logger?.warn?.('[ssh-sync] periodic sync failed', { error: this.formatError(err) });
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async syncOnce(): Promise<SshSyncCycleResult> {
    if (this.inFlight) {
      const current = await this.inFlight;
      if (current) return current;
    }
    const run = (async () => {
      const pull = await this.pull();
      const push = await this.push();
      return { pull, push };
    })();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  async pull(): Promise<SshSyncPullResult> {
    const cursor = getSyncCursor(this.db, this.peerIdValue);
    const sinceSeq = cursor?.lastReceivedSeq ?? 0;
    const stdout = await this.execRemoteCaptureImpl({
      sshArgs: this.buildSshArgs(),
      script: buildReadRemoteProgressJournalScript({
        remoteInvokerHome: this.remoteInvokerHome,
        sinceSeq,
        limit: this.pullLimit,
      }),
      phase: 'ssh_sync_pull',
    });
    const remoteEntries = parseRemoteProgressJournalLines(stdout);
    const batch = remoteProgressEntriesToDeltaBatch(remoteEntries, sinceSeq, {
      peerId: this.peerIdValue,
      loadTaskPayload: (taskId) => this.db.queryOne('SELECT * FROM tasks WHERE id = ?', [taskId]),
      loadAttemptPayload: (attemptId) => this.db.queryOne('SELECT * FROM attempts WHERE id = ?', [attemptId]),
    });
    const applyResult = applyDelta(this.db, batch, this.peerIdValue);
    this.logger?.debug?.('[ssh-sync] pulled remote progress', {
      peerId: this.peerIdValue,
      entries: batch.entries.length,
      highWaterSeq: batch.highWaterSeq,
      appliedEntries: applyResult.appliedEntries,
    });
    return { batch, applyResult };
  }

  async push(): Promise<SshSyncPushResult> {
    const cursor = getSyncCursor(this.db, this.peerIdValue);
    const lastSentSeq = cursor?.lastSentSeq ?? 0;
    const batch = exportDelta(this.db, lastSentSeq);
    const stdout = await this.execRemoteCaptureImpl({
      sshArgs: this.buildSshArgs(),
      script: buildWriteRemoteDeltaSpoolScript({
        remoteInvokerHome: this.remoteInvokerHome,
        batch,
      }),
      phase: 'ssh_sync_push',
    });
    const ack = parseRemoteDeltaSpoolAck(stdout);
    if (ack.ackSeq < batch.highWaterSeq) {
      throw new Error(`SSH sync push acknowledged ${ack.ackSeq}, expected at least ${batch.highWaterSeq}`);
    }
    const saved = setSyncCursor(this.db, {
      peerId: this.peerIdValue,
      lastSentSeq: batch.highWaterSeq,
      lastReceivedSeq: cursor?.lastReceivedSeq ?? 0,
    });
    this.logger?.debug?.('[ssh-sync] pushed home graph delta', {
      peerId: this.peerIdValue,
      entries: batch.entries.length,
      highWaterSeq: batch.highWaterSeq,
    });
    return { batch, ackSeq: ack.ackSeq, cursor: saved };
  }

  private buildSshArgs(): string[] {
    return buildSshConnectionArgs(this.target, { batchMode: true });
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
