import { DELTA_BATCH_SCHEMA_VERSION, type DeltaBatch } from '@invoker/data-store';
import type { SyncEntityType, SyncJournalEntry, SyncJournalOp } from '@invoker/data-store';
import { buildPortableBase64DecodeFunction } from './remote-shell-fragments.js';
import { base64Encode, shellPosixSingleQuote } from './ssh-git-exec.js';

export const REMOTE_SYNC_DIR_RELATIVE = 'runtime/ssh-executor';
export const REMOTE_PROGRESS_JOURNAL_FILENAME = 'progress-journal.jsonl';
export const REMOTE_DELTA_SPOOL_FILENAME = 'delta-spool.jsonl';
export const REMOTE_PROGRESS_HIGH_WATER_MARKER = '__INVOKER_REMOTE_PROGRESS_HIGH_WATER__=';
export const REMOTE_DELTA_SPOOL_ACK_MARKER = '__INVOKER_REMOTE_DELTA_SPOOL_ACK__=';
export const REMOTE_PROGRESS_ORIGIN = 'ssh-remote';

export type RemoteProgressJournalKind =
  | 'attempt_started'
  | 'heartbeat'
  | 'output_chunk'
  | 'attempt_finished';

export interface RemoteProgressJournalEntry extends SyncJournalEntry {
  kind?: RemoteProgressJournalKind;
}

const SYNC_ENTITY_TYPES = new Set<SyncEntityType>([
  'workflow',
  'task',
  'attempt',
  'event',
  'output',
]);

const SYNC_OPS = new Set<SyncJournalOp>(['upsert', 'tombstone']);

function asNonNegativeInteger(name: string, value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return number;
}

function decodePayload(value: Record<string, unknown>): unknown {
  if ('payload' in value) return value.payload;
  const encoded = value.payload_b64 ?? value.payloadB64;
  if (typeof encoded !== 'string') return null;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

export function normalizeRemoteProgressJournalEntry(value: unknown): RemoteProgressJournalEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Remote progress journal line must be a JSON object');
  }
  const raw = value as Record<string, unknown>;
  const entityType = raw.entityType ?? raw.entity_type;
  const entityId = raw.entityId ?? raw.entity_id;
  const op = raw.op;

  if (typeof entityType !== 'string' || !SYNC_ENTITY_TYPES.has(entityType as SyncEntityType)) {
    throw new Error(`Unsupported remote progress entity type ${String(entityType)}`);
  }
  if (typeof entityId !== 'string' || entityId.length === 0) {
    throw new Error('Remote progress entityId is required');
  }
  if (typeof op !== 'string' || !SYNC_OPS.has(op as SyncJournalOp)) {
    throw new Error(`Unsupported remote progress op ${String(op)}`);
  }

  const entry: RemoteProgressJournalEntry = {
    seq: asNonNegativeInteger('remote progress seq', raw.seq),
    entityType: entityType as SyncEntityType,
    entityId,
    op: op as SyncJournalOp,
    payload: decodePayload(raw),
    origin: typeof raw.origin === 'string' && raw.origin ? raw.origin : REMOTE_PROGRESS_ORIGIN,
    createdAt: typeof (raw.createdAt ?? raw.created_at) === 'string'
      ? String(raw.createdAt ?? raw.created_at)
      : new Date(0).toISOString(),
  };
  if (typeof raw.kind === 'string') {
    entry.kind = raw.kind as RemoteProgressJournalKind;
  }
  return entry;
}

export function parseRemoteProgressJournalOutput(stdout: string, sinceSeq: number): DeltaBatch {
  const cursor = asNonNegativeInteger('sinceSeq', Math.trunc(sinceSeq));
  const lines = stdout.split('\n');
  let highWaterSeq = cursor;
  const entries: SyncJournalEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(REMOTE_PROGRESS_HIGH_WATER_MARKER)) {
      highWaterSeq = Math.max(
        highWaterSeq,
        asNonNegativeInteger(
          'remote progress highWaterSeq',
          trimmed.slice(REMOTE_PROGRESS_HIGH_WATER_MARKER.length),
        ),
      );
      continue;
    }
    const parsed = normalizeRemoteProgressJournalEntry(JSON.parse(trimmed));
    if (parsed.seq <= cursor) continue;
    entries.push(parsed);
    highWaterSeq = Math.max(highWaterSeq, parsed.seq);
  }

  entries.sort((a, b) => a.seq - b.seq);
  const maxEntrySeq = entries.length > 0 ? entries[entries.length - 1]!.seq : cursor;
  return {
    schemaVersion: DELTA_BATCH_SCHEMA_VERSION,
    sinceSeq: cursor,
    highWaterSeq: Math.max(highWaterSeq, maxEntrySeq),
    entries,
  };
}

export function buildRemoteSyncDirScript(remoteInvokerHome = '~/.invoker'): string {
  const homeB64 = base64Encode(remoteInvokerHome);
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(homeB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
INVOKER_REMOTE_SYNC_DIR="$INVOKER_HOME/${REMOTE_SYNC_DIR_RELATIVE}"
INVOKER_REMOTE_PROGRESS_JOURNAL="$INVOKER_REMOTE_SYNC_DIR/${REMOTE_PROGRESS_JOURNAL_FILENAME}"
INVOKER_REMOTE_DELTA_SPOOL="$INVOKER_REMOTE_SYNC_DIR/${REMOTE_DELTA_SPOOL_FILENAME}"
mkdir -p "$INVOKER_REMOTE_SYNC_DIR"
`;
}

export function buildReadRemoteProgressJournalScript(options: {
  remoteInvokerHome?: string;
  sinceSeq: number;
  limit?: number;
}): string {
  const sinceSeq = asNonNegativeInteger('sinceSeq', Math.trunc(options.sinceSeq));
  const limit = asNonNegativeInteger('limit', Math.trunc(options.limit ?? 1000));

  return `${buildRemoteSyncDirScript(options.remoteInvokerHome)}
SINCE_SEQ=${sinceSeq}
LIMIT=${limit}
if [ ! -f "$INVOKER_REMOTE_PROGRESS_JOURNAL" ] || [ "$LIMIT" -eq 0 ]; then
  printf '${REMOTE_PROGRESS_HIGH_WATER_MARKER}%s\\n' "$SINCE_SEQ"
  exit 0
fi
awk -v since="$SINCE_SEQ" -v limit="$LIMIT" -v marker="${REMOTE_PROGRESS_HIGH_WATER_MARKER}" '
  function extract_seq(line, m) {
    if (match(line, /"seq"[[:space:]]*:[[:space:]]*[0-9]+/)) {
      m = substr(line, RSTART, RLENGTH)
      sub(/.*:/, "", m)
      gsub(/[[:space:]]/, "", m)
      return m + 0
    }
    return -1
  }
  {
    seq = extract_seq($0)
    if (seq < 0) next
    if (seq > max_seq) max_seq = seq
    if (seq > since && count < limit) {
      print $0
      printed_high = seq
      count += 1
    }
  }
  END {
    if (printed_high > 0) {
      print marker printed_high
    } else if (max_seq > since) {
      print marker max_seq
    } else {
      print marker since
    }
  }
' "$INVOKER_REMOTE_PROGRESS_JOURNAL"
`;
}

export function buildWriteRemoteDeltaSpoolScript(options: {
  remoteInvokerHome?: string;
  batch: DeltaBatch;
}): string {
  const batchJson = JSON.stringify(options.batch);
  const batchB64 = base64Encode(batchJson);
  const highWaterSeq = asNonNegativeInteger('batch.highWaterSeq', options.batch.highWaterSeq);

  return `${buildRemoteSyncDirScript(options.remoteInvokerHome)}
BATCH_B64=${shellPosixSingleQuote(batchB64)}
TMP="$INVOKER_REMOTE_DELTA_SPOOL.tmp.$$"
cleanup_spool_tmp() {
  rm -f "$TMP" >/dev/null 2>&1 || true
}
trap cleanup_spool_tmp EXIT
printf '%s' "$BATCH_B64" | invoker_base64_decode > "$TMP"
printf '\\n' >> "$TMP"
cat "$TMP" >> "$INVOKER_REMOTE_DELTA_SPOOL"
if command -v python3 >/dev/null 2>&1; then
  python3 - "$INVOKER_REMOTE_DELTA_SPOOL" <<'PY'
import os
import sys
with open(sys.argv[1], "rb") as handle:
    os.fsync(handle.fileno())
PY
else
  sync "$INVOKER_REMOTE_DELTA_SPOOL" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
fi
printf '${REMOTE_DELTA_SPOOL_ACK_MARKER}%s\\n' ${highWaterSeq}
`;
}

export function parseRemoteDeltaSpoolAck(stdout: string): number {
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .reverse()
    .find((entry) => entry.startsWith(REMOTE_DELTA_SPOOL_ACK_MARKER));
  if (!line) {
    throw new Error('Remote delta spool write did not return an acknowledgement');
  }
  return asNonNegativeInteger(
    'remote delta spool ack',
    line.slice(REMOTE_DELTA_SPOOL_ACK_MARKER.length),
  );
}

export function buildRemoteProgressJournalRunnerFragment(): string {
  return `
invoker_json_escape() {
  local s="\${1-}"
  s="\${s//\\\\/\\\\\\\\}"
  s="\${s//\\"/\\\\\\"}"
  s="\${s//$'\\n'/\\\\n}"
  s="\${s//$'\\r'/\\\\r}"
  s="\${s//$'\\t'/\\\\t}"
  printf '%s' "$s"
}

invoker_utc_now() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

invoker_sync_file() {
  local path="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$path" <<'PY' >/dev/null 2>&1 || true
import os
import sys
with open(sys.argv[1], "rb") as handle:
    os.fsync(handle.fileno())
PY
  else
    sync "$path" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
  fi
}

invoker_with_lock() {
  local lock_dir="$1"
  shift
  local waited=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    sleep 0.05
    waited=$((waited + 1))
    if [ "$waited" -gt 200 ]; then
      return 1
    fi
  done
  "$@"
  local status=$?
  rmdir "$lock_dir" >/dev/null 2>&1 || true
  return "$status"
}

invoker_remote_journal_append_unlocked() {
  local kind="$1"
  local entity_type="$2"
  local entity_id="$3"
  local op="$4"
  local payload="$5"
  local created_at="$6"
  mkdir -p "$INVOKER_REMOTE_SYNC_DIR"
  local last_seq=0
  if [ -f "$INVOKER_REMOTE_PROGRESS_JOURNAL" ]; then
    local last_line
    last_line=$(tail -n 1 "$INVOKER_REMOTE_PROGRESS_JOURNAL" 2>/dev/null || true)
    if [[ "$last_line" =~ \\"seq\\"[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
      last_seq="\${BASH_REMATCH[1]}"
    fi
  fi
  local seq=$((last_seq + 1))
  local entity_id_json created_at_json
  entity_id_json=$(invoker_json_escape "$entity_id")
  created_at_json=$(invoker_json_escape "$created_at")
  printf '{"seq":%s,"kind":"%s","entityType":"%s","entityId":"%s","op":"%s","payload":%s,"origin":"${REMOTE_PROGRESS_ORIGIN}","createdAt":"%s"}\\n' \\
    "$seq" "$kind" "$entity_type" "$entity_id_json" "$op" "$payload" "$created_at_json" \\
    >> "$INVOKER_REMOTE_PROGRESS_JOURNAL"
  invoker_sync_file "$INVOKER_REMOTE_PROGRESS_JOURNAL"
}

invoker_remote_journal_append() {
  invoker_with_lock "$INVOKER_REMOTE_PROGRESS_JOURNAL.lock" invoker_remote_journal_append_unlocked "$@" || true
}

invoker_remote_attempt_payload() {
  local status="$1"
  local timestamp="$2"
  local exit_code="\${3-}"
  local attempt_id_json task_id_json branch_json workspace_json agent_session_json
  attempt_id_json=$(invoker_json_escape "$INVOKER_SYNC_ATTEMPT_ID")
  task_id_json=$(invoker_json_escape "$INVOKER_SYNC_TASK_ID")
  branch_json=$(invoker_json_escape "\${INVOKER_SYNC_BRANCH:-}")
  workspace_json=$(invoker_json_escape "\${INVOKER_SYNC_WORKSPACE_PATH:-}")
  agent_session_json=$(invoker_json_escape "\${INVOKER_SYNC_AGENT_SESSION_ID:-}")
  printf '{"id":"%s","node_id":"%s","status":"%s","last_heartbeat_at":"%s"' \\
    "$attempt_id_json" "$task_id_json" "$status" "$timestamp"
  if [ "$status" = "running" ]; then
    printf ',"started_at":"%s"' "$timestamp"
  else
    printf ',"completed_at":"%s"' "$timestamp"
  fi
  if [ -n "$exit_code" ]; then
    printf ',"exit_code":%s' "$exit_code"
  fi
  if [ -n "\${INVOKER_SYNC_BRANCH:-}" ]; then
    printf ',"branch":"%s"' "$branch_json"
  fi
  if [ -n "\${INVOKER_SYNC_WORKSPACE_PATH:-}" ]; then
    printf ',"workspace_path":"%s"' "$workspace_json"
  fi
  if [ -n "\${INVOKER_SYNC_AGENT_SESSION_ID:-}" ]; then
    printf ',"agent_session_id":"%s"' "$agent_session_json"
  fi
  printf '}'
}

invoker_remote_journal_attempt_started() {
  local now
  now=$(invoker_utc_now)
  local payload
  payload=$(invoker_remote_attempt_payload running "$now")
  invoker_remote_journal_append attempt_started attempt "$INVOKER_SYNC_ATTEMPT_ID" upsert "$payload" "$now"
}

invoker_remote_journal_heartbeat() {
  local now
  now=$(invoker_utc_now)
  local payload
  payload=$(invoker_remote_attempt_payload running "$now")
  invoker_remote_journal_append heartbeat attempt "$INVOKER_SYNC_ATTEMPT_ID" upsert "$payload" "$now"
}

invoker_remote_next_output_offset_unlocked() {
  local bytes="$1"
  mkdir -p "$INVOKER_REMOTE_SYNC_DIR"
  local offset=0
  if [ -f "$INVOKER_REMOTE_OUTPUT_OFFSET_FILE" ]; then
    offset=$(cat "$INVOKER_REMOTE_OUTPUT_OFFSET_FILE" 2>/dev/null || printf '0')
  fi
  case "$offset" in
    ''|*[!0-9]*) offset=0 ;;
  esac
  printf '%s' $((offset + bytes)) > "$INVOKER_REMOTE_OUTPUT_OFFSET_FILE"
  printf '%s' "$offset"
}

invoker_remote_next_output_offset() {
  invoker_with_lock "$INVOKER_REMOTE_OUTPUT_OFFSET_FILE.lock" invoker_remote_next_output_offset_unlocked "$1"
}

invoker_remote_journal_output() {
  local stream="$1"
  local data="$2"
  local now bytes offset task_id_json stream_json data_json
  now=$(invoker_utc_now)
  bytes=$(printf '%s' "$data" | wc -c | tr -d '[:space:]')
  offset=$(invoker_remote_next_output_offset "$bytes" 2>/dev/null || printf '0')
  task_id_json=$(invoker_json_escape "$INVOKER_SYNC_TASK_ID")
  stream_json=$(invoker_json_escape "$stream")
  data_json=$(invoker_json_escape "$data")
  local payload
  payload=$(printf '{"task_id":"%s","offset":%s,"data":"%s","created_at":"%s","stream":"%s","attempt_id":"%s"}' \\
    "$task_id_json" "$offset" "$data_json" "$now" "$stream_json" "$(invoker_json_escape "$INVOKER_SYNC_ATTEMPT_ID")")
  invoker_remote_journal_append output_chunk output "$INVOKER_SYNC_ATTEMPT_ID:$offset" upsert "$payload" "$now"
}

invoker_remote_journal_attempt_finished() {
  local status="$1"
  local exit_code="$2"
  local now
  now=$(invoker_utc_now)
  local payload
  payload=$(invoker_remote_attempt_payload "$status" "$now" "$exit_code")
  invoker_remote_journal_append attempt_finished attempt "$INVOKER_SYNC_ATTEMPT_ID" upsert "$payload" "$now"
}

invoker_remote_should_stop_for_tombstone() {
  if [ -z "\${INVOKER_SYNC_WORKFLOW_ID:-}" ] || [ ! -f "$INVOKER_REMOTE_DELTA_SPOOL" ]; then
    return 1
  fi
  local workflow_json
  workflow_json=$(invoker_json_escape "$INVOKER_SYNC_WORKFLOW_ID")
  grep -F '"op":"tombstone"' "$INVOKER_REMOTE_DELTA_SPOOL" 2>/dev/null \\
    | grep -F '"entityType":"workflow"' \\
    | grep -F "\\"entityId\\":\\"$workflow_json\\"" >/dev/null 2>&1
}
`;
}
