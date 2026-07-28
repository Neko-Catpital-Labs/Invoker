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
  buildAppendHomeDeltaSpoolScript,
  buildReadRemoteProgressJournalScript,
  parseRemoteProgressJournalLines,
  remoteProgressEntriesToDeltaBatch,
} from './remote-progress-journal.js';

type SyncStore = Parameters<typeof exportDelta>[0];

export interface SshSyncChannelConfig extends SshTargetConnection {
  store: SyncStore;
  remoteInvokerHome?: string;
  peerId?: string;
  intervalMs?: number;
  execRemoteCapture?: (opts: SshExecOpts) => Promise<string>;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface SshSyncPullResult {
  batch: DeltaBatch;
  applyResult: ApplyDeltaResult;
}

export interface SshSyncPushResult {
  batch: DeltaBatch;
  cursor: SyncCursor;
  wroteRemoteSpool: boolean;
}

export interface SshSyncOnceResult {
  pull: SshSyncPullResult;
  push: SshSyncPushResult;
}

const DEFAULT_SYNC_INTERVAL_MS = 5_000;

function buildDefaultPeerId(config: SshTargetConnection & { remoteInvokerHome?: string }): string {
  return [
    'ssh',
    config.user,
    config.host,
    String(config.port ?? 22),
    config.remoteInvokerHome ?? '~/.invoker',
  ].join(':');
}

function asPositiveInterval(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SYNC_INTERVAL_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('SshSyncChannel intervalMs must be a positive number');
  }
  return Math.trunc(value);
}

export class SshSyncChannel {
  private readonly store: SyncStore;
  private readonly remoteInvokerHome?: string;
  private readonly peerId: string;
  private readonly intervalMs: number;
  private readonly sshArgs: string[];
  private readonly runRemote: (opts: SshExecOpts) => Promise<string>;
  private readonly logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = true;

  constructor(config: SshSyncChannelConfig) {
    this.store = config.store;
    this.remoteInvokerHome = config.remoteInvokerHome;
    this.peerId = config.peerId ?? buildDefaultPeerId(config);
    this.intervalMs = asPositiveInterval(config.intervalMs);
    this.sshArgs = buildSshConnectionArgs(config, { batchMode: true });
    this.runRemote = config.execRemoteCapture ?? execRemoteCapture;
    this.logger = config.logger;
  }

  getPeerId(): string {
    return this.peerId;
  }

  getCursor(): SyncCursor | undefined {
    return getSyncCursor(this.store, this.peerId);
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.syncOnce()
        .then(() => undefined)
        .catch((err) => {
          this.logger?.warn?.(
            `[SshSyncChannel] sync failed peer=${this.peerId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  async syncOnce(): Promise<SshSyncOnceResult> {
    if (this.stopped && this.timer) {
      throw new Error('SshSyncChannel is stopped');
    }
    const pull = await this.pull();
    const push = await this.push();
    return { pull, push };
  }

  async pull(): Promise<SshSyncPullResult> {
    const cursor = getSyncCursor(this.store, this.peerId);
    const sinceSeq = cursor?.lastReceivedSeq ?? 0;
    const stdout = await this.runRemote({
      sshArgs: this.sshArgs,
      script: buildReadRemoteProgressJournalScript({
        remoteInvokerHome: this.remoteInvokerHome,
        sinceSeq,
      }),
      phase: 'ssh_sync_pull',
    });
    const remoteEntries = parseRemoteProgressJournalLines(stdout);
    const batch = remoteProgressEntriesToDeltaBatch({
      sinceSeq,
      entries: remoteEntries,
    });
    const applyResult = applyDelta(this.store, batch, this.peerId);
    return { batch, applyResult };
  }

  async push(): Promise<SshSyncPushResult> {
    const cursor = getSyncCursor(this.store, this.peerId);
    const lastSentSeq = cursor?.lastSentSeq ?? 0;
    const lastReceivedSeq = cursor?.lastReceivedSeq ?? 0;
    const batch = exportDelta(this.store, lastSentSeq);

    let wroteRemoteSpool = false;
    if (batch.entries.length > 0) {
      const ack = await this.runRemote({
        sshArgs: this.sshArgs,
        script: buildAppendHomeDeltaSpoolScript({
          remoteInvokerHome: this.remoteInvokerHome,
          batch,
        }),
        phase: 'ssh_sync_push',
      });
      if (!ack.includes(`ACK ${batch.highWaterSeq}`)) {
        throw new Error(`SSH sync push missing ACK for highWaterSeq ${batch.highWaterSeq}`);
      }
      wroteRemoteSpool = true;
    }

    const saved = setSyncCursor(this.store, {
      peerId: this.peerId,
      lastSentSeq: batch.highWaterSeq,
      lastReceivedSeq,
    });
    return { batch, cursor: saved, wroteRemoteSpool };
  }
}
