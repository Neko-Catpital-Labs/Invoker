import {
  applyDelta,
  exportDelta,
  getSyncCursor,
  setSyncCursor,
  type DeltaBatch,
  type SyncJournalEntry,
} from '@invoker/data-store';
import { buildSshConnectionArgs, type SshTargetConnection } from './ssh-transport-options.js';
import { execRemoteCapture, type SshExecOpts } from './ssh-git-exec.js';
import {
  buildAppendRemoteSpoolScript,
  buildReadRemoteProgressJournalScript,
  parseRemoteProgressJournal,
  remoteProgressEntriesToDeltaBatch,
} from './remote-progress-journal.js';

type SyncDb = Parameters<typeof getSyncCursor>[0];

export interface SshSyncChannelConfig extends SshTargetConnection {
  db: SyncDb;
  /** Stable remote peer key used for Step 2 sync cursors. */
  peerId?: string;
  remoteInvokerHome?: string;
  intervalMs?: number;
  batchLimit?: number;
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
  shippedEntries: number;
  lastSentSeq: number;
}

export interface SshSyncOnceResult {
  pull: SshSyncPullResult;
  push: SshSyncPushResult;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_LIMIT = 500;

function defaultPeerId(config: SshTargetConnection): string {
  return `ssh:${config.user}@${config.host}:${config.port ?? 22}`;
}

function remoteNeedsEntry(entry: SyncJournalEntry): boolean {
  return entry.entityType === 'workflow'
    || entry.entityType === 'task'
    || entry.entityType === 'attempt';
}

export class SshSyncChannel {
  readonly peerId: string;
  private readonly db: SyncDb;
  private readonly remoteInvokerHome: string | undefined;
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly sshArgs: string[];
  private readonly execRemote: (opts: SshExecOpts) => Promise<string>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncing = false;
  private stopped = true;
  private lastErrorValue: unknown;

  constructor(config: SshSyncChannelConfig) {
    this.db = config.db;
    this.peerId = config.peerId ?? defaultPeerId(config);
    this.remoteInvokerHome = config.remoteInvokerHome;
    this.intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.batchLimit = config.batchLimit ?? DEFAULT_BATCH_LIMIT;
    this.sshArgs = buildSshConnectionArgs(config, { batchMode: true });
    this.execRemote = config.execRemoteCapture ?? execRemoteCapture;
  }

  get lastError(): unknown {
    return this.lastErrorValue;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.syncOnce().catch((err) => {
        this.lastErrorValue = err;
      });
    }, this.intervalMs);
    this.timer.unref?.();
    void this.syncOnce().catch((err) => {
      this.lastErrorValue = err;
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async syncOnce(): Promise<SshSyncOnceResult> {
    if (this.syncing) {
      throw new Error(`SSH sync already in progress for peer ${this.peerId}`);
    }
    if (this.stopped && this.timer) {
      throw new Error(`SSH sync channel ${this.peerId} is stopped`);
    }
    this.syncing = true;
    try {
      const pull = await this.pullOnce();
      const push = await this.pushOnce();
      this.lastErrorValue = undefined;
      return { pull, push };
    } finally {
      this.syncing = false;
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
    const stdout = await this.execRemote({
      sshArgs: this.sshArgs,
      script,
      phase: 'ssh_sync_pull',
    });
    const entries = parseRemoteProgressJournal(stdout);
    const batch = remoteProgressEntriesToDeltaBatch(entries, sinceSeq);
    const applied = applyDelta(this.db, batch, this.peerId);
    return {
      batch,
      appliedEntries: applied.appliedEntries,
      skippedEntries: applied.skippedEntries,
      lastReceivedSeq: applied.lastReceivedSeq,
    };
  }

  async pushOnce(): Promise<SshSyncPushResult> {
    const cursor = getSyncCursor(this.db, this.peerId);
    const sinceSeq = cursor?.lastSentSeq ?? 0;
    const exported = exportDelta(this.db, sinceSeq);
    const batch: DeltaBatch = {
      ...exported,
      entries: exported.entries.filter(remoteNeedsEntry),
    };

    if (batch.highWaterSeq === sinceSeq) {
      return {
        batch,
        shippedEntries: 0,
        lastSentSeq: sinceSeq,
      };
    }

    if (batch.entries.length > 0) {
      const script = buildAppendRemoteSpoolScript({
        remoteInvokerHome: this.remoteInvokerHome,
        batch,
      });
      await this.execRemote({
        sshArgs: this.sshArgs,
        script,
        phase: 'ssh_sync_push',
      });
    }

    const latestCursor = getSyncCursor(this.db, this.peerId);
    const saved = setSyncCursor(this.db, {
      peerId: this.peerId,
      lastSentSeq: batch.highWaterSeq,
      lastReceivedSeq: latestCursor?.lastReceivedSeq ?? 0,
    });
    return {
      batch,
      shippedEntries: batch.entries.length,
      lastSentSeq: saved.lastSentSeq,
    };
  }
}
