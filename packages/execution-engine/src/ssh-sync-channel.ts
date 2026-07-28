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
import {
  execRemoteCapture,
  type SshExecOpts,
} from './ssh-git-exec.js';
import {
  buildReadRemoteProgressJournalScript,
  buildWriteRemoteSyncSpoolScript,
  parseRemoteProgressJournal,
  remoteProgressEntriesToDeltaBatch,
} from './remote-progress-journal.js';

export interface SshSyncStore {
  queryOne(sql: string, params?: unknown[]): Record<string, unknown> | undefined;
  queryAll(sql: string, params?: unknown[]): Record<string, unknown>[];
  execRun(sql: string, params?: unknown[]): void;
  runTransaction<T>(work: () => T): T;
  run(sql: string, params?: unknown[]): void;
  getRowsModified(): number;
  readonly readOnly: boolean;
  markDirty(): void;
}

export interface SshSyncChannelConfig extends SshTargetConnection {
  store: SshSyncStore;
  executionId: string;
  actionId: string;
  remoteInvokerHome?: string;
  peerId?: string;
  intervalMs?: number;
  pullLimit?: number;
  execRemoteCapture?: (opts: SshExecOpts) => Promise<string>;
  onError?: (error: Error, phase: 'pull' | 'push' | 'sync') => void;
}

export interface SshSyncPullResult {
  batch: DeltaBatch;
  applyResult: ApplyDeltaResult;
}

export interface SshSyncPushResult {
  batch: DeltaBatch;
  cursor: SyncCursor;
  pushed: boolean;
}

const DEFAULT_SYNC_INTERVAL_MS = 5_000;
const DEFAULT_PULL_LIMIT = 1_000;

function normalizeIntervalMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SYNC_INTERVAL_MS;
  }
  return Math.trunc(value);
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_PULL_LIMIT;
  }
  return Math.trunc(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class SshSyncChannel {
  readonly peerId: string;
  private readonly store: SshSyncStore;
  private readonly target: SshTargetConnection;
  private readonly executionId: string;
  private readonly actionId: string;
  private readonly remoteInvokerHome: string | undefined;
  private readonly intervalMs: number;
  private readonly pullLimit: number;
  private readonly capture: (opts: SshExecOpts) => Promise<string>;
  private readonly onError?: (error: Error, phase: 'pull' | 'push' | 'sync') => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncing: Promise<void> | undefined;

  constructor(config: SshSyncChannelConfig) {
    this.store = config.store;
    this.target = {
      sshKeyPath: config.sshKeyPath,
      port: config.port,
      user: config.user,
      host: config.host,
    };
    this.executionId = config.executionId;
    this.actionId = config.actionId;
    this.remoteInvokerHome = config.remoteInvokerHome;
    this.intervalMs = normalizeIntervalMs(config.intervalMs);
    this.pullLimit = normalizeLimit(config.pullLimit);
    this.capture = config.execRemoteCapture ?? execRemoteCapture;
    this.peerId = config.peerId ?? `ssh:${config.user}@${config.host}:${config.port ?? 22}:${config.executionId}:${config.actionId}`;
    this.onError = config.onError;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.syncOnce().catch((error) => {
        this.onError?.(asError(error), 'sync');
      });
    }, this.intervalMs);
    void this.syncOnce().catch((error) => {
      this.onError?.(asError(error), 'sync');
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getCursor(): SyncCursor | undefined {
    return getSyncCursor(this.store, this.peerId);
  }

  async syncOnce(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      await this.pullOnce();
      await this.pushOnce();
    })();
    try {
      await this.syncing;
    } finally {
      this.syncing = undefined;
    }
  }

  async pullOnce(): Promise<SshSyncPullResult> {
    const cursor = getSyncCursor(this.store, this.peerId);
    const sinceSeq = cursor?.lastReceivedSeq ?? 0;
    const script = buildReadRemoteProgressJournalScript({
      invokerHome: this.remoteInvokerHome,
      executionId: this.executionId,
      actionId: this.actionId,
      sinceSeq,
      limit: this.pullLimit,
    });

    try {
      const stdout = await this.capture({
        sshArgs: buildSshConnectionArgs(this.target, { batchMode: true }),
        script,
        phase: 'ssh_sync_pull',
      });
      const remoteEntries = parseRemoteProgressJournal(stdout);
      const batch = remoteProgressEntriesToDeltaBatch(remoteEntries, sinceSeq);
      const applyResult = applyDelta(this.store, batch, this.peerId);
      return { batch, applyResult };
    } catch (error) {
      this.onError?.(asError(error), 'pull');
      throw error;
    }
  }

  async pushOnce(): Promise<SshSyncPushResult> {
    const cursor = getSyncCursor(this.store, this.peerId);
    const sinceSeq = cursor?.lastSentSeq ?? 0;
    const batch = exportDelta(this.store, sinceSeq);
    if (batch.entries.length === 0) {
      const saved = setSyncCursor(this.store, {
        peerId: this.peerId,
        lastSentSeq: batch.highWaterSeq,
        lastReceivedSeq: cursor?.lastReceivedSeq ?? 0,
      });
      return { batch, cursor: saved, pushed: false };
    }

    const script = buildWriteRemoteSyncSpoolScript({
      invokerHome: this.remoteInvokerHome,
      executionId: this.executionId,
      actionId: this.actionId,
      batch,
    });

    try {
      await this.capture({
        sshArgs: buildSshConnectionArgs(this.target, { batchMode: true }),
        script,
        phase: 'ssh_sync_push',
      });
      const latestCursor = getSyncCursor(this.store, this.peerId);
      const saved = setSyncCursor(this.store, {
        peerId: this.peerId,
        lastSentSeq: batch.highWaterSeq,
        lastReceivedSeq: latestCursor?.lastReceivedSeq ?? cursor?.lastReceivedSeq ?? 0,
      });
      return { batch, cursor: saved, pushed: true };
    } catch (error) {
      this.onError?.(asError(error), 'push');
      throw error;
    }
  }
}
