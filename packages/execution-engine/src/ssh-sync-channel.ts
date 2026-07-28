import type { DeltaBatch } from '@invoker/data-store';
import { applyDelta, exportDelta, getSyncCursor, setSyncCursor } from '@invoker/data-store';
import { buildSshConnectionArgs, type SshTargetConnection } from './ssh-transport-options.js';
import { execRemoteCapture, type SshExecOpts } from './ssh-git-exec.js';
import {
  buildReadRemoteProgressJournalScript,
  buildWriteRemoteDeltaSpoolScript,
  parseRemoteDeltaSpoolAck,
  parseRemoteProgressJournalOutput,
} from './remote-progress-journal.js';

export interface SshSyncChannelExchangeResult {
  pull: {
    appliedEntries: number;
    skippedEntries: number;
    lastReceivedSeq: number;
    highWaterSeq: number;
  };
  push: {
    entries: number;
    lastSentSeq: number;
    highWaterSeq: number;
    skipped: boolean;
  };
}

export interface SshSyncHomeStore {
  queryOne(sql: string, params?: unknown[]): Record<string, unknown> | undefined;
  queryAll(sql: string, params?: unknown[]): Record<string, unknown>[];
  execRun(sql: string, params?: unknown[]): void;
  runTransaction<T>(work: () => T): T;
  run(sql: string, params?: unknown[]): void;
  getRowsModified(): number;
  readonly readOnly: boolean;
  markDirty(): void;
}

export interface SshSyncChannelConfig {
  target: SshTargetConnection;
  homeDb: SshSyncHomeStore;
  remoteInvokerHome?: string;
  peerId?: string;
  intervalMs?: number;
  batchLimit?: number;
  execRemoteCapture?: (opts: SshExecOpts) => Promise<string>;
  onError?: (error: unknown) => void;
}

const DEFAULT_SYNC_INTERVAL_MS = 5000;
const DEFAULT_BATCH_LIMIT = 1000;

function defaultPeerId(target: SshTargetConnection): string {
  return `ssh:${target.user}@${target.host}:${target.port ?? 22}`;
}

function assertAck(expected: number, actual: number): void {
  if (actual !== expected) {
    throw new Error(`Remote delta spool acknowledged seq ${actual}, expected ${expected}`);
  }
}

export class SshSyncChannel {
  private readonly target: SshTargetConnection;
  private readonly homeDb: SshSyncHomeStore;
  private readonly remoteInvokerHome: string | undefined;
  private readonly peerId: string;
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly execRemote: (opts: SshExecOpts) => Promise<string>;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private exchangeInFlight: Promise<SshSyncChannelExchangeResult> | undefined;

  constructor(config: SshSyncChannelConfig) {
    this.target = config.target;
    this.homeDb = config.homeDb;
    this.remoteInvokerHome = config.remoteInvokerHome;
    this.peerId = config.peerId ?? defaultPeerId(config.target);
    this.intervalMs = Number.isFinite(config.intervalMs) && (config.intervalMs ?? 0) > 0
      ? Math.trunc(config.intervalMs!)
      : DEFAULT_SYNC_INTERVAL_MS;
    this.batchLimit = Number.isFinite(config.batchLimit) && (config.batchLimit ?? 0) > 0
      ? Math.trunc(config.batchLimit!)
      : DEFAULT_BATCH_LIMIT;
    this.execRemote = config.execRemoteCapture ?? execRemoteCapture;
    this.onError = config.onError;
  }

  get id(): string {
    return this.peerId;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.exchangeOnce().catch((error) => {
        this.onError?.(error);
      });
    }, this.intervalMs);
    void this.exchangeOnce().catch((error) => {
      this.onError?.(error);
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async exchangeOnce(): Promise<SshSyncChannelExchangeResult> {
    if (this.exchangeInFlight) return this.exchangeInFlight;
    this.exchangeInFlight = this.runExchangeOnce();
    try {
      return await this.exchangeInFlight;
    } finally {
      this.exchangeInFlight = undefined;
    }
  }

  async pullOnce(): Promise<SshSyncChannelExchangeResult['pull']> {
    const cursor = getSyncCursor(this.homeDb, this.peerId);
    const sinceSeq = cursor?.lastReceivedSeq ?? 0;
    const stdout = await this.execRemote({
      sshArgs: this.buildSshArgs(),
      phase: 'ssh_sync_pull_progress',
      script: buildReadRemoteProgressJournalScript({
        remoteInvokerHome: this.remoteInvokerHome,
        sinceSeq,
        limit: this.batchLimit,
      }),
    });
    const batch = parseRemoteProgressJournalOutput(stdout, sinceSeq);
    const result = applyDelta(this.homeDb, batch, this.peerId);
    return {
      appliedEntries: result.appliedEntries,
      skippedEntries: result.skippedEntries,
      lastReceivedSeq: result.lastReceivedSeq,
      highWaterSeq: batch.highWaterSeq,
    };
  }

  async pushOnce(): Promise<SshSyncChannelExchangeResult['push']> {
    const cursor = getSyncCursor(this.homeDb, this.peerId);
    const lastSentSeq = cursor?.lastSentSeq ?? 0;
    const batch = exportDelta(this.homeDb, lastSentSeq);

    if (batch.entries.length === 0) {
      return {
        entries: 0,
        lastSentSeq,
        highWaterSeq: batch.highWaterSeq,
        skipped: true,
      };
    }

    const stdout = await this.execRemote({
      sshArgs: this.buildSshArgs(),
      phase: 'ssh_sync_push_delta',
      script: buildWriteRemoteDeltaSpoolScript({
        remoteInvokerHome: this.remoteInvokerHome,
        batch,
      }),
    });
    assertAck(batch.highWaterSeq, parseRemoteDeltaSpoolAck(stdout));
    const latest = getSyncCursor(this.homeDb, this.peerId);
    const saved = setSyncCursor(this.homeDb, {
      peerId: this.peerId,
      lastSentSeq: batch.highWaterSeq,
      lastReceivedSeq: latest?.lastReceivedSeq ?? cursor?.lastReceivedSeq ?? 0,
    });

    return {
      entries: batch.entries.length,
      lastSentSeq: saved.lastSentSeq,
      highWaterSeq: batch.highWaterSeq,
      skipped: false,
    };
  }

  exportPushBatch(): DeltaBatch {
    const cursor = getSyncCursor(this.homeDb, this.peerId);
    return exportDelta(this.homeDb, cursor?.lastSentSeq ?? 0);
  }

  private async runExchangeOnce(): Promise<SshSyncChannelExchangeResult> {
    const pull = await this.pullOnce();
    const push = await this.pushOnce();
    return { pull, push };
  }

  private buildSshArgs(): string[] {
    return buildSshConnectionArgs(this.target, { batchMode: true });
  }
}
