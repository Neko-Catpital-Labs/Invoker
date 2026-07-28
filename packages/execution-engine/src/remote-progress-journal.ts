import {
  DELTA_BATCH_SCHEMA_VERSION,
  type DeltaBatch,
  type SyncEntityType,
  type SyncJournalEntry,
  type SyncJournalOp,
} from '@invoker/data-store';
import { buildPortableBase64DecodeFunction } from './remote-shell-fragments.js';
import { base64Encode, shellPosixSingleQuote } from './ssh-git-exec.js';

export const REMOTE_PROGRESS_JOURNAL_FILENAME = 'progress.ndjson';
export const REMOTE_SYNC_CONTROL_SPOOL_FILENAME = 'control-spool.ndjson';
export const REMOTE_PROGRESS_HIGH_WATER_MARKER = '__INVOKER_REMOTE_PROGRESS_HIGH_WATER__=';
export const REMOTE_SYNC_SPOOL_ACK_MARKER = '__INVOKER_REMOTE_SYNC_SPOOL_ACK__=';

export type RemoteProgressJournalEntryType =
  | 'attempt_started'
  | 'heartbeat'
  | 'output_chunk'
  | 'output_chunk_reference'
  | 'attempt_finished'
  | 'sync_journal_entry';

export interface RemoteProgressJournalEntry {
  seq: number;
  type?: RemoteProgressJournalEntryType | string;
  taskId?: string;
  task_id?: string;
  workflowId?: string;
  workflow_id?: string;
  attemptId?: string;
  attempt_id?: string;
  requestId?: string;
  request_id?: string;
  executionGeneration?: number;
  execution_generation?: number;
  createdAt?: string;
  created_at?: string;
  payload?: unknown;
  entityType?: SyncEntityType;
  entity_type?: SyncEntityType;
  entityId?: string;
  entity_id?: string;
  op?: SyncJournalOp;
  origin?: string;
}

export interface RemoteProgressRuntimeOptions {
  requestId: string;
  taskId: string;
  attemptId?: string;
  workflowId?: string;
  executionGeneration: number;
  workspacePath?: string;
  branch?: string;
  agentSessionId?: string;
}

export interface RemoteProgressPullScriptOptions {
  remoteInvokerHome?: string;
  sinceSeq: number;
  limit?: number;
}

export interface RemoteSyncSpoolScriptOptions {
  remoteInvokerHome?: string;
  batch: DeltaBatch;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function jsonString(value: string | undefined): string {
  return value === undefined ? 'null' : JSON.stringify(value);
}

function asNonNegativeInteger(name: string, value: number): number {
  const out = Math.trunc(value);
  if (!Number.isInteger(out) || out < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return out;
}

function text(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const out = String(value);
  return out.length > 0 ? out : undefined;
}

function integer(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const out = Number(value);
  return Number.isInteger(out) ? out : undefined;
}

function createdAt(entry: RemoteProgressJournalEntry): string {
  return text(entry.createdAt ?? entry.created_at) ?? new Date().toISOString();
}

function taskId(entry: RemoteProgressJournalEntry): string | undefined {
  return text(entry.taskId ?? entry.task_id);
}

function workflowId(entry: RemoteProgressJournalEntry): string | undefined {
  return text(entry.workflowId ?? entry.workflow_id);
}

function requestId(entry: RemoteProgressJournalEntry): string | undefined {
  return text(entry.requestId ?? entry.request_id);
}

function attemptId(entry: RemoteProgressJournalEntry): string | undefined {
  const explicit = text(entry.attemptId ?? entry.attempt_id);
  if (explicit) return explicit;
  const task = taskId(entry);
  if (!task) return undefined;
  return `${task}:remote:${requestId(entry) ?? 'unknown'}`;
}

function executionGeneration(entry: RemoteProgressJournalEntry): number {
  return integer(entry.executionGeneration ?? entry.execution_generation) ?? 0;
}

function payloadObject(entry: RemoteProgressJournalEntry): Record<string, unknown> {
  return entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
    ? entry.payload as Record<string, unknown>
    : {};
}

function syncEntry(
  seq: number,
  entityType: SyncEntityType,
  entityId: string,
  op: SyncJournalOp,
  payload: unknown,
  entryCreatedAt: string,
): SyncJournalEntry {
  return {
    seq,
    entityType,
    entityId,
    op,
    payload,
    origin: 'remote',
    createdAt: entryCreatedAt,
  };
}

function directSyncEntry(entry: RemoteProgressJournalEntry): SyncJournalEntry | undefined {
  const entityType = entry.entityType ?? entry.entity_type;
  const entityId = text(entry.entityId ?? entry.entity_id);
  const op = entry.op;
  if (!entityType || !entityId || !op) return undefined;
  return {
    seq: entry.seq,
    entityType,
    entityId,
    op,
    payload: entry.payload ?? null,
    origin: text(entry.origin) ?? 'remote',
    createdAt: createdAt(entry),
  };
}

function mapAttemptStarted(entry: RemoteProgressJournalEntry): SyncJournalEntry[] {
  const id = attemptId(entry);
  const nodeId = taskId(entry);
  if (!id || !nodeId) return [];
  const at = createdAt(entry);
  const payload = payloadObject(entry);
  return [
    syncEntry(entry.seq, 'attempt', id, 'upsert', {
      id,
      node_id: nodeId,
      attempt_number: 0,
      queue_priority: integer(payload.queue_priority) ?? 0,
      status: 'running',
      started_at: text(payload.started_at) ?? at,
      last_heartbeat_at: text(payload.last_heartbeat_at) ?? at,
      lease_expires_at: text(payload.lease_expires_at),
      branch: text(payload.branch),
      workspace_path: text(payload.workspace_path),
      agent_session_id: text(payload.agent_session_id),
      upstream_attempt_ids: text(payload.upstream_attempt_ids) ?? '[]',
      created_at: text(payload.created_at) ?? at,
    }, at),
  ];
}

function mapHeartbeat(entry: RemoteProgressJournalEntry): SyncJournalEntry[] {
  const id = attemptId(entry);
  const nodeId = taskId(entry);
  if (!id || !nodeId) return [];
  const at = createdAt(entry);
  const payload = payloadObject(entry);
  const entries: SyncJournalEntry[] = [
    syncEntry(entry.seq, 'attempt', id, 'upsert', {
      id,
      node_id: nodeId,
      attempt_number: 0,
      queue_priority: 0,
      status: 'running',
      last_heartbeat_at: text(payload.last_heartbeat_at) ?? at,
      upstream_attempt_ids: '[]',
      created_at: text(payload.created_at) ?? at,
    }, at),
  ];
  const wf = workflowId(entry);
  if (wf) {
    entries.push(syncEntry(entry.seq, 'task', nodeId, 'upsert', {
      id: nodeId,
      workflow_id: wf,
      status: 'running',
      last_heartbeat_at: text(payload.last_heartbeat_at) ?? at,
      execution_generation: executionGeneration(entry),
    }, at));
  }
  return entries;
}

function mapOutputChunk(entry: RemoteProgressJournalEntry): SyncJournalEntry[] {
  const task = taskId(entry);
  if (!task) return [];
  const at = createdAt(entry);
  const payload = payloadObject(entry);
  const offset = integer(payload.offset);
  if (offset === undefined) return [];
  const dataBase64 = text(payload.data_base64 ?? payload.dataBase64);
  const data = dataBase64 !== undefined
    ? Buffer.from(dataBase64, 'base64').toString('utf8')
    : text(payload.data) ?? '';
  return [
    syncEntry(entry.seq, 'output', `${task}:${offset}`, 'upsert', {
      task_id: task,
      offset,
      data,
      created_at: at,
    }, at),
  ];
}

function mapOutputReference(entry: RemoteProgressJournalEntry): SyncJournalEntry[] {
  const task = taskId(entry);
  if (!task) return [];
  const at = createdAt(entry);
  const payload = payloadObject(entry);
  const eventId = -Math.abs(entry.seq);
  return [
    syncEntry(entry.seq, 'event', String(eventId), 'upsert', {
      id: eventId,
      task_id: task,
      event_type: 'task.output_ref',
      payload: JSON.stringify(payload),
      created_at: at,
    }, at),
  ];
}

function mapAttemptFinished(entry: RemoteProgressJournalEntry): SyncJournalEntry[] {
  const id = attemptId(entry);
  const nodeId = taskId(entry);
  if (!id || !nodeId) return [];
  const at = createdAt(entry);
  const payload = payloadObject(entry);
  const exitCode = integer(payload.exit_code ?? payload.exitCode) ?? 1;
  const rawStatus = text(payload.status);
  const status = rawStatus === 'completed' || rawStatus === 'failed'
    ? rawStatus
    : exitCode === 0 ? 'completed' : 'failed';
  const entries: SyncJournalEntry[] = [
    syncEntry(entry.seq, 'attempt', id, 'upsert', {
      id,
      node_id: nodeId,
      attempt_number: 0,
      queue_priority: 0,
      status,
      completed_at: text(payload.completed_at) ?? at,
      exit_code: exitCode,
      error: text(payload.error),
      last_heartbeat_at: text(payload.last_heartbeat_at) ?? at,
      branch: text(payload.branch),
      commit_hash: text(payload.commit_hash ?? payload.commitHash),
      summary: text(payload.summary),
      workspace_path: text(payload.workspace_path),
      agent_session_id: text(payload.agent_session_id),
      upstream_attempt_ids: '[]',
      created_at: text(payload.created_at) ?? at,
    }, at),
  ];
  const wf = workflowId(entry);
  if (wf) {
    entries.push(syncEntry(entry.seq, 'task', nodeId, 'upsert', {
      id: nodeId,
      workflow_id: wf,
      status,
      completed_at: text(payload.completed_at) ?? at,
      exit_code: exitCode,
      error: text(payload.error),
      branch: text(payload.branch),
      commit_hash: text(payload.commit_hash ?? payload.commitHash),
      summary: text(payload.summary),
      workspace_path: text(payload.workspace_path),
      agent_session_id: text(payload.agent_session_id),
      execution_generation: executionGeneration(entry),
    }, at));
  }
  return entries;
}

export function remoteProgressEntryToSyncEntries(entry: RemoteProgressJournalEntry): SyncJournalEntry[] {
  const direct = directSyncEntry(entry);
  if (direct) return [direct];

  switch (entry.type) {
    case 'sync_journal_entry': {
      const nested = payloadObject(entry).entry;
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return [];
      return remoteProgressEntryToSyncEntries({
        ...(nested as RemoteProgressJournalEntry),
        seq: entry.seq,
      });
    }
    case 'attempt_started':
      return mapAttemptStarted(entry);
    case 'heartbeat':
      return mapHeartbeat(entry);
    case 'output_chunk':
      return mapOutputChunk(entry);
    case 'output_chunk_reference':
      return mapOutputReference(entry);
    case 'attempt_finished':
      return mapAttemptFinished(entry);
    default:
      return [];
  }
}

export function remoteProgressEntriesToDeltaBatch(options: {
  entries: RemoteProgressJournalEntry[];
  sinceSeq: number;
  highWaterSeq?: number;
}): DeltaBatch {
  const sinceSeq = asNonNegativeInteger('sinceSeq', options.sinceSeq);
  const sorted = options.entries
    .filter((entry) => Number.isInteger(entry.seq) && entry.seq > sinceSeq)
    .sort((a, b) => a.seq - b.seq);
  const mapped = sorted.flatMap((entry) => remoteProgressEntryToSyncEntries(entry));
  const entryHighWater = Math.max(0, ...sorted.map((entry) => entry.seq));
  const highWaterSeq = Math.max(
    sinceSeq,
    options.highWaterSeq === undefined
      ? entryHighWater
      : asNonNegativeInteger('highWaterSeq', options.highWaterSeq),
  );

  return {
    schemaVersion: DELTA_BATCH_SCHEMA_VERSION,
    sinceSeq,
    highWaterSeq,
    entries: mapped,
  };
}

export function parseRemoteProgressJournalLine(line: string): RemoteProgressJournalEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as RemoteProgressJournalEntry;
  if (!Number.isInteger(parsed.seq) || parsed.seq < 0) {
    throw new Error(`Remote progress journal entry has invalid seq: ${trimmed.slice(0, 120)}`);
  }
  return parsed;
}

export function parseRemoteProgressPullOutput(stdout: string, sinceSeq: number): {
  highWaterSeq: number;
  entries: RemoteProgressJournalEntry[];
} {
  const since = asNonNegativeInteger('sinceSeq', sinceSeq);
  let markedHighWater: number | undefined;
  const entries: RemoteProgressJournalEntry[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(REMOTE_PROGRESS_HIGH_WATER_MARKER)) {
      const raw = trimmed.slice(REMOTE_PROGRESS_HIGH_WATER_MARKER.length);
      const parsed = Number.parseInt(raw, 10);
      if (Number.isInteger(parsed) && parsed >= 0) markedHighWater = parsed;
      continue;
    }
    if (!trimmed.startsWith('{')) continue;
    const entry = parseRemoteProgressJournalLine(trimmed);
    if (entry) entries.push(entry);
  }

  return {
    highWaterSeq: Math.max(since, markedHighWater ?? 0, ...entries.map((entry) => entry.seq)),
    entries,
  };
}

export function parseRemoteSyncSpoolAck(stdout: string): number | undefined {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(REMOTE_SYNC_SPOOL_ACK_MARKER)) continue;
    const parsed = Number.parseInt(trimmed.slice(REMOTE_SYNC_SPOOL_ACK_MARKER.length), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

export function buildRemoteProgressJournalRuntimeScript(options: RemoteProgressRuntimeOptions): string {
  const requestId = jsonString(options.requestId);
  const taskId = jsonString(options.taskId);
  const attemptId = jsonString(options.attemptId);
  const workflowId = jsonString(options.workflowId);
  const workspacePath = jsonString(options.workspacePath);
  const branch = jsonString(options.branch);
  const agentSessionId = jsonString(options.agentSessionId);
  const executionGeneration = asNonNegativeInteger('executionGeneration', options.executionGeneration);
  const workflowTombstonePattern = options.workflowId
    ? json(`"entityType":"workflow","entityId":${json(options.workflowId)},"op":"tombstone"`)
    : "''";
  const taskStatusPattern = json(`"entityType":"task","entityId":${json(options.taskId)}`);

  return `INVOKER_SYNC_BASE_DIR="$INVOKER_HOME/runtime/ssh-executor"
INVOKER_PROGRESS_JOURNAL_PATH="$INVOKER_SYNC_BASE_DIR/${REMOTE_PROGRESS_JOURNAL_FILENAME}"
INVOKER_PROGRESS_JOURNAL_SEQ_PATH="$INVOKER_SYNC_BASE_DIR/progress.seq"
INVOKER_PROGRESS_JOURNAL_LOCK_DIR="$INVOKER_SYNC_BASE_DIR/progress.seq.lock"
INVOKER_SYNC_CONTROL_SPOOL_PATH="$INVOKER_SYNC_BASE_DIR/${REMOTE_SYNC_CONTROL_SPOOL_FILENAME}"
INVOKER_REQUEST_ID_JSON=${shellPosixSingleQuote(requestId)}
INVOKER_TASK_ID_JSON=${shellPosixSingleQuote(taskId)}
INVOKER_ATTEMPT_ID_JSON=${shellPosixSingleQuote(attemptId)}
INVOKER_WORKFLOW_ID_JSON=${shellPosixSingleQuote(workflowId)}
INVOKER_WORKSPACE_PATH_JSON=${shellPosixSingleQuote(workspacePath)}
INVOKER_BRANCH_JSON=${shellPosixSingleQuote(branch)}
INVOKER_AGENT_SESSION_ID_JSON=${shellPosixSingleQuote(agentSessionId)}
INVOKER_EXECUTION_GENERATION=${executionGeneration}
INVOKER_WORKFLOW_TOMBSTONE_PATTERN=${shellPosixSingleQuote(workflowTombstonePattern)}
INVOKER_TASK_STATUS_PATTERN=${shellPosixSingleQuote(taskStatusPattern)}
INVOKER_TASK_SAFE=$(printf '%s' ${shellPosixSingleQuote(options.taskId)} | tr -c 'A-Za-z0-9._-' '-')
INVOKER_ATTEMPT_SAFE=$(printf '%s' ${shellPosixSingleQuote(options.attemptId ?? options.taskId)} | tr -c 'A-Za-z0-9._-' '-')
INVOKER_PROGRESS_TASK_DIR="$INVOKER_SYNC_BASE_DIR/progress/$INVOKER_ATTEMPT_SAFE"
INVOKER_STDOUT_LOG="$INVOKER_PROGRESS_TASK_DIR/stdout.log"
INVOKER_STDERR_LOG="$INVOKER_PROGRESS_TASK_DIR/stderr.log"
INVOKER_STDOUT_OFFSET=0
INVOKER_STDERR_OFFSET=0

invoker_progress_now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%S.000Z"
}

invoker_progress_fsync() {
  sync -f "$1" >/dev/null 2>&1 || sync "$1" >/dev/null 2>&1 || true
}

invoker_progress_next_seq() {
  mkdir -p "$INVOKER_SYNC_BASE_DIR"
  local waited=0
  while ! mkdir "$INVOKER_PROGRESS_JOURNAL_LOCK_DIR" 2>/dev/null; do
    sleep 0.05
    waited=$((waited + 1))
    if [ "$waited" -gt 1200 ]; then
      rm -rf "$INVOKER_PROGRESS_JOURNAL_LOCK_DIR" >/dev/null 2>&1 || true
      waited=0
    fi
  done
  local seq
  seq=$(cat "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH" 2>/dev/null || printf '0')
  seq=$((seq + 1))
  printf '%s\\n' "$seq" > "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH.tmp.$$"
  mv "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH.tmp.$$" "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH"
  rmdir "$INVOKER_PROGRESS_JOURNAL_LOCK_DIR" >/dev/null 2>&1 || true
  printf '%s' "$seq"
}

invoker_progress_append() {
  local type="$1"
  local payload_json="$2"
  local seq
  local now
  seq=$(invoker_progress_next_seq)
  now=$(invoker_progress_now_iso)
  mkdir -p "$INVOKER_SYNC_BASE_DIR" "$INVOKER_PROGRESS_TASK_DIR"
  printf '{"seq":%s,"type":"%s","requestId":%s,"taskId":%s,"attemptId":%s,"workflowId":%s,"executionGeneration":%s,"createdAt":"%s","payload":%s}\\n' \\
    "$seq" "$type" "$INVOKER_REQUEST_ID_JSON" "$INVOKER_TASK_ID_JSON" "$INVOKER_ATTEMPT_ID_JSON" "$INVOKER_WORKFLOW_ID_JSON" "$INVOKER_EXECUTION_GENERATION" "$now" "$payload_json" >> "$INVOKER_PROGRESS_JOURNAL_PATH"
  invoker_progress_fsync "$INVOKER_PROGRESS_JOURNAL_PATH"
}

invoker_progress_attempt_started() {
  invoker_progress_append "attempt_started" "$(printf '{"started_at":"%s","workspace_path":%s,"branch":%s,"agent_session_id":%s}' "$(invoker_progress_now_iso)" "$INVOKER_WORKSPACE_PATH_JSON" "$INVOKER_BRANCH_JSON" "$INVOKER_AGENT_SESSION_ID_JSON")"
}

invoker_progress_output_refs() {
  local size
  size=$(wc -c < "$INVOKER_STDOUT_LOG" 2>/dev/null || printf '0')
  if [ "$size" -gt "$INVOKER_STDOUT_OFFSET" ]; then
    invoker_progress_append "output_chunk_reference" "$(printf '{"stream":"stdout","path":%s,"offset":%s,"length":%s}' "$(printf '%s' "$INVOKER_STDOUT_LOG" | sed 's/"/\\\\"/g; s/.*/"&"/')" "$INVOKER_STDOUT_OFFSET" "$((size - INVOKER_STDOUT_OFFSET))")"
    INVOKER_STDOUT_OFFSET="$size"
  fi
  size=$(wc -c < "$INVOKER_STDERR_LOG" 2>/dev/null || printf '0')
  if [ "$size" -gt "$INVOKER_STDERR_OFFSET" ]; then
    invoker_progress_append "output_chunk_reference" "$(printf '{"stream":"stderr","path":%s,"offset":%s,"length":%s}' "$(printf '%s' "$INVOKER_STDERR_LOG" | sed 's/"/\\\\"/g; s/.*/"&"/')" "$INVOKER_STDERR_OFFSET" "$((size - INVOKER_STDERR_OFFSET))")"
    INVOKER_STDERR_OFFSET="$size"
  fi
}

invoker_progress_heartbeat() {
  invoker_progress_output_refs
  invoker_progress_append "heartbeat" "$(printf '{"last_heartbeat_at":"%s"}' "$(invoker_progress_now_iso)")"
}

invoker_progress_attempt_finished() {
  local status="$1"
  local exit_code="$2"
  invoker_progress_output_refs
  invoker_progress_append "attempt_finished" "$(printf '{"status":"%s","exit_code":%s,"completed_at":"%s","workspace_path":%s,"branch":%s,"agent_session_id":%s}' "$status" "$exit_code" "$(invoker_progress_now_iso)" "$INVOKER_WORKSPACE_PATH_JSON" "$INVOKER_BRANCH_JSON" "$INVOKER_AGENT_SESSION_ID_JSON")"
}

invoker_sync_should_terminate() {
  [ -f "$INVOKER_SYNC_CONTROL_SPOOL_PATH" ] || return 1
  if [ "$INVOKER_WORKFLOW_ID_JSON" != "null" ] && grep -F "$INVOKER_WORKFLOW_TOMBSTONE_PATTERN" "$INVOKER_SYNC_CONTROL_SPOOL_PATH" >/dev/null 2>&1; then
    return 0
  fi
  if grep -F "$INVOKER_TASK_STATUS_PATTERN" "$INVOKER_SYNC_CONTROL_SPOOL_PATH" 2>/dev/null | grep -E '"status":"(closed|cancelled|canceled)"' >/dev/null 2>&1; then
    return 0
  fi
  return 1
}
`;
}

export function buildReadRemoteProgressJournalScript(options: RemoteProgressPullScriptOptions): string {
  const sinceSeq = asNonNegativeInteger('sinceSeq', options.sinceSeq);
  const limit = asNonNegativeInteger('limit', options.limit ?? 500);
  const homeB64 = base64Encode(options.remoteInvokerHome ?? '~/.invoker');

  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(homeB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
JOURNAL="$INVOKER_HOME/runtime/ssh-executor/${REMOTE_PROGRESS_JOURNAL_FILENAME}"
SINCE=${sinceSeq}
LIMIT=${limit}
if [ ! -f "$JOURNAL" ]; then
  printf '${REMOTE_PROGRESS_HIGH_WATER_MARKER}%s\\n' "$SINCE"
  exit 0
fi
HIGH=$(awk 'match($0, /"seq"[[:space:]]*:[[:space:]]*[0-9]+/) { s=substr($0, RSTART, RLENGTH); sub(/.*:/, "", s); if ((s + 0) > max) max=(s + 0) } END { printf "%d", max }' "$JOURNAL")
printf '${REMOTE_PROGRESS_HIGH_WATER_MARKER}%s\\n' "\${HIGH:-$SINCE}"
awk -v since="$SINCE" -v limit="$LIMIT" '
  match($0, /"seq"[[:space:]]*:[[:space:]]*[0-9]+/) {
    s=substr($0, RSTART, RLENGTH)
    sub(/.*:/, "", s)
    seq=s + 0
    if (seq > since) {
      print $0
      count += 1
      if (count >= limit) exit
    }
  }
' "$JOURNAL"
`;
}

export function buildAppendRemoteSyncSpoolScript(options: RemoteSyncSpoolScriptOptions): string {
  const homeB64 = base64Encode(options.remoteInvokerHome ?? '~/.invoker');
  const batchB64 = base64Encode(`${JSON.stringify(options.batch)}\n`);
  const highWaterSeq = asNonNegativeInteger('highWaterSeq', options.batch.highWaterSeq);

  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(homeB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
BASE="$INVOKER_HOME/runtime/ssh-executor"
SPOOL="$BASE/${REMOTE_SYNC_CONTROL_SPOOL_FILENAME}"
mkdir -p "$BASE"
umask 077
TMP="$BASE/.control-spool.$$"
printf '%s' ${shellPosixSingleQuote(batchB64)} | invoker_base64_decode > "$TMP"
cat "$TMP" >> "$SPOOL"
rm -f "$TMP"
sync -f "$SPOOL" >/dev/null 2>&1 || sync "$SPOOL" >/dev/null 2>&1 || true
printf '${REMOTE_SYNC_SPOOL_ACK_MARKER}%s\\n' '${highWaterSeq}'
`;
}
