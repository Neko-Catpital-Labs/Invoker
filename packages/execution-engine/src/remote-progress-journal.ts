import { base64Encode, shellPosixSingleQuote } from './ssh-git-exec.js';
import { buildPortableBase64DecodeFunction } from './remote-shell-fragments.js';

export const REMOTE_SYNC_DIR_RELATIVE = 'runtime/ssh-executor/sync';
export const REMOTE_PROGRESS_JOURNAL_FILE = 'progress.ndjson';
export const REMOTE_PROGRESS_SEQUENCE_FILE = 'progress.seq';
export const REMOTE_HOME_DELTA_SPOOL_FILE = 'home-delta-spool.ndjson';

export interface RemoteProgressJournalScriptOptions {
  invokerHomeVariable?: string;
}

export interface RemoteJournalReadScriptOptions extends RemoteProgressJournalScriptOptions {
  sinceSeq: number;
}

export interface RemoteDeltaSpoolScriptOptions extends RemoteProgressJournalScriptOptions {
  entriesNdjson: string;
  highWaterSeq: number;
}

export function inferWorkflowIdFromTaskId(taskId: string): string | undefined {
  if (taskId.startsWith('__merge__')) {
    const workflowId = taskId.slice('__merge__'.length);
    return workflowId || undefined;
  }
  const slash = taskId.indexOf('/');
  if (slash <= 0) return undefined;
  return taskId.slice(0, slash);
}

function asNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function buildRemoteProgressJournalPathScript(
  options: RemoteProgressJournalScriptOptions = {},
): string {
  const homeVar = options.invokerHomeVariable ?? 'INVOKER_HOME';
  return `INVOKER_SSH_SYNC_DIR="$${homeVar}/${REMOTE_SYNC_DIR_RELATIVE}"
INVOKER_PROGRESS_JOURNAL="$INVOKER_SSH_SYNC_DIR/${REMOTE_PROGRESS_JOURNAL_FILE}"
INVOKER_PROGRESS_SEQUENCE_FILE="$INVOKER_SSH_SYNC_DIR/${REMOTE_PROGRESS_SEQUENCE_FILE}"
INVOKER_PROGRESS_LOCK="$INVOKER_SSH_SYNC_DIR/progress.lock"
INVOKER_HOME_DELTA_SPOOL="$INVOKER_SSH_SYNC_DIR/${REMOTE_HOME_DELTA_SPOOL_FILE}"
export INVOKER_SSH_SYNC_DIR INVOKER_PROGRESS_JOURNAL INVOKER_PROGRESS_SEQUENCE_FILE INVOKER_PROGRESS_LOCK INVOKER_HOME_DELTA_SPOOL
`;
}

export function buildRemoteProgressJournalBashFunctions(): string {
  return `invoker_progress_now() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

invoker_json_escape() {
  local value="\${1-}"
  value="\${value//\\\\/\\\\\\\\}"
  value="\${value//\\"/\\\\\\"}"
  value="\${value//$'\\n'/\\\\n}"
  value="\${value//$'\\r'/\\\\r}"
  value="\${value//$'\\t'/\\\\t}"
  printf '%s' "$value"
}

invoker_progress_init() {
  mkdir -p "$INVOKER_SSH_SYNC_DIR"
  chmod 700 "$INVOKER_SSH_SYNC_DIR" >/dev/null 2>&1 || true
  touch "$INVOKER_PROGRESS_JOURNAL" "$INVOKER_PROGRESS_SEQUENCE_FILE" "$INVOKER_HOME_DELTA_SPOOL"
}

invoker_progress_next_seq_locked() {
  local current_seq="0"
  if [ -s "$INVOKER_PROGRESS_SEQUENCE_FILE" ]; then
    IFS= read -r current_seq < "$INVOKER_PROGRESS_SEQUENCE_FILE" || current_seq="0"
  fi
  case "$current_seq" in
    ''|*[!0-9]*) current_seq="0" ;;
  esac
  local next_seq=$((current_seq + 1))
  printf '%s\\n' "$next_seq" > "$INVOKER_PROGRESS_SEQUENCE_FILE.tmp"
  mv "$INVOKER_PROGRESS_SEQUENCE_FILE.tmp" "$INVOKER_PROGRESS_SEQUENCE_FILE"
  printf '%s' "$next_seq"
}

invoker_progress_sync_file() {
  sync -d "$INVOKER_PROGRESS_JOURNAL" >/dev/null 2>&1 || sync "$INVOKER_PROGRESS_JOURNAL" >/dev/null 2>&1 || true
}

invoker_progress_append_body_locked() {
  local body="$1"
  local next_seq
  next_seq=$(invoker_progress_next_seq_locked)
  printf '{"seq":%s,%s}\\n' "$next_seq" "$body" >> "$INVOKER_PROGRESS_JOURNAL"
  invoker_progress_sync_file
}

invoker_progress_with_lock() {
  if command -v flock >/dev/null 2>&1; then
    (
      flock 9
      "$@"
    ) 9>"$INVOKER_PROGRESS_LOCK"
    return $?
  fi
  "$@"
}

invoker_progress_append_body() {
  invoker_progress_init
  invoker_progress_with_lock invoker_progress_append_body_locked "$1"
}

invoker_attempt_payload_json() {
  local attempt_state="$1"
  local at="$2"
  local exit_code="\${3-}"
  local error_text="\${4-}"
  local task_id_json
  local attempt_id_json
  local at_json
  local branch_json
  local workspace_json
  local error_json
  task_id_json=$(invoker_json_escape "$INVOKER_TASK_ID")
  attempt_id_json=$(invoker_json_escape "$INVOKER_ATTEMPT_ID")
  at_json=$(invoker_json_escape "$at")
  branch_json=$(invoker_json_escape "\${INVOKER_TASK_BRANCH:-}")
  workspace_json=$(invoker_json_escape "\${INVOKER_WORKSPACE_PATH:-}")
  error_json=$(invoker_json_escape "$error_text")
  local payload
  payload='"id":"'"$attempt_id_json"'","node_id":"'"$task_id_json"'","attempt_number":0,"queue_priority":0,"status":"'"$attempt_state"'","upstream_attempt_ids":[],"created_at":"'"$at_json"'","last_heartbeat_at":"'"$at_json"'"'
  if [ "$attempt_state" = "running" ]; then
    payload="$payload"',"started_at":"'"$at_json"'"'
  else
    payload="$payload"',"completed_at":"'"$at_json"'"'
  fi
  if [ -n "$exit_code" ]; then
    payload="$payload"',"exit_code":'"$exit_code"
  fi
  if [ -n "$error_text" ]; then
    payload="$payload"',"error":"'"$error_json"'"'
  fi
  if [ -n "\${INVOKER_TASK_BRANCH:-}" ]; then
    payload="$payload"',"branch":"'"$branch_json"'"'
  fi
  if [ -n "\${INVOKER_WORKSPACE_PATH:-}" ]; then
    payload="$payload"',"workspace_path":"'"$workspace_json"'"'
  fi
  printf '{%s}' "$payload"
}

invoker_journal_attempt_running() {
  local at
  at=$(invoker_progress_now)
  local attempt_id_json
  attempt_id_json=$(invoker_json_escape "$INVOKER_ATTEMPT_ID")
  local created_json
  created_json=$(invoker_json_escape "$at")
  local payload
  payload=$(invoker_attempt_payload_json "running" "$at")
  invoker_progress_append_body '"entityType":"attempt","entityId":"'"$attempt_id_json"'","op":"upsert","payload":'"$payload"',"origin":"remote","createdAt":"'"$created_json"'"'
}

invoker_journal_attempt_finished() {
  local exit_code="\${1:-0}"
  local attempt_state="\${2:-completed}"
  local error_text="\${3-}"
  local at
  at=$(invoker_progress_now)
  local attempt_id_json
  attempt_id_json=$(invoker_json_escape "$INVOKER_ATTEMPT_ID")
  local created_json
  created_json=$(invoker_json_escape "$at")
  local payload
  payload=$(invoker_attempt_payload_json "$attempt_state" "$at" "$exit_code" "$error_text")
  invoker_progress_append_body '"entityType":"attempt","entityId":"'"$attempt_id_json"'","op":"upsert","payload":'"$payload"',"origin":"remote","createdAt":"'"$created_json"'"'
}

invoker_output_offset_file() {
  local token
  token=$(printf '%s' "$INVOKER_TASK_ID" | sed 's/[^A-Za-z0-9._-]/-/g; s/^-*//; s/-*$//')
  if [ -z "$token" ]; then
    token="task"
  fi
  printf '%s/output-%s.offset' "$INVOKER_SSH_SYNC_DIR" "$token"
}

invoker_journal_output_chunk_locked() {
  local stream_name="$1"
  local data="$2"
  local offset_file
  offset_file=$(invoker_output_offset_file)
  local offset="0"
  if [ -s "$offset_file" ]; then
    IFS= read -r offset < "$offset_file" || offset="0"
  fi
  case "$offset" in
    ''|*[!0-9]*) offset="0" ;;
  esac
  local byte_count
  byte_count=$(printf '%s' "$data" | wc -c | tr -d '[:space:]')
  local next_offset=$((offset + byte_count))
  printf '%s\\n' "$next_offset" > "$offset_file.tmp"
  mv "$offset_file.tmp" "$offset_file"

  local next_seq
  next_seq=$(invoker_progress_next_seq_locked)
  local at
  at=$(invoker_progress_now)
  local task_id_json
  local entity_id_json
  local data_json
  local stream_json
  local created_json
  task_id_json=$(invoker_json_escape "$INVOKER_TASK_ID")
  entity_id_json=$(invoker_json_escape "$INVOKER_TASK_ID@$offset")
  data_json=$(invoker_json_escape "$data")
  stream_json=$(invoker_json_escape "$stream_name")
  created_json=$(invoker_json_escape "$at")
  printf '{"seq":%s,"entityType":"output","entityId":"%s","op":"upsert","payload":{"task_id":"%s","offset":%s,"data":"%s","created_at":"%s","stream":"%s"},"origin":"remote","createdAt":"%s"}\\n' \
    "$next_seq" "$entity_id_json" "$task_id_json" "$offset" "$data_json" "$created_json" "$stream_json" "$created_json" >> "$INVOKER_PROGRESS_JOURNAL"
  invoker_progress_sync_file
}

invoker_journal_output_chunk() {
  invoker_progress_init
  invoker_progress_with_lock invoker_journal_output_chunk_locked "$1" "$2"
}

invoker_journal_stream() {
  local stream_name="$1"
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    invoker_journal_output_chunk "$stream_name" "$line"$'\\n' || true
    printf '%s\\n' "$line"
  done
}

invoker_remote_workflow_tombstoned() {
  if [ -z "\${INVOKER_WORKFLOW_ID:-}" ]; then
    return 1
  fi
  if [ ! -f "$INVOKER_HOME_DELTA_SPOOL" ]; then
    return 1
  fi
  local workflow_json
  workflow_json=$(invoker_json_escape "$INVOKER_WORKFLOW_ID")
  grep -F '"entityType":"workflow"' "$INVOKER_HOME_DELTA_SPOOL" 2>/dev/null \
    | grep -F '"op":"tombstone"' \
    | grep -F '"entityId":"'"$workflow_json"'"' >/dev/null 2>&1
}
`;
}

export function buildRemoteJournalReadScript(options: RemoteJournalReadScriptOptions): string {
  const sinceSeq = asNonNegativeInteger('sinceSeq', Math.trunc(options.sinceSeq));
  const invokerHome = options.invokerHomeVariable ?? '~/.invoker';
  const invokerHomeB64 = base64Encode(invokerHome);

  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(invokerHomeB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
${buildRemoteProgressJournalPathScript({ invokerHomeVariable: 'INVOKER_HOME' })}
INVOKER_SYNC_SINCE=${sinceSeq}
HIGH_WATER=$INVOKER_SYNC_SINCE
if [ -f "$INVOKER_PROGRESS_JOURNAL" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    seq=$(printf '%s\\n' "$line" | sed -n 's/^{"seq":\\([0-9][0-9]*\\),.*$/\\1/p')
    case "$seq" in
      ''|*[!0-9]*) continue ;;
    esac
    if [ "$seq" -gt "$HIGH_WATER" ]; then
      HIGH_WATER=$seq
    fi
    if [ "$seq" -gt "$INVOKER_SYNC_SINCE" ]; then
      printf '%s\\n' "$line"
    fi
  done < "$INVOKER_PROGRESS_JOURNAL"
fi
printf '__INVOKER_SYNC_HIGH_WATER__=%s\\n' "$HIGH_WATER"
`;
}

export function buildRemoteDeltaSpoolScript(options: RemoteDeltaSpoolScriptOptions): string {
  const highWaterSeq = asNonNegativeInteger('highWaterSeq', Math.trunc(options.highWaterSeq));
  const invokerHome = options.invokerHomeVariable ?? '~/.invoker';
  const invokerHomeB64 = base64Encode(invokerHome);
  const entriesB64 = base64Encode(options.entriesNdjson);

  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(invokerHomeB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
${buildRemoteProgressJournalPathScript({ invokerHomeVariable: 'INVOKER_HOME' })}
mkdir -p "$INVOKER_SSH_SYNC_DIR"
chmod 700 "$INVOKER_SSH_SYNC_DIR" >/dev/null 2>&1 || true
tmp="$INVOKER_HOME_DELTA_SPOOL.tmp.$$"
printf '%s' ${shellPosixSingleQuote(entriesB64)} | invoker_base64_decode > "$tmp"
cat "$tmp" >> "$INVOKER_HOME_DELTA_SPOOL"
rm -f "$tmp"
sync -d "$INVOKER_HOME_DELTA_SPOOL" >/dev/null 2>&1 || sync "$INVOKER_HOME_DELTA_SPOOL" >/dev/null 2>&1 || true
printf '__INVOKER_SYNC_PUSH_ACK__=%s\\n' '${highWaterSeq}'
`;
}
