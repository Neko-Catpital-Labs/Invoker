import {
  applyDelta as applyDataStoreDelta,
  exportDelta as exportDataStoreDelta,
  getSyncCursor,
  setSyncCursor,
  type ApplyDeltaResult,
  type DeltaBatch,
  type SyncJournalEntry,
} from '@invoker/data-store';
import { buildSshConnectionArgs, type SshTargetConnection } from './ssh-transport-options.js';
import { execRemoteCapture, type SshExecOpts } from './ssh-git-exec.js';
import {
  buildAppendRemoteSyncSpoolScript,
  buildReadRemoteProgressJournalScript,
  remoteProgressJournalToDeltaBatch,
} from './remote-progress-journal.js';

type SyncDb = Parameters<typeof getSyncCursor>[0];

export interface SshSyncChannelConfig extends SshTargetConnection {
  db: SyncDb;
  /** Stable peer key used for sync_cursors and imported journal origin. */
  peerId?: string;
  /** Remote invoker home directory. Defaults to ~/.invoker. */
  remoteInvokerHome?: string;
  /** Periodic sync interval. Defaults to 5000ms. */
  intervalMs?: number;
  /** Test seam for the one-shot SSH command layer. */
  execRemote?: (opts: SshExecOpts) => Promise<string>;
  /** Test seam for applying pulled deltas. */
  applyDelta?: typeof applyDataStoreDelta;
  /** Test seam for exporting local deltas. */
  exportDelta?: typeof exportDataStoreDelta;
}

export interface SshSyncPullResult {
  batch: DeltaBatch;
  applyResult: ApplyDeltaResult;
}

export interface SshSyncPushResult {
  exportedHighWaterSeq: number;
  sentEntries: number;
  skippedEntries: number;
}

export interface SshSyncOnceResult {
  pull: SshSyncPullResult;
  push: SshSyncPushResult;
}

const DEFAULT_SYNC_INTERVAL_MS = 5_000;
const ACK_PREFIX = '__INVOKER_SSH_SYNC_ACK__=';
const REMOTE_PUSH_ENTITY_TYPES = new Set<SyncJournalEntry['entityType']>([
  'workflow',
  'task',
  'attempt',
]);

function peerIdForTarget(target: SshTargetConnection): string {
  return `ssh:${target.user}@${target.host}:${target.port ?? 22}`;
}

function filterRemotePushEntries(entries: SyncJournalEntry[]): SyncJournalEntry[] {
  return entries.filter((entry) => REMOTE_PUSH_ENTITY_TYPES.has(entry.entityType));
}

function parseAck(stdout: string): number | undefined {
  const line = stdout.split('\n').reverse().find((candidate) => candidate.startsWith(ACK_PREFIX));
  if (!line) return undefined;
  const raw = line.slice(ACK_PREFIX.length).trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export class SshSyncChannel {
  private readonly db: SyncDb;
  private readonly target: SshTargetConnection;
  private readonly peerId: string;
  private readonly remoteInvokerHome: string;
  private readonly intervalMs: number;
  private readonly execRemote: (opts: SshExecOpts) => Promise<string>;
  private readonly applyDeltaFn: typeof applyDataStoreDelta;
  private readonly exportDeltaFn: typeof exportDataStoreDelta;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<SshSyncOnceResult> | undefined;

  constructor(config: SshSyncChannelConfig) {
    this.db = config.db;
    this.target = {
      sshKeyPath: config.sshKeyPath,
      port: config.port,
      user: config.user,
      host: config.host,
    };
    this.peerId = config.peerId ?? peerIdForTarget(this.target);
    this.remoteInvokerHome = config.remoteInvokerHome ?? '~/.invoker';
    this.intervalMs =
      typeof config.intervalMs === 'number'
      && Number.isFinite(config.intervalMs)
      && config.intervalMs > 0
        ? Math.trunc(config.intervalMs)
        : DEFAULT_SYNC_INTERVAL_MS;
    this.execRemote = config.execRemote ?? execRemoteCapture;
    this.applyDeltaFn = config.applyDelta ?? applyDataStoreDelta;
    this.exportDeltaFn = config.exportDelta ?? exportDataStoreDelta;
  }

  getPeerId(): string {
    return this.peerId;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.syncOnce().catch((error) => {
        console.warn(
          `[ssh-sync] sync failed peer=${this.peerId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, this.intervalMs);
    void this.syncOnce().catch((error) => {
      console.warn(
        `[ssh-sync] initial sync failed peer=${this.peerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async syncOnce(): Promise<SshSyncOnceResult> {
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
    const stdout = await this.execRemote({
      sshArgs: buildSshConnectionArgs(this.target, { batchMode: true }),
      phase: 'ssh_sync_pull',
      script: buildReadRemoteProgressJournalScript({
        remoteInvokerHome: this.remoteInvokerHome,
        sinceSeq,
      }),
    });
    const batch = remoteProgressJournalToDeltaBatch(stdout, sinceSeq);
    const applyResult = this.applyDeltaFn(this.db, batch, this.peerId);
    return { batch, applyResult };
  }

  async pushOnce(): Promise<SshSyncPushResult> {
    const cursor = getSyncCursor(this.db, this.peerId);
    const lastSentSeq = cursor?.lastSentSeq ?? 0;
    const exported = this.exportDeltaFn(this.db, lastSentSeq);
    const entries = filterRemotePushEntries(exported.entries);

    if (exported.highWaterSeq <= lastSentSeq) {
      return {
        exportedHighWaterSeq: exported.highWaterSeq,
        sentEntries: 0,
        skippedEntries: exported.entries.length,
      };
    }

    if (entries.length === 0) {
      setSyncCursor(this.db, {
        peerId: this.peerId,
        lastSentSeq: exported.highWaterSeq,
        lastReceivedSeq: cursor?.lastReceivedSeq ?? 0,
      });
      return {
        exportedHighWaterSeq: exported.highWaterSeq,
        sentEntries: 0,
        skippedEntries: exported.entries.length,
      };
    }

    const entriesJsonLines = entries.map((entry) => JSON.stringify(entry)).join('\n');
    const stdout = await this.execRemote({
      sshArgs: buildSshConnectionArgs(this.target, { batchMode: true }),
      phase: 'ssh_sync_push',
      script: buildAppendRemoteSyncSpoolScript({
        remoteInvokerHome: this.remoteInvokerHome,
        entriesJsonLines,
        highWaterSeq: exported.highWaterSeq,
      }),
    });
    const ack = parseAck(stdout);
    if (ack === undefined || ack < exported.highWaterSeq) {
      throw new Error(
        `Remote sync spool write was not acknowledged at seq ${exported.highWaterSeq}`,
      );
    }

    const latestCursor = getSyncCursor(this.db, this.peerId);
    setSyncCursor(this.db, {
      peerId: this.peerId,
      lastSentSeq: exported.highWaterSeq,
      lastReceivedSeq: latestCursor?.lastReceivedSeq ?? cursor?.lastReceivedSeq ?? 0,
    });

    return {
      exportedHighWaterSeq: exported.highWaterSeq,
      sentEntries: entries.length,
      skippedEntries: exported.entries.length - entries.length,
    };
  }
}

export { filterRemotePushEntries };
