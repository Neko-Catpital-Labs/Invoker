import {
  applyDelta,
  exportDelta,
  getSyncCursor,
  setSyncCursor,
  type DeltaBatch,
} from '@invoker/data-store';
import { buildSshConnectionArgs, type SshTargetConnection } from './ssh-transport-options.js';
import {
  execRemoteCapture,
  type SshExecOpts,
} from './ssh-git-exec.js';
import {
  REMOTE_SYNC_PUSH_ACK_PREFIX,
  buildReadRemoteProgressJournalScript,
  buildWriteRemoteSyncSpoolScript,
  parseRemoteProgressJournalLines,
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
  db: SshSyncStore;
  peerId?: string;
  remoteInvokerHome?: string;
  intervalMs?: number;
  pullLimit?: number;
  execRemoteCapture?: (opts: SshExecOpts) => Promise<string>;
}

export interface SshSyncPullResult {
  batch: DeltaBatch;
  appliedEntries: number;
  skippedEntries: number;
  lastReceivedSeq: number;
}

export interface SshSyncPushResult {
  batch: DeltaBatch;
  lastSentSeq: number;
}

const DEFAULT_SYNC_INTERVAL_MS = 5_000;
const DEFAULT_PULL_LIMIT = 1_000;

function nowIso(): string {
  return new Date().toISOString();
}

function defaultPeerId(config: SshTargetConnection): string {
  return `${config.user}@${config.host}:${config.port ?? 22}`;
}

function parsePushAck(stdout: string, expectedHighWaterSeq: number): void {
  const ackLine = stdout.split(/\r?\n/).find((line) => line.startsWith(REMOTE_SYNC_PUSH_ACK_PREFIX));
  const ack = ackLine ? Number(ackLine.slice(REMOTE_SYNC_PUSH_ACK_PREFIX.length).trim()) : NaN;
  if (!Number.isInteger(ack) || ack !== expectedHighWaterSeq) {
    throw new Error(
      `SSH sync push missing ack for highWaterSeq=${expectedHighWaterSeq}; stdout=${stdout.slice(0, 500)}`,
    );
  }
}

/**
 * Dropbox-cursor style sync over the existing SSH command transport.
 *
 * Home remains authoritative. Pull consumes the remote progress journal and
 * applies it to the home store through Step 2's idempotent delta merge. Push
 * writes home-origin graph metadata and tombstones into a remote spool that the
 * SSH payload wrapper observes while it is running.
 */
export class SshSyncChannel {
  private readonly db: SshSyncStore;
  private readonly peerId: string;
  private readonly remoteInvokerHome: string;
  private readonly intervalMs: number;
  private readonly pullLimit: number;
  private readonly sshArgs: string[];
  private readonly remoteExec: (opts: SshExecOpts) => Promise<string>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(config: SshSyncChannelConfig) {
    this.db = config.db;
    this.peerId = config.peerId ?? defaultPeerId(config);
    this.remoteInvokerHome = config.remoteInvokerHome ?? '~/.invoker';
    this.intervalMs = config.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.pullLimit = config.pullLimit ?? DEFAULT_PULL_LIMIT;
    this.sshArgs = buildSshConnectionArgs(config, { batchMode: true });
    this.remoteExec = config.execRemoteCapture ?? execRemoteCapture;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.syncOnce();
    this.timer = setInterval(() => {
      void this.syncOnce();
    }, this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async syncOnce(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      await this.pullOnce();
      await this.pushOnce();
    })();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  async pullOnce(): Promise<SshSyncPullResult> {
    const cursor = getSyncCursor(this.db, this.peerId);
    const sinceSeq = cursor?.lastReceivedSeq ?? 0;
    const stdout = await this.remoteExec({
      sshArgs: this.sshArgs,
      phase: 'ssh_sync_pull',
      script: buildReadRemoteProgressJournalScript({
        invokerHome: this.remoteInvokerHome,
        sinceSeq,
        limit: this.pullLimit,
      }),
    });
    const entries = parseRemoteProgressJournalLines(stdout);
    const batch = remoteProgressEntriesToDeltaBatch(entries, sinceSeq);
    const result = applyDelta(this.db, batch, this.peerId);
    return {
      batch,
      appliedEntries: result.appliedEntries,
      skippedEntries: result.skippedEntries,
      lastReceivedSeq: result.lastReceivedSeq,
    };
  }

  async pushOnce(): Promise<SshSyncPushResult> {
    const cursor = getSyncCursor(this.db, this.peerId);
    const lastSentSeq = cursor?.lastSentSeq ?? 0;
    const batch = exportDelta(this.db, lastSentSeq);
    if (batch.highWaterSeq === lastSentSeq) {
      return { batch, lastSentSeq };
    }

    const stdout = await this.remoteExec({
      sshArgs: this.sshArgs,
      phase: 'ssh_sync_push',
      script: buildWriteRemoteSyncSpoolScript({
        invokerHome: this.remoteInvokerHome,
        peerId: this.peerId,
        batch,
      }),
    });
    parsePushAck(stdout, batch.highWaterSeq);

    const latestCursor = getSyncCursor(this.db, this.peerId);
    const saved = setSyncCursor(this.db, {
      peerId: this.peerId,
      lastSentSeq: batch.highWaterSeq,
      lastReceivedSeq: latestCursor?.lastReceivedSeq ?? cursor?.lastReceivedSeq ?? 0,
      updatedAt: nowIso(),
    });
    return { batch, lastSentSeq: saved.lastSentSeq };
  }
}
