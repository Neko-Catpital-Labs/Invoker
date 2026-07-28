import {
  DELTA_BATCH_SCHEMA_VERSION,
  type DeltaBatch,
  type SyncJournalEntry,
} from '@invoker/data-store';
import { base64Encode, shellPosixSingleQuote } from './ssh-git-exec.js';
import { buildPortableBase64DecodeFunction } from './remote-shell-fragments.js';

export const REMOTE_HEARTBEAT_MARKER = '__INVOKER_REMOTE_HEARTBEAT__';
export const REMOTE_PROGRESS_SCHEMA_VERSION = 1;
export const REMOTE_PROGRESS_RUNTIME_DIR_NAME = 'ssh-executor-progress';
export const REMOTE_PROGRESS_JOURNAL_FILENAME = 'progress.ndjson';
export const REMOTE_PROGRESS_SPOOL_FILENAME = 'home-spool.ndjson';

export type RemoteProgressJournalKind =
  | 'attempt_started'
  | 'heartbeat'
  | 'output_chunk'
  | 'attempt_finished';

export interface RemoteProgressJournalEntry {
  schemaVersion: typeof REMOTE_PROGRESS_SCHEMA_VERSION;
  seq: number;
  kind: RemoteProgressJournalKind;
  entityType: SyncJournalEntry['entityType'];
  entityId: string;
  op: SyncJournalEntry['op'];
  payload: unknown;
  origin?: string;
  createdAt: string;
}

function asNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function inferWorkflowIdFromTaskId(taskId: string): string | undefined {
  const idx = taskId.indexOf('/');
  if (idx <= 0) return undefined;
  return taskId.slice(0, idx);
}

export function parseRemoteProgressJournal(text: string): RemoteProgressJournalEntry[] {
  const entries: RemoteProgressJournalEntry[] = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `Invalid remote progress journal JSON on line ${index + 1}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid remote progress journal entry on line ${index + 1}`);
    }
    const row = parsed as Record<string, unknown>;
    if (row.schemaVersion !== REMOTE_PROGRESS_SCHEMA_VERSION) {
      throw new Error(`Unsupported remote progress journal schema ${String(row.schemaVersion)}`);
    }
    const seq = Number(row.seq);
    asNonNegativeInteger('remote progress seq', seq);
    const entityType = row.entityType;
    const entityId = row.entityId;
    const op = row.op;
    const kind = row.kind;
    const createdAt = row.createdAt;
    if (typeof entityType !== 'string' || typeof entityId !== 'string' || typeof op !== 'string') {
      throw new Error(`Remote progress journal entry ${seq} is missing sync entity fields`);
    }
    if (typeof kind !== 'string' || typeof createdAt !== 'string') {
      throw new Error(`Remote progress journal entry ${seq} is missing progress metadata`);
    }
    entries.push({
      schemaVersion: REMOTE_PROGRESS_SCHEMA_VERSION,
      seq,
      kind: kind as RemoteProgressJournalKind,
      entityType: entityType as SyncJournalEntry['entityType'],
      entityId,
      op: op as SyncJournalEntry['op'],
      payload: row.payload,
      origin: typeof row.origin === 'string' ? row.origin : undefined,
      createdAt,
    });
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

export function remoteProgressEntriesToDeltaBatch(
  entries: RemoteProgressJournalEntry[],
  sinceSeq: number,
): DeltaBatch {
  const cursor = asNonNegativeInteger('sinceSeq', Math.trunc(sinceSeq));
  const filtered = entries
    .filter((entry) => entry.seq > cursor)
    .sort((a, b) => a.seq - b.seq);
  const highWaterSeq = Math.max(cursor, ...filtered.map((entry) => entry.seq));
  return {
    schemaVersion: DELTA_BATCH_SCHEMA_VERSION,
    sinceSeq: cursor,
    highWaterSeq,
    entries: filtered.map((entry) => ({
      seq: entry.seq,
      entityType: entry.entityType,
      entityId: entry.entityId,
      op: entry.op,
      payload: entry.payload,
      origin: entry.origin ?? 'remote',
      createdAt: entry.createdAt,
    })),
  };
}

export function buildRemoteProgressJournalLibraryScript(): string {
  return `# Invoker remote progress journal helpers.
invoker_remote_progress_json_escape() {
  local value="\${1-}"
  value="\${value//\\\\/\\\\\\\\}"
  value="\${value//\\"/\\\\\\"}"
  value="\${value//$'\\n'/\\\\n}"
  value="\${value//$'\\r'/\\\\r}"
  value="\${value//$'\\t'/\\\\t}"
  printf '%s' "$value"
}

invoker_remote_progress_json_string_or_null() {
  local value="\${1-}"
  if [ -n "$value" ]; then
    printf '"%s"' "$(invoker_remote_progress_json_escape "$value")"
  else
    printf 'null'
  fi
}

invoker_remote_progress_now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%S.000Z"
}

invoker_remote_progress_ensure_paths() {
  mkdir -p "$INVOKER_REMOTE_PROGRESS_DIR"
  touch "$INVOKER_REMOTE_PROGRESS_JOURNAL" "$INVOKER_REMOTE_PROGRESS_SPOOL"
  chmod 700 "$INVOKER_REMOTE_PROGRESS_DIR" >/dev/null 2>&1 || true
  chmod 600 "$INVOKER_REMOTE_PROGRESS_JOURNAL" "$INVOKER_REMOTE_PROGRESS_SPOOL" >/dev/null 2>&1 || true
}

invoker_remote_progress_next_seq() {
  invoker_remote_progress_ensure_paths
  local lock="$INVOKER_REMOTE_PROGRESS_SEQ_PATH.lock"
  local waited=0
  while ! mkdir "$lock" 2>/dev/null; do
    sleep 0.05
    waited=$((waited + 1))
    if [ "$waited" -gt 200 ]; then
      rm -rf "$lock" >/dev/null 2>&1 || true
      waited=0
    fi
  done
  local last=0
  if [ -s "$INVOKER_REMOTE_PROGRESS_SEQ_PATH" ]; then
    read -r last < "$INVOKER_REMOTE_PROGRESS_SEQ_PATH" || last=0
  fi
  case "$last" in
    ''|*[!0-9]*) last=0 ;;
  esac
  local next=$((last + 1))
  printf '%s\\n' "$next" > "$INVOKER_REMOTE_PROGRESS_SEQ_PATH.tmp.$$"
  mv "$INVOKER_REMOTE_PROGRESS_SEQ_PATH.tmp.$$" "$INVOKER_REMOTE_PROGRESS_SEQ_PATH"
  rmdir "$lock" >/dev/null 2>&1 || true
  printf '%s\\n' "$next"
}

invoker_remote_progress_attempt_payload() {
  local status="$1"
  local timestamp="$2"
  local exit_code="\${3-}"
  local attempt_id="\${INVOKER_REMOTE_ATTEMPT_ID:-$INVOKER_REMOTE_EXECUTION_ID}"
  local task_id="\${INVOKER_REMOTE_TASK_ID:-$attempt_id}"
  local branch_json workspace_json agent_session_json completed_json exit_code_json
  branch_json=$(invoker_remote_progress_json_string_or_null "\${INVOKER_REMOTE_BRANCH:-}")
  workspace_json=$(invoker_remote_progress_json_string_or_null "\${INVOKER_REMOTE_WORKSPACE_PATH:-}")
  agent_session_json=$(invoker_remote_progress_json_string_or_null "\${INVOKER_REMOTE_AGENT_SESSION_ID:-}")
  if [ -n "$exit_code" ]; then
    completed_json="$(invoker_remote_progress_json_string_or_null "$timestamp")"
    exit_code_json="$exit_code"
  else
    completed_json='null'
    exit_code_json='null'
  fi
  printf '{"id":"%s","node_id":"%s","attempt_number":0,"queue_priority":0,"status":"%s","upstream_attempt_ids":"[]","created_at":"%s","started_at":"%s","completed_at":%s,"exit_code":%s,"last_heartbeat_at":"%s","branch":%s,"workspace_path":%s,"agent_session_id":%s}' \\
    "$(invoker_remote_progress_json_escape "$attempt_id")" \\
    "$(invoker_remote_progress_json_escape "$task_id")" \\
    "$(invoker_remote_progress_json_escape "$status")" \\
    "$(invoker_remote_progress_json_escape "\${INVOKER_REMOTE_ATTEMPT_CREATED_AT:-$timestamp}")" \\
    "$(invoker_remote_progress_json_escape "\${INVOKER_REMOTE_ATTEMPT_STARTED_AT:-$timestamp}")" \\
    "$completed_json" \\
    "$exit_code_json" \\
    "$(invoker_remote_progress_json_escape "$timestamp")" \\
    "$branch_json" \\
    "$workspace_json" \\
    "$agent_session_json"
}

invoker_remote_progress_append_attempt() {
  local kind="$1"
  local status="$2"
  local exit_code="\${3-}"
  local created_at seq payload attempt_id line
  created_at=$(invoker_remote_progress_now_iso)
  seq=$(invoker_remote_progress_next_seq)
  attempt_id="\${INVOKER_REMOTE_ATTEMPT_ID:-$INVOKER_REMOTE_EXECUTION_ID}"
  payload=$(invoker_remote_progress_attempt_payload "$status" "$created_at" "$exit_code")
  line=$(printf '{"schemaVersion":1,"seq":%s,"kind":"%s","entityType":"attempt","entityId":"%s","op":"upsert","payload":%s,"origin":"remote","createdAt":"%s"}' \\
    "$seq" \\
    "$(invoker_remote_progress_json_escape "$kind")" \\
    "$(invoker_remote_progress_json_escape "$attempt_id")" \\
    "$payload" \\
    "$(invoker_remote_progress_json_escape "$created_at")")
  printf '%s\\n' "$line" >> "$INVOKER_REMOTE_PROGRESS_JOURNAL"
}

invoker_remote_journal_attempt_started() {
  INVOKER_REMOTE_ATTEMPT_CREATED_AT="\${INVOKER_REMOTE_ATTEMPT_CREATED_AT:-$(invoker_remote_progress_now_iso)}"
  INVOKER_REMOTE_ATTEMPT_STARTED_AT="\${INVOKER_REMOTE_ATTEMPT_STARTED_AT:-$INVOKER_REMOTE_ATTEMPT_CREATED_AT}"
  export INVOKER_REMOTE_ATTEMPT_CREATED_AT INVOKER_REMOTE_ATTEMPT_STARTED_AT
  invoker_remote_progress_append_attempt "attempt_started" "running"
}

invoker_remote_journal_heartbeat() {
  invoker_remote_progress_append_attempt "heartbeat" "running"
}

invoker_remote_journal_attempt_finished() {
  local exit_code="\${1:-0}"
  local status="completed"
  if [ "$exit_code" != "0" ]; then
    status="failed"
  fi
  invoker_remote_progress_append_attempt "attempt_finished" "$status" "$exit_code"
}

invoker_remote_journal_output_chunk() {
  local stream="$1"
  local data="$2"
  local created_at seq task_id payload line
  created_at=$(invoker_remote_progress_now_iso)
  seq=$(invoker_remote_progress_next_seq)
  task_id="\${INVOKER_REMOTE_TASK_ID:-$INVOKER_REMOTE_EXECUTION_ID}"
  payload=$(printf '{"id":%s,"task_id":"%s","offset":%s,"data":"%s","created_at":"%s","stream":"%s"}' \\
    "$seq" \\
    "$(invoker_remote_progress_json_escape "$task_id")" \\
    "$seq" \\
    "$(invoker_remote_progress_json_escape "$data")" \\
    "$(invoker_remote_progress_json_escape "$created_at")" \\
    "$(invoker_remote_progress_json_escape "$stream")")
  line=$(printf '{"schemaVersion":1,"seq":%s,"kind":"output_chunk","entityType":"output","entityId":"%s","op":"upsert","payload":%s,"origin":"remote","createdAt":"%s"}' \\
    "$seq" \\
    "$seq" \\
    "$payload" \\
    "$(invoker_remote_progress_json_escape "$created_at")")
  printf '%s\\n' "$line" >> "$INVOKER_REMOTE_PROGRESS_JOURNAL"
}

invoker_remote_journal_output_stream() {
  local stream="\${1:-stdout}"
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\\n' "$line"
    invoker_remote_journal_output_chunk "$stream" "$line"$'\\n' || true
  done
}

invoker_remote_should_terminate_for_tombstone() {
  local workflow_id="\${INVOKER_REMOTE_WORKFLOW_ID:-}"
  if [ -z "$workflow_id" ] || [ ! -s "$INVOKER_REMOTE_PROGRESS_SPOOL" ]; then
    return 1
  fi
  local workflow_json
  workflow_json=$(invoker_remote_progress_json_escape "$workflow_id")
  grep -F '"op":"tombstone"' "$INVOKER_REMOTE_PROGRESS_SPOOL" 2>/dev/null \\
    | grep -F '"entityType":"workflow"' \\
    | grep -F "\\"entityId\\":\\"$workflow_json\\"" >/dev/null 2>&1
}
`;
}

export function buildReadRemoteProgressJournalScript(opts: {
  remoteInvokerHome?: string;
  sinceSeq: number;
  limit?: number;
}): string {
  const sinceSeq = asNonNegativeInteger('sinceSeq', Math.trunc(opts.sinceSeq));
  const limit = asNonNegativeInteger('limit', Math.trunc(opts.limit ?? 500));
  const homeB64 = base64Encode(opts.remoteInvokerHome ?? '~/.invoker');
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(homeB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
JOURNAL="$INVOKER_HOME/runtime/${REMOTE_PROGRESS_RUNTIME_DIR_NAME}/${REMOTE_PROGRESS_JOURNAL_FILENAME}"
SINCE=${sinceSeq}
LIMIT=${limit}
if [ ! -f "$JOURNAL" ] || [ "$LIMIT" -eq 0 ]; then
  exit 0
fi
count=0
while IFS= read -r line || [ -n "$line" ]; do
  seq=$(printf '%s\\n' "$line" | sed -n 's/.*"seq"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')
  case "$seq" in
    ''|*[!0-9]*) continue ;;
  esac
  if [ "$seq" -gt "$SINCE" ]; then
    printf '%s\\n' "$line"
    count=$((count + 1))
    if [ "$count" -ge "$LIMIT" ]; then
      break
    fi
  fi
done < "$JOURNAL"
`;
}

export function serializeDeltaEntriesForRemoteSpool(batch: DeltaBatch): string {
  return batch.entries.map((entry) => JSON.stringify(entry)).join('\n')
    + (batch.entries.length > 0 ? '\n' : '');
}

export function buildAppendRemoteSpoolScript(opts: {
  remoteInvokerHome?: string;
  batch: DeltaBatch;
}): string {
  const homeB64 = base64Encode(opts.remoteInvokerHome ?? '~/.invoker');
  const payloadB64 = base64Encode(serializeDeltaEntriesForRemoteSpool(opts.batch));
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(homeB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
BASE="$INVOKER_HOME/runtime/${REMOTE_PROGRESS_RUNTIME_DIR_NAME}"
SPOOL="$BASE/${REMOTE_PROGRESS_SPOOL_FILENAME}"
mkdir -p "$BASE"
touch "$SPOOL"
chmod 700 "$BASE" >/dev/null 2>&1 || true
chmod 600 "$SPOOL" >/dev/null 2>&1 || true
TMP="$SPOOL.tmp.$$"
printf '%s' ${shellPosixSingleQuote(payloadB64)} | invoker_base64_decode > "$TMP"
cat "$TMP" >> "$SPOOL"
rm -f "$TMP"
printf '__INVOKER_SPOOL_ACK__=%s\\n' ${opts.batch.highWaterSeq}
`;
}
