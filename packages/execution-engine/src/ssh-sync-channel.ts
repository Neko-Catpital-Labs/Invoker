import {
  applyDelta as applyDataStoreDelta,
  exportDelta as exportDataStoreDelta,
  getSyncCursor,
  setSyncCursor,
  type DeltaBatch,
} from '@invoker/data-store';
import { buildSshConnectionArgs, type SshTargetConnection } from './ssh-transport-options.js';
import { execRemoteCapture, type SshExecOpts } from './ssh-git-exec.js';
import {
  buildAppendRemoteSyncSpoolScript,
  buildReadRemoteProgressJournalScript,
  parseRemoteProgressPullOutput,
  parseRemoteSyncSpoolAck,
  remoteProgressEntriesToDeltaBatch,
} from './remote-progress-journal.js';

type SqliteExecutorLike = Parameters<typeof exportDataStoreDelta>[0];
type ApplyDeltaResult = ReturnType<typeof applyDataStoreDelta>;

export interface SshSyncChannelConfig extends SshTargetConnection {
  db: SqliteExecutorLike;
  /** Remote invoker home directory. Default: ~/.invoker */
  remoteInvokerHome?: string;
  /** Stable peer id for persisted sync cursors. Default: ssh:user@host:port. */
  peerId?: string;
  /** Pull/push cadence when start() is used. Default: 5000ms. */
  intervalMs?: number;
  /** Maximum remote journal entries to pull in one exchange. Default: 500. */
  batchLimit?: number;
  /** Test seam matching ssh-git-exec's one-shot SSH command primitive. */
  execRemoteCapture?: (opts: SshExecOpts) => Promise<string>;
}

export interface SshSyncExchangeResult {
  pulled: ApplyDeltaResult;
  pushed: {
    entries: number;
    highWaterSeq: number;
    lastSentSeq: number;
  };
}

const DEFAULT_SYNC_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_LIMIT = 500;

function defaultPeerId(config: SshTargetConnection): string {
  return `ssh:${config.user}@${config.host}:${config.port ?? 22}`;
}

function positiveInteger(name: string, value: number, fallback: number): number {
  const out = Math.trunc(value);
  if (!Number.isInteger(out) || out <= 0) return fallback;
  if (name === 'intervalMs') return Math.max(10, out);
  return out;
}

function graphMetadataDelta(batch: DeltaBatch): DeltaBatch {
  return {
    ...batch,
    entries: batch.entries.filter((entry) =>
      entry.entityType === 'workflow'
      || entry.entityType === 'task',
    ),
  };
}

export class SshSyncChannel {
  private readonly db: SqliteExecutorLike;
  private readonly target: SshTargetConnection;
  private readonly remoteInvokerHome: string;
  private readonly peerIdValue: string;
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly runRemote: (opts: SshExecOpts) => Promise<string>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<SshSyncExchangeResult> | undefined;

  constructor(config: SshSyncChannelConfig) {
    this.db = config.db;
    this.target = {
      host: config.host,
      user: config.user,
      sshKeyPath: config.sshKeyPath,
      port: config.port,
    };
    this.remoteInvokerHome = config.remoteInvokerHome ?? '~/.invoker';
    this.peerIdValue = config.peerId ?? defaultPeerId(config);
    this.intervalMs = positiveInteger('intervalMs', config.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS, DEFAULT_SYNC_INTERVAL_MS);
    this.batchLimit = positiveInteger('batchLimit', config.batchLimit ?? DEFAULT_BATCH_LIMIT, DEFAULT_BATCH_LIMIT);
    this.runRemote = config.execRemoteCapture ?? execRemoteCapture;
  }

  get peerId(): string {
    return this.peerIdValue;
  }

  private sshArgs(): string[] {
    return buildSshConnectionArgs(this.target, { batchMode: true });
  }

  start(): void {
    if (this.timer) return;
    void this.syncOnce().catch((err) => {
      console.warn(`[ssh-sync] initial exchange failed peer=${this.peerIdValue}: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.timer = setInterval(() => {
      void this.syncOnce().catch((err) => {
        console.warn(`[ssh-sync] periodic exchange failed peer=${this.peerIdValue}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  disconnect(): void {
    this.stop();
  }

  reconnect(): void {
    this.start();
  }

  async syncOnce(): Promise<SshSyncExchangeResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.exchange();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  async pullOnce(): Promise<ApplyDeltaResult> {
    const cursor = getSyncCursor(this.db, this.peerIdValue);
    const sinceSeq = cursor?.lastReceivedSeq ?? 0;
    const script = buildReadRemoteProgressJournalScript({
      remoteInvokerHome: this.remoteInvokerHome,
      sinceSeq,
      limit: this.batchLimit,
    });
    const stdout = await this.runRemote({
      sshArgs: this.sshArgs(),
      script,
      phase: 'ssh_sync_pull',
    });
    const pulled = parseRemoteProgressPullOutput(stdout, sinceSeq);
    const batch = remoteProgressEntriesToDeltaBatch({
      entries: pulled.entries,
      sinceSeq,
      highWaterSeq: pulled.highWaterSeq,
    });
    return applyDataStoreDelta(this.db, batch, this.peerIdValue);
  }

  async pushOnce(): Promise<SshSyncExchangeResult['pushed']> {
    const cursor = getSyncCursor(this.db, this.peerIdValue);
    const lastSentSeq = cursor?.lastSentSeq ?? 0;
    const exported = exportDataStoreDelta(this.db, lastSentSeq);
    const batch = graphMetadataDelta(exported);
    if (batch.highWaterSeq <= lastSentSeq) {
      return {
        entries: 0,
        highWaterSeq: batch.highWaterSeq,
        lastSentSeq,
      };
    }

    const script = buildAppendRemoteSyncSpoolScript({
      remoteInvokerHome: this.remoteInvokerHome,
      batch,
    });
    const stdout = await this.runRemote({
      sshArgs: this.sshArgs(),
      script,
      phase: 'ssh_sync_push',
    });
    const ack = parseRemoteSyncSpoolAck(stdout);
    if (ack !== batch.highWaterSeq) {
      throw new Error(
        `SSH sync push did not acknowledge highWaterSeq ${batch.highWaterSeq}` +
          (ack === undefined ? '' : ` (ack=${ack})`),
      );
    }

    const latest = getSyncCursor(this.db, this.peerIdValue);
    const saved = setSyncCursor(this.db, {
      peerId: this.peerIdValue,
      lastSentSeq: batch.highWaterSeq,
      lastReceivedSeq: latest?.lastReceivedSeq ?? 0,
      updatedAt: new Date().toISOString(),
    });

    return {
      entries: batch.entries.length,
      highWaterSeq: batch.highWaterSeq,
      lastSentSeq: saved.lastSentSeq,
    };
  }

  private async exchange(): Promise<SshSyncExchangeResult> {
    const pulled = await this.pullOnce();
    const pushed = await this.pushOnce();
    return { pulled, pushed };
  }
}
