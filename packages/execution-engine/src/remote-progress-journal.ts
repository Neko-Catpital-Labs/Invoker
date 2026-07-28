import type { DeltaBatch, SyncJournalEntry } from '@invoker/data-store';
import { DELTA_BATCH_SCHEMA_VERSION } from '@invoker/data-store';
import { buildPortableBase64DecodeFunction, buildSourceInvokerEnvScript } from './remote-shell-fragments.js';
import { base64Encode, shellPosixSingleQuote } from './ssh-git-exec.js';

export const REMOTE_PROGRESS_SYNC_DIR = 'runtime/ssh-executor/sync';
export const REMOTE_PROGRESS_JOURNAL_FILENAME = 'progress.ndjson';
export const REMOTE_PROGRESS_JOURNAL_SEQ_FILENAME = 'progress.seq';
export const REMOTE_PROGRESS_JOURNAL_LOCK_FILENAME = 'progress.lock';
export const REMOTE_DELTA_SPOOL_FILENAME = 'home-delta-spool.ndjson';
export const REMOTE_PROGRESS_HIGH_WATER_MARKER = '__INVOKER_SSH_SYNC_HIGH_WATER__=';
export const REMOTE_PROGRESS_JOURNAL_BEGIN_MARKER = '__INVOKER_SSH_SYNC_JOURNAL_BEGIN__';
export const REMOTE_PROGRESS_JOURNAL_END_MARKER = '__INVOKER_SSH_SYNC_JOURNAL_END__';
export const REMOTE_DELTA_SPOOL_ACK_MARKER = '__INVOKER_SSH_SYNC_SPOOL_ACK__=';

export type RemoteProgressJournalKind =
  | 'attempt_started'
  | 'heartbeat'
  | 'output_chunk'
  | 'attempt_finished';

export interface RemoteProgressJournalEntry {
  seq: number;
  kind: RemoteProgressJournalKind;
  taskId: string;
  attemptId?: string;
  workflowId?: string;
  requestId?: string;
  executionGeneration?: number;
  description?: string;
  createdAt: string;
  workspacePath?: string;
  branch?: string;
  agentSessionId?: string;
  stream?: 'stdout' | 'stderr';
  offset?: number;
  data?: string;
  status?: 'completed' | 'failed';
  exitCode?: number;
  error?: string;
  commitHash?: string;
  summary?: string;
}

export interface RemoteProgressJournalReadResult {
  highWaterSeq: number;
  entries: RemoteProgressJournalEntry[];
}

export interface RemoteProgressJournalRuntimeOptions {
  taskId: string;
  attemptId?: string;
  workflowId?: string;
  requestId?: string;
  executionGeneration?: number;
  description?: string;
  workspacePath?: string;
  branch?: string;
  agentSessionId?: string;
}

export interface RemoteProgressJournalReadScriptOptions {
  remoteInvokerHome?: string;
  sinceSeq: number;
  limit?: number;
}

export interface RemoteDeltaSpoolWriteScriptOptions {
  remoteInvokerHome?: string;
  batch: DeltaBatch;
}

export interface RemoteProgressToDeltaOptions {
  sinceSeq: number;
  highWaterSeq: number;
  remoteOrigin: string;
  loadTaskPayload?: (taskId: string) => Record<string, unknown> | undefined;
}

function asNonNegativeInteger(name: string, value: number): number {
  const int = Math.trunc(value);
  if (!Number.isInteger(int) || int < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return int;
}

function shellString(value: string | undefined): string {
  return shellPosixSingleQuote(value ?? '');
}

function shellNumber(value: number | undefined): string {
  return Number.isInteger(value) && value >= 0 ? String(value) : '0';
}

function syncDirShell(remoteInvokerHome = '~/.invoker'): string {
  return `${buildSourceInvokerEnvScript(remoteInvokerHome, 'INVOKER_HOME')}
INVOKER_REMOTE_SYNC_DIR="$INVOKER_HOME/${REMOTE_PROGRESS_SYNC_DIR}"
INVOKER_REMOTE_JOURNAL_PATH="$INVOKER_REMOTE_SYNC_DIR/${REMOTE_PROGRESS_JOURNAL_FILENAME}"
INVOKER_REMOTE_JOURNAL_SEQ_FILE="$INVOKER_REMOTE_SYNC_DIR/${REMOTE_PROGRESS_JOURNAL_SEQ_FILENAME}"
INVOKER_REMOTE_JOURNAL_LOCK_FILE="$INVOKER_REMOTE_SYNC_DIR/${REMOTE_PROGRESS_JOURNAL_LOCK_FILENAME}"
INVOKER_REMOTE_DELTA_SPOOL_PATH="$INVOKER_REMOTE_SYNC_DIR/${REMOTE_DELTA_SPOOL_FILENAME}"
`;
}

export function buildRemoteProgressJournalRuntimeShell(
  options: RemoteProgressJournalRuntimeOptions,
): string {
  return `INVOKER_REMOTE_SYNC_DIR="$INVOKER_HOME/${REMOTE_PROGRESS_SYNC_DIR}"
INVOKER_REMOTE_JOURNAL_PATH="$INVOKER_REMOTE_SYNC_DIR/${REMOTE_PROGRESS_JOURNAL_FILENAME}"
INVOKER_REMOTE_JOURNAL_SEQ_FILE="$INVOKER_REMOTE_SYNC_DIR/${REMOTE_PROGRESS_JOURNAL_SEQ_FILENAME}"
INVOKER_REMOTE_JOURNAL_LOCK_FILE="$INVOKER_REMOTE_SYNC_DIR/${REMOTE_PROGRESS_JOURNAL_LOCK_FILENAME}"
INVOKER_REMOTE_DELTA_SPOOL_PATH="$INVOKER_REMOTE_SYNC_DIR/${REMOTE_DELTA_SPOOL_FILENAME}"
INVOKER_REMOTE_TASK_ID=${shellString(options.taskId)}
INVOKER_REMOTE_ATTEMPT_ID=${shellString(options.attemptId)}
INVOKER_REMOTE_WORKFLOW_ID=${shellString(options.workflowId)}
INVOKER_REMOTE_REQUEST_ID=${shellString(options.requestId)}
INVOKER_REMOTE_EXECUTION_GENERATION=${shellNumber(options.executionGeneration)}
INVOKER_REMOTE_DESCRIPTION=${shellString(options.description)}
INVOKER_REMOTE_WORKSPACE_PATH=${shellString(options.workspacePath)}
INVOKER_REMOTE_BRANCH=${shellString(options.branch)}
INVOKER_REMOTE_AGENT_SESSION_ID=${shellString(options.agentSessionId)}

invoker_remote_progress_now() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

invoker_remote_json_escape() {
  local value="\${1-}"
  value=\${value//\\\\/\\\\\\\\}
  value=\${value//\\"/\\\\\\"}
  value=\${value//$'\\n'/\\\\n}
  value=\${value//$'\\r'/\\\\r}
  value=\${value//$'\\t'/\\\\t}
  printf '%s' "$value"
}

invoker_remote_json_string() {
  printf '"%s"' "$(invoker_remote_json_escape "\${1-}")"
}

invoker_remote_progress_common_fields() {
  local kind="$1"
  local created_at="$2"
  local json="\"kind\":$(invoker_remote_json_string "$kind"),\"taskId\":$(invoker_remote_json_string "$INVOKER_REMOTE_TASK_ID"),\"createdAt\":$(invoker_remote_json_string "$created_at")"
  if [ -n "\${INVOKER_REMOTE_ATTEMPT_ID:-}" ]; then
    json="$json,\"attemptId\":$(invoker_remote_json_string "$INVOKER_REMOTE_ATTEMPT_ID")"
  fi
  if [ -n "\${INVOKER_REMOTE_WORKFLOW_ID:-}" ]; then
    json="$json,\"workflowId\":$(invoker_remote_json_string "$INVOKER_REMOTE_WORKFLOW_ID")"
  fi
  if [ -n "\${INVOKER_REMOTE_REQUEST_ID:-}" ]; then
    json="$json,\"requestId\":$(invoker_remote_json_string "$INVOKER_REMOTE_REQUEST_ID")"
  fi
  json="$json,\"executionGeneration\":$INVOKER_REMOTE_EXECUTION_GENERATION"
  if [ -n "\${INVOKER_REMOTE_DESCRIPTION:-}" ]; then
    json="$json,\"description\":$(invoker_remote_json_string "$INVOKER_REMOTE_DESCRIPTION")"
  fi
  if [ -n "\${INVOKER_REMOTE_WORKSPACE_PATH:-}" ]; then
    json="$json,\"workspacePath\":$(invoker_remote_json_string "$INVOKER_REMOTE_WORKSPACE_PATH")"
  fi
  if [ -n "\${INVOKER_REMOTE_BRANCH:-}" ]; then
    json="$json,\"branch\":$(invoker_remote_json_string "$INVOKER_REMOTE_BRANCH")"
  fi
  if [ -n "\${INVOKER_REMOTE_AGENT_SESSION_ID:-}" ]; then
    json="$json,\"agentSessionId\":$(invoker_remote_json_string "$INVOKER_REMOTE_AGENT_SESSION_ID")"
  fi
  printf '%s' "$json"
}

invoker_remote_append_progress_fragment_unlocked() {
  local fragment="$1"
  mkdir -p "$INVOKER_REMOTE_SYNC_DIR"
  chmod 700 "$INVOKER_REMOTE_SYNC_DIR" 2>/dev/null || true
  local current_seq
  current_seq=$(cat "$INVOKER_REMOTE_JOURNAL_SEQ_FILE" 2>/dev/null || printf '0')
  case "$current_seq" in
    ''|*[!0-9]*) current_seq=0 ;;
  esac
  local next_seq=$((current_seq + 1))
  printf '%s\\n' "$next_seq" > "$INVOKER_REMOTE_JOURNAL_SEQ_FILE.tmp.$$"
  mv "$INVOKER_REMOTE_JOURNAL_SEQ_FILE.tmp.$$" "$INVOKER_REMOTE_JOURNAL_SEQ_FILE"
  printf '{"seq":%s,%s}\\n' "$next_seq" "$fragment" >> "$INVOKER_REMOTE_JOURNAL_PATH"
  if ! sync -f "$INVOKER_REMOTE_JOURNAL_PATH" >/dev/null 2>&1; then
    sync >/dev/null 2>&1 || true
  fi
}

invoker_remote_append_progress_fragment() {
  local fragment="$1"
  if command -v flock >/dev/null 2>&1; then
    (
      flock 9
      invoker_remote_append_progress_fragment_unlocked "$fragment"
    ) 9>"$INVOKER_REMOTE_JOURNAL_LOCK_FILE"
  else
    invoker_remote_append_progress_fragment_unlocked "$fragment"
  fi
}

invoker_remote_journal_attempt_started() {
  [ -n "\${INVOKER_REMOTE_TASK_ID:-}" ] || return 0
  local at
  at=$(invoker_remote_progress_now)
  invoker_remote_append_progress_fragment "$(invoker_remote_progress_common_fields attempt_started "$at")"
}

invoker_remote_journal_heartbeat() {
  [ -n "\${INVOKER_REMOTE_TASK_ID:-}" ] || return 0
  local at
  at=$(invoker_remote_progress_now)
  invoker_remote_append_progress_fragment "$(invoker_remote_progress_common_fields heartbeat "$at")"
}

invoker_remote_journal_output_chunk() {
  [ -n "\${INVOKER_REMOTE_TASK_ID:-}" ] || return 0
  local stream="$1"
  local data="$2"
  local at
  at=$(invoker_remote_progress_now)
  mkdir -p "$INVOKER_REMOTE_SYNC_DIR"
  chmod 700 "$INVOKER_REMOTE_SYNC_DIR" 2>/dev/null || true
  local bytes
  bytes=$(printf '%s' "$data" | wc -c | tr -d '[:space:]')
  [ -n "$bytes" ] || bytes=0
  local output_offset_file="$INVOKER_REMOTE_SYNC_DIR/output-offset-${options.taskId.replace(/[^A-Za-z0-9._-]+/g, '-')}.seq"
  invoker_remote_append_output_unlocked() {
    local current_offset
    current_offset=$(cat "$output_offset_file" 2>/dev/null || printf '0')
    case "$current_offset" in
      ''|*[!0-9]*) current_offset=0 ;;
    esac
    local next_offset=$((current_offset + bytes))
    printf '%s\\n' "$next_offset" > "$output_offset_file.tmp.$$"
    mv "$output_offset_file.tmp.$$" "$output_offset_file"
    local fragment
    fragment="$(invoker_remote_progress_common_fields output_chunk "$at"),\"stream\":$(invoker_remote_json_string "$stream"),\"offset\":$current_offset,\"data\":$(invoker_remote_json_string "$data")"
    invoker_remote_append_progress_fragment_unlocked "$fragment"
  }
  if command -v flock >/dev/null 2>&1; then
    (
      flock 9
      invoker_remote_append_output_unlocked
    ) 9>"$INVOKER_REMOTE_JOURNAL_LOCK_FILE"
  else
    invoker_remote_append_output_unlocked
  fi
}

invoker_remote_journal_stream() {
  local stream="$1"
  local line
  while IFS= read -r line; do
    printf '%s\\n' "$line"
    invoker_remote_journal_output_chunk "$stream" "$line"$'\\n'
  done
}

invoker_remote_journal_attempt_finished() {
  [ -n "\${INVOKER_REMOTE_TASK_ID:-}" ] || return 0
  local exit_code="$1"
  local error_text="\${2-}"
  local at
  at=$(invoker_remote_progress_now)
  local status="completed"
  if [ "$exit_code" != "0" ]; then
    status="failed"
  fi
  local fragment
  fragment="$(invoker_remote_progress_common_fields attempt_finished "$at"),\\"status\\":$(invoker_remote_json_string "$status"),\\"exitCode\\":$exit_code"
  if [ -n "$error_text" ]; then
    fragment="$fragment,\\"error\\":$(invoker_remote_json_string "$error_text")"
  fi
  invoker_remote_append_progress_fragment "$fragment"
}

invoker_remote_sync_should_stop() {
  [ -n "\${INVOKER_REMOTE_WORKFLOW_ID:-}" ] || return 1
  [ -f "$INVOKER_REMOTE_DELTA_SPOOL_PATH" ] || return 1
  local workflow_field
  workflow_field="\\"entityId\\":$(invoker_remote_json_string "$INVOKER_REMOTE_WORKFLOW_ID")"
  grep -F '"entityType":"workflow"' "$INVOKER_REMOTE_DELTA_SPOOL_PATH" 2>/dev/null \
    | grep -F '"op":"tombstone"' \
    | grep -F "$workflow_field" >/dev/null 2>&1
}
`;
}

export function buildReadRemoteProgressJournalScript(
  options: RemoteProgressJournalReadScriptOptions,
): string {
  const sinceSeq = asNonNegativeInteger('sinceSeq', options.sinceSeq);
  const limit = asNonNegativeInteger('limit', options.limit ?? 1000);
  return `set -euo pipefail
${syncDirShell(options.remoteInvokerHome)}
INVOKER_SYNC_SINCE=${sinceSeq}
INVOKER_SYNC_LIMIT=${limit}
mkdir -p "$INVOKER_REMOTE_SYNC_DIR"
HIGH_WATER=0
if [ -f "$INVOKER_REMOTE_JOURNAL_SEQ_FILE" ]; then
  HIGH_WATER=$(cat "$INVOKER_REMOTE_JOURNAL_SEQ_FILE" 2>/dev/null || printf '0')
fi
case "$HIGH_WATER" in
  ''|*[!0-9]*) HIGH_WATER=0 ;;
esac
if [ -f "$INVOKER_REMOTE_JOURNAL_PATH" ]; then
  FILE_HIGH=$(awk '
    /^\\{"seq":[0-9]+/ {
      seq=$0
      sub(/^\\{"seq":/, "", seq)
      sub(/,.*/, "", seq)
      if ((seq + 0) > high) high = seq + 0
    }
    END { print high + 0 }
  ' "$INVOKER_REMOTE_JOURNAL_PATH")
  if [ "$FILE_HIGH" -gt "$HIGH_WATER" ]; then
    HIGH_WATER="$FILE_HIGH"
  fi
fi
printf '${REMOTE_PROGRESS_HIGH_WATER_MARKER}%s\\n' "$HIGH_WATER"
printf '${REMOTE_PROGRESS_JOURNAL_BEGIN_MARKER}\\n'
if [ -f "$INVOKER_REMOTE_JOURNAL_PATH" ] && [ "$INVOKER_SYNC_LIMIT" -gt 0 ]; then
  awk -v since="$INVOKER_SYNC_SINCE" -v limit="$INVOKER_SYNC_LIMIT" '
    BEGIN { count = 0 }
    /^\\{"seq":[0-9]+/ {
      seq=$0
      sub(/^\\{"seq":/, "", seq)
      sub(/,.*/, "", seq)
      if ((seq + 0) > since && count < limit) {
        print $0
        count++
      }
    }
  ' "$INVOKER_REMOTE_JOURNAL_PATH"
fi
printf '${REMOTE_PROGRESS_JOURNAL_END_MARKER}\\n'
`;
}

export function parseRemoteProgressJournalOutput(stdout: string): RemoteProgressJournalReadResult {
  const lines = stdout.split(/\r?\n/);
  const highWaterLine = [...lines].reverse().find((line) => line.startsWith(REMOTE_PROGRESS_HIGH_WATER_MARKER));
  const parsedHighWater = highWaterLine
    ? Number.parseInt(highWaterLine.slice(REMOTE_PROGRESS_HIGH_WATER_MARKER.length).trim(), 10)
    : 0;
  const begin = lines.findIndex((line) => line.trim() === REMOTE_PROGRESS_JOURNAL_BEGIN_MARKER);
  const end = lines.findIndex((line, index) => index > begin && line.trim() === REMOTE_PROGRESS_JOURNAL_END_MARKER);
  const body = begin >= 0 && end >= 0
    ? lines.slice(begin + 1, end)
    : lines.filter((line) => line.trim().startsWith('{'));
  const entries = body
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseRemoteProgressJournalEntry(line));
  const maxEntrySeq = Math.max(0, ...entries.map((entry) => entry.seq));
  const highWaterSeq = Math.max(
    Number.isFinite(parsedHighWater) && parsedHighWater >= 0 ? parsedHighWater : 0,
    maxEntrySeq,
  );
  return { highWaterSeq, entries };
}

export function parseRemoteProgressJournalEntry(line: string): RemoteProgressJournalEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error(`Invalid remote progress journal JSON line: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Remote progress journal entry must be an object');
  }
  const entry = parsed as Record<string, unknown>;
  const seq = Number(entry.seq);
  const kind = entry.kind;
  const taskId = entry.taskId;
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new Error('Remote progress journal entry seq must be a positive integer');
  }
  if (
    kind !== 'attempt_started'
    && kind !== 'heartbeat'
    && kind !== 'output_chunk'
    && kind !== 'attempt_finished'
  ) {
    throw new Error(`Unsupported remote progress journal kind ${String(kind)}`);
  }
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('Remote progress journal entry taskId is required');
  }
  const createdAt = typeof entry.createdAt === 'string' && entry.createdAt
    ? entry.createdAt
    : new Date().toISOString();
  const out: RemoteProgressJournalEntry = {
    seq,
    kind,
    taskId,
    createdAt,
  };
  copyOptionalString(entry, out, 'attemptId');
  copyOptionalString(entry, out, 'workflowId');
  copyOptionalString(entry, out, 'requestId');
  copyOptionalString(entry, out, 'description');
  copyOptionalString(entry, out, 'workspacePath');
  copyOptionalString(entry, out, 'branch');
  copyOptionalString(entry, out, 'agentSessionId');
  copyOptionalString(entry, out, 'data');
  copyOptionalString(entry, out, 'error');
  copyOptionalString(entry, out, 'commitHash');
  copyOptionalString(entry, out, 'summary');
  if (entry.stream === 'stdout' || entry.stream === 'stderr') out.stream = entry.stream;
  if (Number.isInteger(Number(entry.offset)) && Number(entry.offset) >= 0) out.offset = Number(entry.offset);
  if (Number.isInteger(Number(entry.exitCode))) out.exitCode = Number(entry.exitCode);
  if (Number.isInteger(Number(entry.executionGeneration)) && Number(entry.executionGeneration) >= 0) {
    out.executionGeneration = Number(entry.executionGeneration);
  }
  if (entry.status === 'completed' || entry.status === 'failed') out.status = entry.status;
  return out;
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: RemoteProgressJournalEntry,
  key: keyof RemoteProgressJournalEntry,
): void {
  const value = source[key];
  if (typeof value === 'string' && value.length > 0) {
    (target as Record<string, unknown>)[key] = value;
  }
}

function text(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function integer(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

function taskPayloadForRemoteEntry(
  entry: RemoteProgressJournalEntry,
  status: 'running' | 'completed' | 'failed',
  loadTaskPayload?: (taskId: string) => Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const existing = loadTaskPayload?.(entry.taskId);
  const workflowId = text(existing?.workflow_id) ?? entry.workflowId;
  if (!workflowId) return undefined;
  const currentVersion = integer(existing?.task_state_version) ?? 0;
  return {
    ...(existing ?? {}),
    id: entry.taskId,
    workflow_id: workflowId,
    description: text(existing?.description) ?? entry.description ?? entry.taskId,
    dependencies: existing?.dependencies ?? [],
    created_at: text(existing?.created_at) ?? entry.createdAt,
    updated_at: entry.createdAt,
    status,
    execution_generation: entry.executionGeneration ?? integer(existing?.execution_generation) ?? 0,
    selected_attempt_id: entry.attemptId ?? text(existing?.selected_attempt_id) ?? null,
    task_state_version: currentVersion + 1,
    ...(entry.requestId ? { action_request_id: entry.requestId } : {}),
    ...(entry.workspacePath ? { workspace_path: entry.workspacePath } : {}),
    ...(entry.branch ? { branch: entry.branch } : {}),
    ...(entry.agentSessionId ? { agent_session_id: entry.agentSessionId } : {}),
    ...(entry.kind === 'heartbeat' || entry.kind === 'attempt_started' ? { last_heartbeat_at: entry.createdAt } : {}),
    ...(entry.kind === 'attempt_started' ? { started_at: entry.createdAt } : {}),
    ...(entry.kind === 'attempt_finished' ? {
      completed_at: entry.createdAt,
      last_heartbeat_at: entry.createdAt,
      exit_code: entry.exitCode ?? (status === 'completed' ? 0 : 1),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.commitHash ? { commit_hash: entry.commitHash } : {}),
      ...(entry.summary ? { summary: entry.summary } : {}),
    } : {}),
  };
}

function attemptPayloadForRemoteEntry(
  entry: RemoteProgressJournalEntry,
  status: 'running' | 'completed' | 'failed',
): Record<string, unknown> | undefined {
  if (!entry.attemptId) return undefined;
  return {
    id: entry.attemptId,
    node_id: entry.taskId,
    attempt_number: 0,
    queue_priority: 0,
    status,
    upstream_attempt_ids: [],
    created_at: entry.createdAt,
    ...(entry.kind === 'attempt_started' ? {
      started_at: entry.createdAt,
      claimed_at: entry.createdAt,
      last_heartbeat_at: entry.createdAt,
    } : {}),
    ...(entry.kind === 'heartbeat' ? {
      last_heartbeat_at: entry.createdAt,
    } : {}),
    ...(entry.kind === 'attempt_finished' ? {
      completed_at: entry.createdAt,
      last_heartbeat_at: entry.createdAt,
      exit_code: entry.exitCode ?? (status === 'completed' ? 0 : 1),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.commitHash ? { commit_hash: entry.commitHash } : {}),
      ...(entry.summary ? { summary: entry.summary } : {}),
    } : {}),
    ...(entry.workspacePath ? { workspace_path: entry.workspacePath } : {}),
    ...(entry.branch ? { branch: entry.branch } : {}),
    ...(entry.agentSessionId ? { agent_session_id: entry.agentSessionId } : {}),
  };
}

function syncEntry(
  seq: number,
  entityType: SyncJournalEntry['entityType'],
  entityId: string,
  payload: Record<string, unknown>,
  origin: string,
  createdAt: string,
): SyncJournalEntry {
  return {
    seq,
    entityType,
    entityId,
    op: 'upsert',
    payload,
    origin,
    createdAt,
  };
}

export function remoteProgressEntriesToDeltaBatch(
  remoteEntries: RemoteProgressJournalEntry[],
  options: RemoteProgressToDeltaOptions,
): DeltaBatch {
  const sinceSeq = asNonNegativeInteger('sinceSeq', options.sinceSeq);
  const highWaterSeq = Math.max(
    sinceSeq,
    asNonNegativeInteger('highWaterSeq', options.highWaterSeq),
    ...remoteEntries.map((entry) => entry.seq),
  );
  const entries: SyncJournalEntry[] = [];

  for (const entry of remoteEntries.slice().sort((a, b) => a.seq - b.seq)) {
    switch (entry.kind) {
      case 'attempt_started': {
        const taskPayload = taskPayloadForRemoteEntry(entry, 'running', options.loadTaskPayload);
        if (taskPayload) {
          entries.push(syncEntry(entry.seq, 'task', entry.taskId, taskPayload, options.remoteOrigin, entry.createdAt));
        }
        const attemptPayload = attemptPayloadForRemoteEntry(entry, 'running');
        if (attemptPayload) {
          entries.push(syncEntry(entry.seq, 'attempt', entry.attemptId!, attemptPayload, options.remoteOrigin, entry.createdAt));
        }
        break;
      }
      case 'heartbeat': {
        const taskPayload = taskPayloadForRemoteEntry(entry, 'running', options.loadTaskPayload);
        if (taskPayload) {
          entries.push(syncEntry(entry.seq, 'task', entry.taskId, taskPayload, options.remoteOrigin, entry.createdAt));
        }
        const attemptPayload = attemptPayloadForRemoteEntry(entry, 'running');
        if (attemptPayload) {
          entries.push(syncEntry(entry.seq, 'attempt', entry.attemptId!, attemptPayload, options.remoteOrigin, entry.createdAt));
        }
        break;
      }
      case 'output_chunk': {
        const taskPayload = options.loadTaskPayload?.(entry.taskId)
          ? undefined
          : taskPayloadForRemoteEntry(entry, 'running', options.loadTaskPayload);
        if (taskPayload) {
          entries.push(syncEntry(entry.seq, 'task', entry.taskId, taskPayload, options.remoteOrigin, entry.createdAt));
        }
        entries.push(syncEntry(
          entry.seq,
          'output',
          `${entry.taskId}:${entry.offset ?? entry.seq}`,
          {
            task_id: entry.taskId,
            offset: entry.offset ?? entry.seq,
            data: entry.data ?? '',
            created_at: entry.createdAt,
          },
          options.remoteOrigin,
          entry.createdAt,
        ));
        break;
      }
      case 'attempt_finished': {
        const status = entry.status ?? (entry.exitCode === 0 ? 'completed' : 'failed');
        const taskPayload = taskPayloadForRemoteEntry(entry, status, options.loadTaskPayload);
        if (taskPayload) {
          entries.push(syncEntry(entry.seq, 'task', entry.taskId, taskPayload, options.remoteOrigin, entry.createdAt));
        }
        const attemptPayload = attemptPayloadForRemoteEntry(entry, status);
        if (attemptPayload) {
          entries.push(syncEntry(entry.seq, 'attempt', entry.attemptId!, attemptPayload, options.remoteOrigin, entry.createdAt));
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    schemaVersion: DELTA_BATCH_SCHEMA_VERSION,
    sinceSeq,
    highWaterSeq,
    entries,
  };
}

export function buildRemoteDeltaSpoolLines(batch: DeltaBatch): string {
  return batch.entries
    .map((entry) => JSON.stringify({
      schemaVersion: batch.schemaVersion,
      batchSinceSeq: batch.sinceSeq,
      batchHighWaterSeq: batch.highWaterSeq,
      seq: entry.seq,
      entityType: entry.entityType,
      entityId: entry.entityId,
      op: entry.op,
      payload: entry.payload,
      origin: entry.origin,
      createdAt: entry.createdAt,
    }))
    .join('\n') + (batch.entries.length > 0 ? '\n' : '');
}

export function buildWriteRemoteDeltaSpoolScript(options: RemoteDeltaSpoolWriteScriptOptions): string {
  const lines = buildRemoteDeltaSpoolLines(options.batch);
  const payloadB64 = base64Encode(lines);
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
${syncDirShell(options.remoteInvokerHome)}
mkdir -p "$INVOKER_REMOTE_SYNC_DIR"
chmod 700 "$INVOKER_REMOTE_SYNC_DIR" 2>/dev/null || true
TMP="$INVOKER_REMOTE_DELTA_SPOOL_PATH.tmp.$$"
printf '%s' ${shellPosixSingleQuote(payloadB64)} | invoker_base64_decode > "$TMP"
cat "$TMP" >> "$INVOKER_REMOTE_DELTA_SPOOL_PATH"
rm -f "$TMP"
if ! sync -f "$INVOKER_REMOTE_DELTA_SPOOL_PATH" >/dev/null 2>&1; then
  sync >/dev/null 2>&1 || true
fi
printf '${REMOTE_DELTA_SPOOL_ACK_MARKER}%s\\n' '${options.batch.highWaterSeq}'
`;
}
