import { DISPATCH_LEASE_MS } from '@invoker/contracts';
import {
  DELTA_BATCH_SCHEMA_VERSION,
  type DeltaBatch,
  type SyncJournalEntry,
} from '@invoker/data-store';
import { base64Encode, shellPosixSingleQuote } from './ssh-git-exec.js';
import { buildPortableBase64DecodeFunction } from './remote-shell-fragments.js';

export const REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION = 1;
export const REMOTE_PROGRESS_JOURNAL_ORIGIN = 'ssh-remote';
export const REMOTE_PROGRESS_JOURNAL_FILE = 'progress-journal.ndjson';
export const REMOTE_PROGRESS_JOURNAL_SEQ_FILE = 'progress-journal.seq';
export const REMOTE_DELTA_SPOOL_FILE = 'home-delta-spool.ndjson';
export const REMOTE_PROGRESS_RUNTIME_DIR = 'runtime/ssh-executor';

export type RemoteProgressJournalKind =
  | 'attempt_started'
  | 'heartbeat'
  | 'output_chunk'
  | 'attempt_finished';

export interface RemoteProgressJournalEntry {
  schemaVersion: typeof REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION;
  seq: number;
  kind: RemoteProgressJournalKind;
  requestId: string;
  taskId: string;
  attemptId: string;
  workflowId?: string;
  executionGeneration?: number;
  requestCreatedAt?: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

export interface RemoteProgressJournalRuntimeMetadata {
  requestId: string;
  taskId: string;
  attemptId?: string;
  workflowId?: string;
  executionGeneration?: number;
  requestCreatedAt?: string;
  workspacePath?: string;
  branch?: string;
  agentSessionId?: string;
  agentName?: string;
  heartbeatMarker: string;
  tombstonePollSeconds?: number;
}

export interface RemoteProgressTranslateOptions {
  sinceSeq: number;
  highWaterSeq?: number;
  leaseMs?: number;
  origin?: string;
}

function jsonLiteral(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function jsonShellLiteral(value: unknown): string {
  return shellPosixSingleQuote(jsonLiteral(value));
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : String(value);
}

function integer(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const out = Number(value);
  return Number.isInteger(out) ? out : undefined;
}

function decodeBase64Text(value: unknown): string | undefined {
  const raw = optionalText(value);
  if (!raw) return undefined;
  return Buffer.from(raw, 'base64').toString('utf8');
}

function isoWithLease(createdAt: string, leaseMs: number): string {
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) return new Date(Date.now() + leaseMs).toISOString();
  return new Date(parsed + leaseMs).toISOString();
}

function nonNegativeInteger(name: string, value: number): number {
  const out = Math.trunc(value);
  if (!Number.isInteger(out) || out < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return out;
}

function requiredSeq(entry: RemoteProgressJournalEntry): number {
  const seq = Number(entry.seq);
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new Error(`Remote progress journal entry has invalid seq: ${String(entry.seq)}`);
  }
  return seq;
}

function validateEntry(entry: RemoteProgressJournalEntry): void {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Remote progress journal entry must be an object');
  }
  if (entry.schemaVersion !== REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION) {
    throw new Error(`Unsupported remote progress journal schema version ${String(entry.schemaVersion)}`);
  }
  requiredSeq(entry);
  if (!entry.kind) throw new Error(`Remote progress journal entry ${entry.seq} is missing kind`);
  if (!entry.requestId) throw new Error(`Remote progress journal entry ${entry.seq} is missing requestId`);
  if (!entry.taskId) throw new Error(`Remote progress journal entry ${entry.seq} is missing taskId`);
  if (!entry.attemptId) throw new Error(`Remote progress journal entry ${entry.seq} is missing attemptId`);
  if (!entry.createdAt) throw new Error(`Remote progress journal entry ${entry.seq} is missing createdAt`);
}

export function remoteProgressRuntimeDirExpression(invokerHomeExpression = '$INVOKER_HOME'): string {
  return `${invokerHomeExpression}/${REMOTE_PROGRESS_RUNTIME_DIR}`;
}

export function remoteProgressJournalPathExpression(invokerHomeExpression = '$INVOKER_HOME'): string {
  return `${remoteProgressRuntimeDirExpression(invokerHomeExpression)}/${REMOTE_PROGRESS_JOURNAL_FILE}`;
}

export function remoteDeltaSpoolPathExpression(invokerHomeExpression = '$INVOKER_HOME'): string {
  return `${remoteProgressRuntimeDirExpression(invokerHomeExpression)}/${REMOTE_DELTA_SPOOL_FILE}`;
}

export function parseRemoteProgressJournalLines(text: string): RemoteProgressJournalEntry[] {
  const entries: RemoteProgressJournalEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `Failed to parse remote progress journal line ${index + 1}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const entry = parsed as RemoteProgressJournalEntry;
    validateEntry(entry);
    entries.push(entry);
  }
  return entries;
}

function attemptPayload(
  entry: RemoteProgressJournalEntry,
  status: 'running' | 'completed' | 'failed',
  options: { leaseMs: number },
): Record<string, unknown> {
  const payload = entry.payload ?? {};
  const createdAt = entry.requestCreatedAt ?? entry.createdAt;
  const out: Record<string, unknown> = {
    id: entry.attemptId,
    node_id: entry.taskId,
    attempt_number: integer(payload.attemptNumber) ?? 0,
    queue_priority: integer(payload.queuePriority) ?? 0,
    status,
    upstream_attempt_ids: '[]',
    created_at: createdAt,
    started_at: optionalText(payload.startedAt) ?? (status === 'running' ? entry.createdAt : createdAt),
    last_heartbeat_at: entry.createdAt,
    lease_expires_at: isoWithLease(entry.createdAt, options.leaseMs),
  };

  const workspacePath = optionalText(payload.workspacePath);
  const branch = optionalText(payload.branch);
  const agentSessionId = optionalText(payload.agentSessionId);
  const containerId = optionalText(payload.containerId);
  if (workspacePath) out.workspace_path = workspacePath;
  if (branch) out.branch = branch;
  if (agentSessionId) out.agent_session_id = agentSessionId;
  if (containerId) out.container_id = containerId;

  if (status !== 'running') {
    out.completed_at = entry.createdAt;
    const exitCode = integer(payload.exitCode);
    if (exitCode !== undefined) out.exit_code = exitCode;
    const error = optionalText(payload.error) ?? decodeBase64Text(payload.errorBase64);
    if (error) out.error = error;
    const commitHash = optionalText(payload.commitHash);
    const summary = optionalText(payload.summary);
    if (commitHash) out.commit_hash = commitHash;
    if (summary) out.summary = summary;
  }

  return out;
}

function remoteEntryToSyncEntries(
  entry: RemoteProgressJournalEntry,
  options: Required<Pick<RemoteProgressTranslateOptions, 'leaseMs' | 'origin'>>,
): SyncJournalEntry[] {
  const seq = requiredSeq(entry);
  const createdAt = entry.createdAt;
  switch (entry.kind) {
    case 'attempt_started':
      return [{
        seq,
        entityType: 'attempt',
        entityId: entry.attemptId,
        op: 'upsert',
        payload: attemptPayload(entry, 'running', options),
        origin: options.origin,
        createdAt,
      }];
    case 'heartbeat':
      return [{
        seq,
        entityType: 'attempt',
        entityId: entry.attemptId,
        op: 'upsert',
        payload: attemptPayload(entry, 'running', options),
        origin: options.origin,
        createdAt,
      }];
    case 'output_chunk': {
      const payload = entry.payload ?? {};
      const data = optionalText(payload.data) ?? decodeBase64Text(payload.dataBase64) ?? '';
      return [{
        seq,
        entityType: 'output',
        entityId: `${entry.taskId}:remote:${seq}`,
        op: 'upsert',
        payload: {
          task_id: entry.taskId,
          offset: integer(payload.offset) ?? seq,
          data,
          created_at: createdAt,
          stream: optionalText(payload.stream) ?? undefined,
        },
        origin: options.origin,
        createdAt,
      }];
    }
    case 'attempt_finished': {
      const rawStatus = optionalText(entry.payload?.status);
      const status = rawStatus === 'completed' ? 'completed' : 'failed';
      return [{
        seq,
        entityType: 'attempt',
        entityId: entry.attemptId,
        op: 'upsert',
        payload: attemptPayload(entry, status, options),
        origin: options.origin,
        createdAt,
      }];
    }
    default:
      throw new Error(`Unsupported remote progress journal kind ${(entry as { kind?: unknown }).kind}`);
  }
}

export function translateRemoteProgressEntriesToDelta(
  entries: RemoteProgressJournalEntry[],
  options: RemoteProgressTranslateOptions,
): DeltaBatch {
  const sinceSeq = nonNegativeInteger('sinceSeq', options.sinceSeq);
  const filtered = entries
    .filter((entry) => requiredSeq(entry) > sinceSeq)
    .sort((a, b) => a.seq - b.seq);
  const highWaterSeq = nonNegativeInteger(
    'highWaterSeq',
    Math.max(
      sinceSeq,
      options.highWaterSeq ?? sinceSeq,
      ...filtered.map((entry) => requiredSeq(entry)),
    ),
  );
  const translateOptions = {
    leaseMs: options.leaseMs ?? DISPATCH_LEASE_MS,
    origin: options.origin ?? REMOTE_PROGRESS_JOURNAL_ORIGIN,
  };

  return {
    schemaVersion: DELTA_BATCH_SCHEMA_VERSION,
    sinceSeq,
    highWaterSeq,
    entries: filtered.flatMap((entry) => remoteEntryToSyncEntries(entry, translateOptions)),
  };
}

export function buildReadRemoteProgressJournalScript(opts: {
  invokerHome?: string;
  sinceSeq: number;
  limit?: number;
}): string {
  const invokerHome = opts.invokerHome ?? '~/.invoker';
  const sinceSeq = nonNegativeInteger('sinceSeq', opts.sinceSeq);
  const limit = opts.limit === undefined ? 1000 : nonNegativeInteger('limit', opts.limit);
  const homeB64 = base64Encode(invokerHome);
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(homeB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
JOURNAL_FILE="$INVOKER_HOME/${REMOTE_PROGRESS_RUNTIME_DIR}/${REMOTE_PROGRESS_JOURNAL_FILE}"
SINCE_SEQ=${sinceSeq}
LIMIT=${limit}
if [ ! -f "$JOURNAL_FILE" ]; then
  exit 0
fi
awk -v since="$SINCE_SEQ" -v limit="$LIMIT" '
  limit > 0 && emitted >= limit { exit 0 }
  {
    line = $0
    if (line ~ /"seq"[[:space:]]*:[[:space:]]*[0-9]+/) {
      sub(/^.*"seq"[[:space:]]*:[[:space:]]*/, "", line)
      sub(/[^0-9].*$/, "", line)
      if ((line + 0) > since) {
        print $0
        emitted += 1
      }
    }
  }
' "$JOURNAL_FILE"
`;
}

export function buildAppendRemoteDeltaSpoolScript(opts: {
  invokerHome?: string;
  batch: DeltaBatch;
}): string {
  const invokerHome = opts.invokerHome ?? '~/.invoker';
  const homeB64 = base64Encode(invokerHome);
  const batchJson = JSON.stringify(opts.batch);
  const batchB64 = base64Encode(batchJson);
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(homeB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
SYNC_DIR="$INVOKER_HOME/${REMOTE_PROGRESS_RUNTIME_DIR}"
SPOOL_FILE="$SYNC_DIR/${REMOTE_DELTA_SPOOL_FILE}"
mkdir -p "$SYNC_DIR"
chmod 700 "$SYNC_DIR" 2>/dev/null || true
TMP_FILE="$SPOOL_FILE.tmp.$$"
printf '%s' ${shellPosixSingleQuote(batchB64)} | invoker_base64_decode > "$TMP_FILE"
printf '\\n' >> "$TMP_FILE"
cat "$TMP_FILE" >> "$SPOOL_FILE"
rm -f "$TMP_FILE"
sync -f "$SPOOL_FILE" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
printf "__INVOKER_SYNC_ACK__=%s\\n" "${opts.batch.highWaterSeq}"
`;
}

export function buildRemoteProgressJournalRuntimeFragment(
  meta: RemoteProgressJournalRuntimeMetadata,
): string {
  const attemptId = meta.attemptId?.trim() || meta.taskId;
  const requestCreatedAt = meta.requestCreatedAt ?? new Date(0).toISOString();
  const tombstonePollSeconds =
    typeof meta.tombstonePollSeconds === 'number'
    && Number.isFinite(meta.tombstonePollSeconds)
    && meta.tombstonePollSeconds > 0
      ? Math.max(1, Math.floor(meta.tombstonePollSeconds))
      : 2;

  return `INVOKER_REMOTE_SYNC_DIR="$INVOKER_HOME/${REMOTE_PROGRESS_RUNTIME_DIR}"
INVOKER_REMOTE_JOURNAL_FILE="$INVOKER_REMOTE_SYNC_DIR/${REMOTE_PROGRESS_JOURNAL_FILE}"
INVOKER_REMOTE_JOURNAL_SEQ_FILE="$INVOKER_REMOTE_SYNC_DIR/${REMOTE_PROGRESS_JOURNAL_SEQ_FILE}"
INVOKER_REMOTE_JOURNAL_LOCK="$INVOKER_REMOTE_SYNC_DIR/progress-journal.lock"
INVOKER_REMOTE_DELTA_SPOOL_FILE="$INVOKER_REMOTE_SYNC_DIR/${REMOTE_DELTA_SPOOL_FILE}"
INVOKER_REMOTE_STOP_REASON_FILE="$STAGING_DIR/stop-reason"
INVOKER_REMOTE_REQUEST_ID_JSON=${jsonShellLiteral(meta.requestId)}
INVOKER_REMOTE_TASK_ID_JSON=${jsonShellLiteral(meta.taskId)}
INVOKER_REMOTE_ATTEMPT_ID_JSON=${jsonShellLiteral(attemptId)}
INVOKER_REMOTE_WORKFLOW_ID_JSON=${jsonShellLiteral(meta.workflowId)}
INVOKER_REMOTE_WORKFLOW_ID_RAW=${shellPosixSingleQuote(meta.workflowId ?? '')}
INVOKER_REMOTE_EXECUTION_GENERATION_JSON=${jsonShellLiteral(meta.executionGeneration ?? null)}
INVOKER_REMOTE_REQUEST_CREATED_AT_JSON=${jsonShellLiteral(requestCreatedAt)}
INVOKER_REMOTE_WORKSPACE_PATH_JSON=${jsonShellLiteral(meta.workspacePath ?? null)}
INVOKER_REMOTE_BRANCH_JSON=${jsonShellLiteral(meta.branch ?? null)}
INVOKER_REMOTE_AGENT_SESSION_ID_JSON=${jsonShellLiteral(meta.agentSessionId ?? null)}
INVOKER_REMOTE_AGENT_NAME_JSON=${jsonShellLiteral(meta.agentName ?? null)}
INVOKER_REMOTE_HEARTBEAT_MARKER_JSON=${jsonShellLiteral(meta.heartbeatMarker)}
INVOKER_REMOTE_TOMBSTONE_POLL_SECONDS=${tombstonePollSeconds}
INVOKER_REMOTE_TOMBSTONE_MONITOR_PID=""

invoker_remote_now_iso() {
  date -u '+%Y-%m-%dT%H:%M:%S.000Z'
}

invoker_remote_base64_encode() {
  if base64 --wrap=0 >/dev/null 2>&1 </dev/null; then
    base64 --wrap=0
  else
    base64 | tr -d '\\n'
  fi
}

invoker_remote_kind_json() {
  case "$1" in
    attempt_started) printf '"attempt_started"' ;;
    heartbeat) printf '"heartbeat"' ;;
    output_chunk) printf '"output_chunk"' ;;
    attempt_finished) printf '"attempt_finished"' ;;
    *) printf '"unknown"' ;;
  esac
}

invoker_remote_append_entry() {
  local kind="$1"
  local payload_json="$2"
  local created_at="\${3:-$(invoker_remote_now_iso)}"
  local seq="0"
  local tmp_file
  mkdir -p "$INVOKER_REMOTE_SYNC_DIR"
  chmod 700 "$INVOKER_REMOTE_SYNC_DIR" 2>/dev/null || true
  while ! mkdir "$INVOKER_REMOTE_JOURNAL_LOCK" 2>/dev/null; do
    sleep 0.05
  done
  if [ -f "$INVOKER_REMOTE_JOURNAL_SEQ_FILE" ]; then
    seq="$(cat "$INVOKER_REMOTE_JOURNAL_SEQ_FILE" 2>/dev/null || printf '0')"
  fi
  case "$seq" in ''|*[!0-9]*) seq=0 ;; esac
  seq=$((seq + 1))
  tmp_file="$INVOKER_REMOTE_JOURNAL_SEQ_FILE.tmp.$$"
  printf '%s\\n' "$seq" > "$tmp_file"
  mv "$tmp_file" "$INVOKER_REMOTE_JOURNAL_SEQ_FILE"
  printf '{"schemaVersion":${REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION},"seq":%s,"kind":%s,"requestId":%s,"taskId":%s,"attemptId":%s,"workflowId":%s,"executionGeneration":%s,"requestCreatedAt":%s,"createdAt":"%s","payload":%s}\\n' \\
    "$seq" \\
    "$(invoker_remote_kind_json "$kind")" \\
    "$INVOKER_REMOTE_REQUEST_ID_JSON" \\
    "$INVOKER_REMOTE_TASK_ID_JSON" \\
    "$INVOKER_REMOTE_ATTEMPT_ID_JSON" \\
    "$INVOKER_REMOTE_WORKFLOW_ID_JSON" \\
    "$INVOKER_REMOTE_EXECUTION_GENERATION_JSON" \\
    "$INVOKER_REMOTE_REQUEST_CREATED_AT_JSON" \\
    "$created_at" \\
    "$payload_json" >> "$INVOKER_REMOTE_JOURNAL_FILE"
  sync -f "$INVOKER_REMOTE_JOURNAL_FILE" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
  rmdir "$INVOKER_REMOTE_JOURNAL_LOCK" 2>/dev/null || true
}

invoker_remote_append_attempt_started() {
  local payload_json
  payload_json="$(printf '{"workspacePath":%s,"branch":%s,"agentSessionId":%s,"agentName":%s}' \\
    "$INVOKER_REMOTE_WORKSPACE_PATH_JSON" \\
    "$INVOKER_REMOTE_BRANCH_JSON" \\
    "$INVOKER_REMOTE_AGENT_SESSION_ID_JSON" \\
    "$INVOKER_REMOTE_AGENT_NAME_JSON")"
  invoker_remote_append_entry attempt_started "$payload_json"
}

invoker_remote_append_heartbeat() {
  local epoch_seconds="$1"
  local payload_json
  payload_json="$(printf '{"marker":%s,"epochSeconds":%s,"workspacePath":%s,"branch":%s,"agentSessionId":%s,"agentName":%s}' \\
    "$INVOKER_REMOTE_HEARTBEAT_MARKER_JSON" \\
    "$epoch_seconds" \\
    "$INVOKER_REMOTE_WORKSPACE_PATH_JSON" \\
    "$INVOKER_REMOTE_BRANCH_JSON" \\
    "$INVOKER_REMOTE_AGENT_SESSION_ID_JSON" \\
    "$INVOKER_REMOTE_AGENT_NAME_JSON")"
  invoker_remote_append_entry heartbeat "$payload_json"
}

invoker_remote_output_filter() {
  local stream="$1"
  local stream_json
  case "$stream" in
    stderr) stream_json='"stderr"' ;;
    *) stream_json='"stdout"' ;;
  esac
  while IFS= read -r line; do
    local data_b64
    local payload_json
    data_b64="$(printf '%s\\n' "$line" | invoker_remote_base64_encode)"
    payload_json="$(printf '{"stream":%s,"dataBase64":"%s"}' "$stream_json" "$data_b64")"
    invoker_remote_append_entry output_chunk "$payload_json"
    printf '%s\\n' "$line"
  done
}

invoker_remote_append_attempt_finished() {
  local raw_status="$1"
  local exit_code="$2"
  local error_text="\${3:-}"
  local status_json='"failed"'
  local error_b64
  local payload_json
  if [ "$raw_status" = "completed" ]; then
    status_json='"completed"'
  fi
  error_b64="$(printf '%s' "$error_text" | invoker_remote_base64_encode)"
  payload_json="$(printf '{"status":%s,"exitCode":%s,"errorBase64":"%s","workspacePath":%s,"branch":%s,"agentSessionId":%s,"agentName":%s}' \\
    "$status_json" \\
    "$exit_code" \\
    "$error_b64" \\
    "$INVOKER_REMOTE_WORKSPACE_PATH_JSON" \\
    "$INVOKER_REMOTE_BRANCH_JSON" \\
    "$INVOKER_REMOTE_AGENT_SESSION_ID_JSON" \\
    "$INVOKER_REMOTE_AGENT_NAME_JSON")"
  invoker_remote_append_entry attempt_finished "$payload_json"
}

invoker_remote_workflow_tombstoned() {
  [ -n "$INVOKER_REMOTE_WORKFLOW_ID_RAW" ] || return 1
  [ -f "$INVOKER_REMOTE_DELTA_SPOOL_FILE" ] || return 1
  grep -F '"entityType":"workflow"' "$INVOKER_REMOTE_DELTA_SPOOL_FILE" \\
    | grep -F '"op":"tombstone"' \\
    | grep -F "\"entityId\":\"$INVOKER_REMOTE_WORKFLOW_ID_RAW\"" >/dev/null 2>&1
}

invoker_remote_start_tombstone_monitor() {
  local payload_pid="$1"
  [ -n "$INVOKER_REMOTE_WORKFLOW_ID_RAW" ] || return 0
  (
    while kill -0 "$payload_pid" 2>/dev/null; do
      sleep "$INVOKER_REMOTE_TOMBSTONE_POLL_SECONDS"
      if invoker_remote_workflow_tombstoned; then
        printf '%s' 'workflow tombstone received from home' > "$INVOKER_REMOTE_STOP_REASON_FILE"
        kill -TERM "$payload_pid" >/dev/null 2>&1 || true
        sleep 5
        kill -KILL "$payload_pid" >/dev/null 2>&1 || true
        exit 0
      fi
    done
  ) &
  INVOKER_REMOTE_TOMBSTONE_MONITOR_PID=$!
}

invoker_remote_stop_tombstone_monitor() {
  if [ -n "\${INVOKER_REMOTE_TOMBSTONE_MONITOR_PID:-}" ]; then
    kill "$INVOKER_REMOTE_TOMBSTONE_MONITOR_PID" >/dev/null 2>&1 || true
    wait "$INVOKER_REMOTE_TOMBSTONE_MONITOR_PID" 2>/dev/null || true
    INVOKER_REMOTE_TOMBSTONE_MONITOR_PID=""
  fi
}
`;
}
