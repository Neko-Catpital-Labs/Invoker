import {
  DELTA_BATCH_SCHEMA_VERSION,
  type DeltaBatch,
  type SyncJournalEntry,
} from '@invoker/data-store';
import { buildPortableBase64DecodeFunction, buildSourceInvokerEnvScript } from './remote-shell-fragments.js';
import { base64Encode, shellPosixSingleQuote } from './ssh-git-exec.js';

export const REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION = 1;
export const REMOTE_PROGRESS_JOURNAL_FILENAME = 'progress.ndjson';
export const REMOTE_SYNC_SPOOL_FILENAME = 'sync-spool.ndjson';
export const REMOTE_PROGRESS_SEQ_FILENAME = '.progress-seq';

export type RemoteProgressJournalKind =
  | 'attempt_started'
  | 'heartbeat'
  | 'output_chunk'
  | 'attempt_finished';

export interface RemoteProgressJournalEntry {
  schemaVersion: typeof REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION;
  seq: number;
  kind: RemoteProgressJournalKind;
  executionId: string;
  taskId: string;
  attemptId: string;
  workflowId?: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface ParsedRemoteProgressJournal {
  highWaterSeq: number;
  entries: RemoteProgressJournalEntry[];
  malformedLines: number;
}

export interface RemoteProgressPullScriptOptions {
  remoteInvokerHome?: string;
  sinceSeq: number;
}

export interface RemoteSyncSpoolScriptOptions {
  remoteInvokerHome?: string;
  entriesJsonLines: string;
  highWaterSeq: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return value;
}

function decodeData(payload: Record<string, unknown>): string {
  if (typeof payload.data === 'string') return payload.data;
  if (typeof payload.dataB64 === 'string') {
    return Buffer.from(payload.dataB64, 'base64').toString('utf8');
  }
  return '';
}

function normalizeRemoteEntry(value: unknown): RemoteProgressJournalEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION) return undefined;
  const seq = asInteger(record.seq);
  const kind = asString(record.kind) as RemoteProgressJournalKind | undefined;
  const executionId = asString(record.executionId);
  const taskId = asString(record.taskId);
  const attemptId = asString(record.attemptId);
  const createdAt = asString(record.createdAt);
  const payload = record.payload;
  if (
    seq === undefined
    || seq < 0
    || !kind
    || !['attempt_started', 'heartbeat', 'output_chunk', 'attempt_finished'].includes(kind)
    || !executionId
    || !taskId
    || !attemptId
    || !createdAt
    || !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
  ) {
    return undefined;
  }

  return {
    schemaVersion: REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION,
    seq,
    kind,
    executionId,
    taskId,
    attemptId,
    ...(asString(record.workflowId) ? { workflowId: asString(record.workflowId) } : {}),
    createdAt,
    payload: payload as Record<string, unknown>,
  };
}

export function parseRemoteProgressJournal(text: string): ParsedRemoteProgressJournal {
  const entries: RemoteProgressJournalEntry[] = [];
  let malformedLines = 0;
  let highWaterSeq = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const entry = normalizeRemoteEntry(JSON.parse(line));
      if (!entry) {
        malformedLines += 1;
        continue;
      }
      highWaterSeq = Math.max(highWaterSeq, entry.seq);
      entries.push(entry);
    } catch {
      malformedLines += 1;
    }
  }

  entries.sort((a, b) => a.seq - b.seq);
  return { highWaterSeq, entries, malformedLines };
}

function attemptPayload(entry: RemoteProgressJournalEntry, status: 'running' | 'completed' | 'failed'): Record<string, unknown> {
  const payload = entry.payload;
  const startedAt = asString(payload.startedAt) ?? asString(payload.started_at);
  const completedAt = asString(payload.completedAt) ?? asString(payload.completed_at);
  const lastHeartbeatAt = asString(payload.lastHeartbeatAt) ?? asString(payload.last_heartbeat_at);
  const exitCode = asInteger(payload.exitCode) ?? asInteger(payload.exit_code);
  const error = asString(payload.error);
  const branch = asString(payload.branch);
  const workspacePath = asString(payload.workspacePath) ?? asString(payload.workspace_path);

  return {
    id: entry.attemptId,
    node_id: entry.taskId,
    queue_priority: 0,
    status,
    upstream_attempt_ids: [],
    created_at: asString(payload.createdAt) ?? asString(payload.created_at) ?? entry.createdAt,
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(completedAt ? { completed_at: completedAt } : {}),
    ...(lastHeartbeatAt ? { last_heartbeat_at: lastHeartbeatAt } : {}),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(error ? { error } : {}),
    ...(branch ? { branch } : {}),
    ...(workspacePath ? { workspace_path: workspacePath } : {}),
  };
}

function remoteEntryToSyncEntries(entry: RemoteProgressJournalEntry): SyncJournalEntry[] {
  switch (entry.kind) {
    case 'attempt_started':
      return [{
        seq: entry.seq,
        entityType: 'attempt',
        entityId: entry.attemptId,
        op: 'upsert',
        payload: attemptPayload(entry, 'running'),
        origin: 'remote',
        createdAt: entry.createdAt,
      }];
    case 'heartbeat':
      return [{
        seq: entry.seq,
        entityType: 'attempt',
        entityId: entry.attemptId,
        op: 'upsert',
        payload: attemptPayload(entry, 'running'),
        origin: 'remote',
        createdAt: entry.createdAt,
      }];
    case 'output_chunk': {
      const offset = asInteger(entry.payload.offset) ?? entry.seq;
      return [{
        seq: entry.seq,
        entityType: 'output',
        entityId: `${entry.taskId}:${offset}`,
        op: 'upsert',
        payload: {
          task_id: entry.taskId,
          offset,
          data: decodeData(entry.payload),
          created_at: entry.createdAt,
        },
        origin: 'remote',
        createdAt: entry.createdAt,
      }];
    }
    case 'attempt_finished': {
      const exitCode = asInteger(entry.payload.exitCode) ?? asInteger(entry.payload.exit_code);
      const status = exitCode === 0 ? 'completed' : 'failed';
      return [{
        seq: entry.seq,
        entityType: 'attempt',
        entityId: entry.attemptId,
        op: 'upsert',
        payload: attemptPayload(entry, status),
        origin: 'remote',
        createdAt: entry.createdAt,
      }];
    }
    default:
      return [];
  }
}

export function remoteProgressJournalToDeltaBatch(
  journalText: string,
  sinceSeq: number,
): DeltaBatch {
  const since = Math.max(0, Math.trunc(sinceSeq));
  const parsed = parseRemoteProgressJournal(journalText);
  const entries = parsed.entries
    .filter((entry) => entry.seq > since)
    .flatMap((entry) => remoteEntryToSyncEntries(entry))
    .sort((a, b) => a.seq - b.seq);

  return {
    schemaVersion: DELTA_BATCH_SCHEMA_VERSION,
    sinceSeq: since,
    highWaterSeq: Math.max(since, parsed.highWaterSeq),
    entries,
  };
}

export function buildReadRemoteProgressJournalScript(opts: RemoteProgressPullScriptOptions): string {
  const since = Math.max(0, Math.trunc(opts.sinceSeq));
  return `set -euo pipefail
${buildSourceInvokerEnvScript(opts.remoteInvokerHome ?? '~/.invoker', 'INVOKER_HOME')}
BASE="$INVOKER_HOME/runtime/ssh-executor"
SINCE=${since}
if [ ! -d "$BASE" ]; then
  exit 0
fi
find "$BASE" -type f -name '${REMOTE_PROGRESS_JOURNAL_FILENAME}' -print | sort | while IFS= read -r JOURNAL; do
  [ -f "$JOURNAL" ] || continue
  cat "$JOURNAL"
done
`;
}

export function buildAppendRemoteSyncSpoolScript(opts: RemoteSyncSpoolScriptOptions): string {
  const payloadB64 = base64Encode(opts.entriesJsonLines.endsWith('\n')
    ? opts.entriesJsonLines
    : `${opts.entriesJsonLines}\n`);
  const highWaterSeq = Math.max(0, Math.trunc(opts.highWaterSeq));
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
${buildSourceInvokerEnvScript(opts.remoteInvokerHome ?? '~/.invoker', 'INVOKER_HOME')}
BASE="$INVOKER_HOME/runtime/ssh-executor"
mkdir -p "$BASE"
SPOOL="$BASE/${REMOTE_SYNC_SPOOL_FILENAME}"
TMP="$SPOOL.tmp.$$"
printf '%s' ${shellPosixSingleQuote(payloadB64)} | invoker_base64_decode > "$TMP"
cat "$TMP" >> "$SPOOL"
rm -f "$TMP"
if command -v sync >/dev/null 2>&1; then
  sync -f "$SPOOL" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
fi
printf '__INVOKER_SSH_SYNC_ACK__=%s\\n' ${highWaterSeq}
`;
}

export function buildRemoteProgressJournalRunnerLibrary(): string {
  return `${buildPortableBase64DecodeFunction()}
invoker_base64_encode() {
  if base64 --help 2>&1 | grep -q -- '-w '; then
    base64 -w 0
  else
    base64 | tr -d '\\n'
  fi
}

invoker_json_escape() {
  local s="\${1-}"
  s="\${s//\\\\/\\\\\\\\}"
  s="\${s//\\"/\\\\\\"}"
  s="\${s//$'\\n'/\\\\n}"
  s="\${s//$'\\r'/\\\\r}"
  s="\${s//$'\\t'/\\\\t}"
  printf '%s' "$s"
}

invoker_json_string() {
  printf '"%s"' "$(invoker_json_escape "\${1-}")"
}

invoker_progress_sync_file() {
  local file="$1"
  if command -v sync >/dev/null 2>&1; then
    sync -f "$file" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
  fi
}

invoker_progress_lock_dir() {
  local lock="$1"
  local waits=0
  while ! mkdir "$lock" 2>/dev/null; do
    sleep 0.05
    waits=$((waits + 1))
    if [ "$waits" -gt 1200 ]; then
      return 1
    fi
  done
}

invoker_progress_next_seq() {
  local seq_file="\${INVOKER_PROGRESS_SEQ_FILE:?}"
  local lock="$seq_file.lock"
  local tmp="$seq_file.tmp.$$"
  local seq=0
  mkdir -p "$(dirname "$seq_file")"
  invoker_progress_lock_dir "$lock" || return 1
  if [ -f "$seq_file" ]; then
    IFS= read -r seq < "$seq_file" || seq=0
  fi
  case "$seq" in
    ''|*[!0-9]*) seq=0 ;;
  esac
  seq=$((seq + 1))
  printf '%s\\n' "$seq" > "$tmp"
  mv "$tmp" "$seq_file"
  rmdir "$lock" >/dev/null 2>&1 || true
  printf '%s\\n' "$seq"
}

invoker_progress_reserve_output_offset() {
  local bytes="$1"
  local offset_file="\${INVOKER_PROGRESS_OUTPUT_OFFSET_FILE:?}"
  local lock="$offset_file.lock"
  local tmp="$offset_file.tmp.$$"
  local offset=0
  mkdir -p "$(dirname "$offset_file")"
  invoker_progress_lock_dir "$lock" || return 1
  if [ -f "$offset_file" ]; then
    IFS= read -r offset < "$offset_file" || offset=0
  fi
  case "$offset" in
    ''|*[!0-9]*) offset=0 ;;
  esac
  printf '%s\\n' "$((offset + bytes))" > "$tmp"
  mv "$tmp" "$offset_file"
  rmdir "$lock" >/dev/null 2>&1 || true
  printf '%s\\n' "$offset"
}

invoker_progress_append() {
  local kind="$1"
  local payload="$2"
  local seq ts line workflow
  seq="$(invoker_progress_next_seq)" || return 0
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%SZ')"
  workflow="\${INVOKER_REMOTE_WORKFLOW_ID:-}"
  mkdir -p "$(dirname "\${INVOKER_PROGRESS_JOURNAL_FILE:?}")"
  line="$(printf '{"schemaVersion":1,"seq":%s,"kind":%s,"executionId":%s,"taskId":%s,"attemptId":%s%s,"createdAt":%s,"payload":%s}' \\
    "$seq" \\
    "$(invoker_json_string "$kind")" \\
    "$(invoker_json_string "\${INVOKER_REMOTE_EXECUTION_ID:-}")" \\
    "$(invoker_json_string "\${INVOKER_REMOTE_TASK_ID:-}")" \\
    "$(invoker_json_string "\${INVOKER_REMOTE_ATTEMPT_ID:-}")" \\
    "$([ -n "$workflow" ] && printf ',"workflowId":%s' "$(invoker_json_string "$workflow")")" \\
    "$(invoker_json_string "$ts")" \\
    "$payload")"
  printf '%s\\n' "$line" >> "$INVOKER_PROGRESS_JOURNAL_FILE" || return 0
  invoker_progress_sync_file "$INVOKER_PROGRESS_JOURNAL_FILE"
}

invoker_progress_attempt_payload() {
  local status="$1"
  local ts="$2"
  local extra="$3"
  local opt=""
  if [ -n "\${INVOKER_REMOTE_WORKSPACE_PATH:-}" ]; then
    opt="$opt,\\"workspace_path\\":$(invoker_json_string "$INVOKER_REMOTE_WORKSPACE_PATH")"
  fi
  if [ -n "\${INVOKER_REMOTE_BRANCH:-}" ]; then
    opt="$opt,\\"branch\\":$(invoker_json_string "$INVOKER_REMOTE_BRANCH")"
  fi
  printf '{\\"id\\":%s,\\"node_id\\":%s,\\"queue_priority\\":0,\\"status\\":%s,\\"upstream_attempt_ids\\":[],\\"created_at\\":%s%s%s}' \\
    "$(invoker_json_string "\${INVOKER_REMOTE_ATTEMPT_ID:-}")" \\
    "$(invoker_json_string "\${INVOKER_REMOTE_TASK_ID:-}")" \\
    "$(invoker_json_string "$status")" \\
    "$(invoker_json_string "$ts")" \\
    "$opt" \\
    "$extra"
}

invoker_progress_append_attempt_started() {
  local ts payload
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%SZ')"
  payload="$(invoker_progress_attempt_payload "running" "$ts" ",\\"started_at\\":$(invoker_json_string "$ts"),\\"last_heartbeat_at\\":$(invoker_json_string "$ts")")"
  invoker_progress_append "attempt_started" "$payload" || true
}

invoker_progress_append_heartbeat() {
  local ts payload
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%SZ')"
  payload="$(invoker_progress_attempt_payload "running" "$ts" ",\\"last_heartbeat_at\\":$(invoker_json_string "$ts")")"
  invoker_progress_append "heartbeat" "$payload" || true
}

invoker_progress_append_attempt_finished() {
  local exit_code="$1"
  local reason="\${2-}"
  local status="failed"
  local ts extra payload
  if [ "$exit_code" -eq 0 ]; then
    status="completed"
  fi
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%SZ')"
  extra=",\\"completed_at\\":$(invoker_json_string "$ts"),\\"exit_code\\":$exit_code"
  if [ -n "$reason" ]; then
    extra="$extra,\\"error\\":$(invoker_json_string "$reason")"
  fi
  payload="$(invoker_progress_attempt_payload "$status" "$ts" "$extra")"
  invoker_progress_append "attempt_finished" "$payload" || true
}

invoker_progress_append_output() {
  local stream="$1"
  local data="$2"
  local bytes offset data_b64 payload
  bytes="$(printf '%s' "$data" | wc -c | tr -d ' ')"
  offset="$(invoker_progress_reserve_output_offset "$bytes")" || return 0
  data_b64="$(printf '%s' "$data" | invoker_base64_encode)"
  payload="$(printf '{\\"stream\\":%s,\\"offset\\":%s,\\"bytes\\":%s,\\"dataB64\\":%s}' \\
    "$(invoker_json_string "$stream")" "$offset" "$bytes" "$(invoker_json_string "$data_b64")")"
  invoker_progress_append "output_chunk" "$payload" || true
}

invoker_progress_capture_stream() {
  local stream="$1"
  local line data
  while IFS= read -r line || [ -n "$line" ]; do
    data="$line"$'\\n'
    printf '%s' "$data"
    invoker_progress_append_output "$stream" "$data" || true
  done
}

invoker_progress_spool_has_task_cancel() {
  local spool="\${INVOKER_SYNC_SPOOL_FILE:-}"
  local task="\${INVOKER_REMOTE_TASK_ID:-}"
  [ -n "$spool" ] && [ -f "$spool" ] && [ -n "$task" ] || return 1
  grep -F '"entityType":"task"' "$spool" \\
    | grep -F "\\"entityId\\":\\"$task\\"" \\
    | grep -E '"status":"(closed|stale)"' >/dev/null 2>&1
}

invoker_progress_spool_workflow_id() {
  local spool="\${INVOKER_SYNC_SPOOL_FILE:-}"
  local task="\${INVOKER_REMOTE_TASK_ID:-}"
  local wf="\${INVOKER_REMOTE_WORKFLOW_ID:-}"
  if [ -n "$wf" ]; then
    printf '%s\\n' "$wf"
    return 0
  fi
  [ -n "$spool" ] && [ -f "$spool" ] && [ -n "$task" ] || return 1
  grep -F '"entityType":"task"' "$spool" \\
    | grep -F "\\"entityId\\":\\"$task\\"" \\
    | sed -n 's/.*"workflow_id":"\\([^"]*\\)".*/\\1/p' \\
    | tail -n 1
}

invoker_progress_spool_has_workflow_tombstone() {
  local spool="\${INVOKER_SYNC_SPOOL_FILE:-}"
  local wf
  [ -n "$spool" ] && [ -f "$spool" ] || return 1
  wf="$(invoker_progress_spool_workflow_id || true)"
  [ -n "$wf" ] || return 1
  grep -F '"entityType":"workflow"' "$spool" \\
    | grep -F '"op":"tombstone"' \\
    | grep -F "\\"entityId\\":\\"$wf\\"" >/dev/null 2>&1
}

invoker_progress_maybe_terminate_for_spool() {
  local pid="$1"
  if invoker_progress_spool_has_workflow_tombstone || invoker_progress_spool_has_task_cancel; then
    printf '%s\\n' 'terminated by home tombstone/cancel delta' > "\${INVOKER_PROGRESS_TERMINATION_FILE:?}" 2>/dev/null || true
    kill "$pid" >/dev/null 2>&1 || true
    return 0
  fi
  return 1
}
`;
}
