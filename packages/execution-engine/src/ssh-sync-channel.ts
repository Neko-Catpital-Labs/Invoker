import {
  applyDelta as applyDataStoreDelta,
  exportDelta as exportDataStoreDelta,
  getSyncCursor,
  setSyncCursor,
  type ApplyDeltaResult,
  type DeltaBatch,
  type SyncCursor,
} from '@invoker/data-store';
import { buildSourceInvokerEnvScript, buildPortableBase64DecodeFunction } from './remote-shell-fragments.js';
import { buildSshConnectionArgs, type SshTargetConnection } from './ssh-transport-options.js';
import {
  execRemoteCapture as defaultExecRemoteCapture,
  shellPosixSingleQuote,
  type SshExecOpts,
} from './ssh-git-exec.js';
import {
  REMOTE_PROGRESS_JOURNAL_DIRNAME,
  REMOTE_PROGRESS_SPOOL_DIRNAME,
  parseRemoteProgressJournalLines,
  remoteProgressEntriesToDeltaBatch,
} from './remote-progress-journal.js';

type SqliteLikeExecutor = Parameters<typeof applyDataStoreDelta>[0];

export interface SshSyncChannelConfig extends SshTargetConnection {
  db: SqliteLikeExecutor;
  remoteInvokerHome?: string;
  peerId?: string;
  intervalMs?: number;
  execRemoteCapture?: (opts: SshExecOpts) => Promise<string>;
  applyDelta?: typeof applyDataStoreDelta;
  exportDelta?: typeof exportDataStoreDelta;
}

export interface SshSyncPullResult {
  batch: DeltaBatch;
  applyResult: ApplyDeltaResult;
  cursor: SyncCursor;
}

export interface SshSyncPushResult {
  batch: DeltaBatch;
  cursor: SyncCursor;
  wrote: boolean;
}

export interface SshSyncTickResult {
  pull: SshSyncPullResult;
  push: SshSyncPushResult;
}

function defaultPeerId(config: SshTargetConnection): string {
  return `ssh:${config.user}@${config.host}:${config.port ?? 22}`;
}

function batchToBase64(batch: DeltaBatch): string {
  return Buffer.from(JSON.stringify(batch), 'utf8').toString('base64');
}

function buildPullRemoteJournalScript(remoteInvokerHome: string): string {
  return `set -euo pipefail
${buildSourceInvokerEnvScript(remoteInvokerHome, 'INVOKER_RUNTIME_HOME')}
JOURNAL_DIR="$INVOKER_RUNTIME_HOME/runtime/ssh-executor/${REMOTE_PROGRESS_JOURNAL_DIRNAME}"
if [ -d "$JOURNAL_DIR" ]; then
  find "$JOURNAL_DIR" -type f -name '*.ndjson' -print0 2>/dev/null | while IFS= read -r -d '' file; do
    cat "$file"
  done
fi
`;
}

function buildPushDeltaSpoolScript(remoteInvokerHome: string, batch: DeltaBatch): string {
  const encoded = batchToBase64(batch);
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
${buildSourceInvokerEnvScript(remoteInvokerHome, 'INVOKER_RUNTIME_HOME')}
SPOOL_DIR="$INVOKER_RUNTIME_HOME/runtime/ssh-executor/${REMOTE_PROGRESS_SPOOL_DIRNAME}"
mkdir -p "$SPOOL_DIR"
chmod 700 "$SPOOL_DIR"
TMP="$SPOOL_DIR/home.delta.json.$$"
printf '%s' ${shellPosixSingleQuote(encoded)} | invoker_base64_decode > "$TMP"
mv "$TMP" "$SPOOL_DIR/home.delta.json"
sync -f "$SPOOL_DIR/home.delta.json" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
`;
}

export class SshSyncChannel {
  private readonly target: SshTargetConnection;
  private readonly db: SqliteLikeExecutor;
  private readonly remoteInvokerHome: string;
  private readonly peerId: string;
  private readonly intervalMs: number;
  private readonly execRemoteCapture: (opts: SshExecOpts) => Promise<string>;
  private readonly applyDelta: typeof applyDataStoreDelta;
  private readonly exportDelta: typeof exportDataStoreDelta;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<SshSyncTickResult> | undefined;

  constructor(config: SshSyncChannelConfig) {
    this.target = {
      sshKeyPath: config.sshKeyPath,
      port: config.port,
      user: config.user,
      host: config.host,
    };
    this.db = config.db;
    this.remoteInvokerHome = config.remoteInvokerHome ?? '~/.invoker';
    this.peerId = config.peerId ?? defaultPeerId(config);
    this.intervalMs =
      typeof config.intervalMs === 'number'
      && Number.isFinite(config.intervalMs)
      && config.intervalMs > 0
        ? Math.trunc(config.intervalMs)
        : 5000;
    this.execRemoteCapture = config.execRemoteCapture ?? defaultExecRemoteCapture;
    this.applyDelta = config.applyDelta ?? applyDataStoreDelta;
    this.exportDelta = config.exportDelta ?? exportDataStoreDelta;
  }

  getPeerId(): string {
    return this.peerId;
  }

  start(): void {
    if (this.timer) return;
    void this.syncOnce().catch(() => {});
    this.timer = setInterval(() => {
      void this.syncOnce().catch(() => {});
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async syncOnce(): Promise<SshSyncTickResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const pull = await this.pull();
        const push = await this.push();
        return { pull, push };
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }

  async pull(): Promise<SshSyncPullResult> {
    const cursor = this.cursor();
    const stdout = await this.execRemoteCapture({
      sshArgs: this.sshArgs(),
      script: buildPullRemoteJournalScript(this.remoteInvokerHome),
      phase: 'ssh_sync_pull',
    });
    const remoteEntries = parseRemoteProgressJournalLines(stdout)
      .filter((entry) => entry.seq > cursor.lastReceivedSeq);
    const batch = remoteProgressEntriesToDeltaBatch(remoteEntries, {
      sinceSeq: cursor.lastReceivedSeq,
      taskPayloadFor: (taskId) => this.db.queryOne('SELECT * FROM tasks WHERE id = ?', [taskId]),
    });
    const applyResult = this.applyDelta(this.db, batch, this.peerId);
    const saved = getSyncCursor(this.db, this.peerId);
    if (!saved) {
      throw new Error(`SSH sync pull did not persist cursor for ${this.peerId}`);
    }
    return { batch, applyResult, cursor: saved };
  }

  async push(): Promise<SshSyncPushResult> {
    const cursor = this.cursor();
    const batch = this.exportDelta(this.db, cursor.lastSentSeq);
    const wrote = batch.highWaterSeq > cursor.lastSentSeq || batch.entries.length > 0;
    if (wrote) {
      await this.execRemoteCapture({
        sshArgs: this.sshArgs(),
        script: buildPushDeltaSpoolScript(this.remoteInvokerHome, batch),
        phase: 'ssh_sync_push',
      });
    }
    const saved = setSyncCursor(this.db, {
      peerId: this.peerId,
      lastReceivedSeq: cursor.lastReceivedSeq,
      lastSentSeq: Math.max(cursor.lastSentSeq, batch.highWaterSeq),
    });
    return { batch, cursor: saved, wrote };
  }

  private sshArgs(): string[] {
    return buildSshConnectionArgs(this.target, { batchMode: true });
  }

  private cursor(): SyncCursor {
    return getSyncCursor(this.db, this.peerId) ?? setSyncCursor(this.db, {
      peerId: this.peerId,
      lastReceivedSeq: 0,
      lastSentSeq: 0,
    });
  }
}
