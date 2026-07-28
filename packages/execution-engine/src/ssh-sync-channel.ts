import {
  applyDelta as defaultApplyDelta,
  exportDelta as defaultExportDelta,
  getSyncCursor,
  setSyncCursor,
  type ApplyDeltaResult,
  type DeltaBatch,
  type SyncCursor,
} from '@invoker/data-store';
import { buildSshConnectionArgs, type SshTargetConnection } from './ssh-transport-options.js';
import {
  createSshRemoteScriptError,
  execRemoteCapture as defaultExecRemoteCapture,
  type SshExecOpts,
} from './ssh-git-exec.js';
import {
  buildAppendRemoteSpoolScript,
  buildReadRemoteJournalScript,
  parseRemoteProgressJournal,
  remoteProgressEntriesToDeltaBatch,
  SSH_SYNC_PUSH_ACK_PREFIX,
} from './remote-progress-journal.js';

type SyncStore = Parameters<typeof defaultExportDelta>[0];
type ExportDelta = (db: SyncStore, sinceSeq: number) => DeltaBatch;
type ApplyDelta = (db: SyncStore, batch: DeltaBatch, peerId: string) => ApplyDeltaResult;
type RemoteExec = (opts: SshExecOpts) => Promise<string>;

export interface SshSyncChannelConfig extends SshTargetConnection {
  /**
   * Stable id for this remote peer. Cursor rows are keyed by it, so reconnects
   * must reuse the same value for gap-free resume.
   */
  peerId: string;
  store: SyncStore;
  remoteInvokerHome?: string;
  intervalMs?: number;
  pullLimit?: number;
  remoteExec?: RemoteExec;
  exportDelta?: ExportDelta;
  applyDelta?: ApplyDelta;
  onError?: (error: unknown) => void;
}

export interface SshSyncPullResult {
  sinceSeq: number;
  highWaterSeq: number;
  receivedEntries: number;
  appliedEntries: number;
  skippedEntries: number;
  lastReceivedSeq: number;
}

export interface SshSyncPushResult {
  sinceSeq: number;
  highWaterSeq: number;
  sentEntries: number;
  lastSentSeq: number;
}

export interface SshSyncResult {
  pull: SshSyncPullResult;
  push: SshSyncPushResult;
}

const DEFAULT_SYNC_INTERVAL_MS = 5_000;
const DEFAULT_PULL_LIMIT = 500;

function emptyCursor(peerId: string): SyncCursor {
  return {
    peerId,
    lastSentSeq: 0,
    lastReceivedSeq: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

function cursorFor(db: SyncStore, peerId: string): SyncCursor {
  return getSyncCursor(db, peerId) ?? emptyCursor(peerId);
}

function parsePushAck(stdout: string, expectedHighWaterSeq: number): void {
  const ack = stdout
    .split('\n')
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith(SSH_SYNC_PUSH_ACK_PREFIX));
  const raw = ack?.slice(SSH_SYNC_PUSH_ACK_PREFIX.length);
  const actual = raw === undefined ? undefined : Number(raw);
  if (actual !== expectedHighWaterSeq) {
    throw createSshRemoteScriptError(
      0,
      stdout,
      `SSH sync push ack missing or mismatched: expected ${expectedHighWaterSeq}, got ${raw ?? 'none'}`,
      'ssh_sync_push_ack',
    );
  }
}

export class SshSyncChannel {
  private readonly peerId: string;
  private readonly store: SyncStore;
  private readonly remoteInvokerHome: string;
  private readonly intervalMs: number;
  private readonly pullLimit: number;
  private readonly remoteExec: RemoteExec;
  private readonly exportDelta: ExportDelta;
  private readonly applyDelta: ApplyDelta;
  private readonly onError?: (error: unknown) => void;
  private readonly sshArgs: string[];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<SshSyncResult> | undefined;

  constructor(config: SshSyncChannelConfig) {
    if (!config.peerId) throw new Error('SshSyncChannel requires peerId');
    this.peerId = config.peerId;
    this.store = config.store;
    this.remoteInvokerHome = config.remoteInvokerHome ?? '~/.invoker';
    this.intervalMs =
      typeof config.intervalMs === 'number' && Number.isFinite(config.intervalMs) && config.intervalMs > 0
        ? config.intervalMs
        : DEFAULT_SYNC_INTERVAL_MS;
    this.pullLimit =
      typeof config.pullLimit === 'number' && Number.isFinite(config.pullLimit) && config.pullLimit > 0
        ? Math.trunc(config.pullLimit)
        : DEFAULT_PULL_LIMIT;
    this.remoteExec = config.remoteExec ?? defaultExecRemoteCapture;
    this.exportDelta = config.exportDelta ?? defaultExportDelta;
    this.applyDelta = config.applyDelta ?? defaultApplyDelta;
    this.onError = config.onError;
    this.sshArgs = buildSshConnectionArgs(config, { batchMode: true });
  }

  start(): void {
    if (this.timer) return;
    void this.runSyncLoop();
    this.timer = setInterval(() => {
      void this.runSyncLoop();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async close(): Promise<void> {
    this.stop();
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // The caller only needs the channel stopped; individual sync errors are
        // surfaced through syncOnce()/onError.
      }
    }
  }

  async syncOnce(): Promise<SshSyncResult> {
    const pull = await this.pull();
    const push = await this.push();
    return { pull, push };
  }

  async pull(): Promise<SshSyncPullResult> {
    const cursor = cursorFor(this.store, this.peerId);
    const stdout = await this.remoteExec({
      sshArgs: this.sshArgs,
      script: buildReadRemoteJournalScript({
        invokerHome: this.remoteInvokerHome,
        sinceSeq: cursor.lastReceivedSeq,
        limit: this.pullLimit,
      }),
      phase: 'ssh_sync_pull',
    });
    const remoteEntries = parseRemoteProgressJournal(stdout);
    const batch = remoteProgressEntriesToDeltaBatch(remoteEntries, cursor.lastReceivedSeq);
    const applied = this.applyDelta(this.store, batch, this.peerId);
    return {
      sinceSeq: batch.sinceSeq,
      highWaterSeq: batch.highWaterSeq,
      receivedEntries: batch.entries.length,
      appliedEntries: applied.appliedEntries,
      skippedEntries: applied.skippedEntries,
      lastReceivedSeq: applied.lastReceivedSeq,
    };
  }

  async push(): Promise<SshSyncPushResult> {
    const cursor = cursorFor(this.store, this.peerId);
    const batch = this.exportDelta(this.store, cursor.lastSentSeq);
    if (batch.highWaterSeq <= cursor.lastSentSeq) {
      return {
        sinceSeq: cursor.lastSentSeq,
        highWaterSeq: cursor.lastSentSeq,
        sentEntries: 0,
        lastSentSeq: cursor.lastSentSeq,
      };
    }

    if (batch.entries.length > 0) {
      const stdout = await this.remoteExec({
        sshArgs: this.sshArgs,
        script: buildAppendRemoteSpoolScript({
          invokerHome: this.remoteInvokerHome,
          batch,
        }),
        phase: 'ssh_sync_push',
      });
      parsePushAck(stdout, batch.highWaterSeq);
    }

    const latest = cursorFor(this.store, this.peerId);
    const saved = setSyncCursor(this.store, {
      peerId: this.peerId,
      lastSentSeq: batch.highWaterSeq,
      lastReceivedSeq: latest.lastReceivedSeq,
      updatedAt: new Date().toISOString(),
    });

    return {
      sinceSeq: batch.sinceSeq,
      highWaterSeq: batch.highWaterSeq,
      sentEntries: batch.entries.length,
      lastSentSeq: saved.lastSentSeq,
    };
  }

  private async runSyncLoop(): Promise<SshSyncResult | undefined> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.syncOnce();
    try {
      return await this.inFlight;
    } catch (err) {
      this.onError?.(err);
      return undefined;
    } finally {
      this.inFlight = undefined;
    }
  }
}
