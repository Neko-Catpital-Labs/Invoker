import { DELTA_BATCH_SCHEMA_VERSION, type DeltaBatch, type SyncJournalEntry } from '@invoker/data-store';
import { buildPortableBase64DecodeFunction } from './remote-shell-fragments.js';
import { base64Encode, shellPosixSingleQuote } from './ssh-git-exec.js';

export const REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION = 1;
export const REMOTE_PROGRESS_JOURNAL_FILE = 'progress.journal.ndjson';
export const REMOTE_PROGRESS_JOURNAL_SEQ_FILE = 'progress.journal.seq';
export const REMOTE_SYNC_SPOOL_FILE = 'sync-spool.ndjson';
export const REMOTE_SYNC_PUSH_ACK = '__INVOKER_SSH_SYNC_PUSH_ACK__';
export const REMOTE_PROGRESS_ORIGIN = 'ssh-remote';

export type RemoteProgressJournalKind =
  | 'attempt_started'
  | 'heartbeat'
  | 'output_chunk'
  | 'attempt_finished';

export interface RemoteProgressDeltaEntry {
  seq?: number;
  entityType?: SyncJournalEntry['entityType'];
  entity_type?: SyncJournalEntry['entityType'];
  entityId?: string;
  entity_id?: string;
  op: SyncJournalEntry['op'];
  payload: unknown;
  origin?: string;
  createdAt?: string;
  created_at?: string;
}

export interface RemoteProgressJournalEntry {
  schemaVersion: typeof REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION;
  seq: number;
  kind: RemoteProgressJournalKind;
  taskId?: string;
  attemptId?: string;
  workflowId?: string;
  createdAt: string;
  deltaEntries?: RemoteProgressDeltaEntry[];
}

function asNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeDeltaEntry(
  parent: RemoteProgressJournalEntry,
  entry: RemoteProgressDeltaEntry,
): SyncJournalEntry {
  const entityType = entry.entityType ?? entry.entity_type;
  const entityId = entry.entityId ?? entry.entity_id;
  if (!entityType) throw new Error(`remote journal seq ${parent.seq} delta entry missing entityType`);
  if (!entityId) throw new Error(`remote journal seq ${parent.seq} delta entry missing entityId`);
  return {
    seq: asNonNegativeInteger('delta entry seq', Math.trunc(entry.seq ?? parent.seq)),
    entityType,
    entityId,
    op: entry.op,
    payload: entry.payload,
    origin: entry.origin ?? REMOTE_PROGRESS_ORIGIN,
    createdAt: entry.createdAt ?? entry.created_at ?? parent.createdAt,
  };
}

export function parseRemoteProgressJournalLines(text: string): RemoteProgressJournalEntry[] {
  const entries: RemoteProgressJournalEntry[] = [];
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const parsed = objectValue(JSON.parse(line), `remote journal line ${index + 1}`);
    const schemaVersion = Number(parsed.schemaVersion);
    if (schemaVersion !== REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION) {
      throw new Error(`Unsupported remote progress journal schema version ${String(parsed.schemaVersion)}`);
    }
    const seq = asNonNegativeInteger('remote journal seq', Math.trunc(Number(parsed.seq)));
    const kind = String(parsed.kind) as RemoteProgressJournalKind;
    if (!['attempt_started', 'heartbeat', 'output_chunk', 'attempt_finished'].includes(kind)) {
      throw new Error(`Unsupported remote progress journal kind ${String(parsed.kind)}`);
    }
    const createdAt = typeof parsed.createdAt === 'string' && parsed.createdAt
      ? parsed.createdAt
      : new Date(0).toISOString();
    const deltaEntries = parsed.deltaEntries === undefined
      ? undefined
      : (parsed.deltaEntries as unknown[]).map((entry) =>
          objectValue(entry, `remote journal seq ${seq} delta entry`) as unknown as RemoteProgressDeltaEntry,
        );
    entries.push({
      schemaVersion: REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION,
      seq,
      kind,
      taskId: typeof parsed.taskId === 'string' ? parsed.taskId : undefined,
      attemptId: typeof parsed.attemptId === 'string' ? parsed.attemptId : undefined,
      workflowId: typeof parsed.workflowId === 'string' ? parsed.workflowId : undefined,
      createdAt,
      deltaEntries,
    });
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

export function remoteProgressEntriesToDeltaBatch(
  entries: RemoteProgressJournalEntry[],
  sinceSeq: number,
): DeltaBatch {
  const cursor = asNonNegativeInteger('sinceSeq', Math.trunc(sinceSeq));
  const highWaterSeq = Math.max(cursor, ...entries.map((entry) => entry.seq));
  return {
    schemaVersion: DELTA_BATCH_SCHEMA_VERSION,
    sinceSeq: cursor,
    highWaterSeq,
    entries: entries.flatMap((entry) =>
      (entry.deltaEntries ?? []).map((deltaEntry) => normalizeDeltaEntry(entry, deltaEntry)),
    ),
  };
}

export function parseRemoteProgressDelta(text: string, sinceSeq: number): DeltaBatch {
  return remoteProgressEntriesToDeltaBatch(parseRemoteProgressJournalLines(text), sinceSeq);
}

export function remoteSyncRootExpression(invokerHomeVariable = 'INVOKER_HOME'): string {
  return `$${invokerHomeVariable}/runtime/ssh-executor`;
}

export function buildDecodeRemoteInvokerHomeScript(remoteInvokerHome = '~/.invoker'): string {
  const homeB64 = base64Encode(remoteInvokerHome);
  return `${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(homeB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
INVOKER_REMOTE_SYNC_ROOT="$INVOKER_HOME/runtime/ssh-executor"
mkdir -p "$INVOKER_REMOTE_SYNC_ROOT"
`;
}

export function buildReadRemoteProgressJournalScript(options: {
  remoteInvokerHome?: string;
  sinceSeq: number;
  limit?: number;
}): string {
  const sinceSeq = asNonNegativeInteger('sinceSeq', Math.trunc(options.sinceSeq));
  const limit = asNonNegativeInteger('limit', Math.trunc(options.limit ?? 1000));
  return `set -euo pipefail
${buildDecodeRemoteInvokerHomeScript(options.remoteInvokerHome)}
JOURNAL_PATH="$INVOKER_REMOTE_SYNC_ROOT/${REMOTE_PROGRESS_JOURNAL_FILE}"
SINCE_SEQ=${sinceSeq}
LIMIT=${limit}
if [ ! -f "$JOURNAL_PATH" ] || [ "$LIMIT" -eq 0 ]; then
  exit 0
fi
COUNT=0
while IFS= read -r line; do
  seq=$(printf '%s\\n' "$line" | sed -n 's/.*"seq"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')
  if [ -n "$seq" ] && [ "$seq" -gt "$SINCE_SEQ" ]; then
    printf '%s\\n' "$line"
    COUNT=$((COUNT + 1))
    if [ "$COUNT" -ge "$LIMIT" ]; then
      break
    fi
  fi
done < "$JOURNAL_PATH"
`;
}

export function buildAppendRemoteSyncSpoolScript(options: {
  remoteInvokerHome?: string;
  batch: DeltaBatch;
}): string {
  const batchLine = `${JSON.stringify(options.batch)}\n`;
  const batchB64 = base64Encode(batchLine);
  return `set -euo pipefail
${buildDecodeRemoteInvokerHomeScript(options.remoteInvokerHome)}
SPOOL_PATH="$INVOKER_REMOTE_SYNC_ROOT/${REMOTE_SYNC_SPOOL_FILE}"
TMP_PATH="$SPOOL_PATH.tmp.$$"
printf '%s' ${shellPosixSingleQuote(batchB64)} | invoker_base64_decode > "$TMP_PATH"
cat "$TMP_PATH" >> "$SPOOL_PATH"
rm -f "$TMP_PATH"
sync "$SPOOL_PATH" >/dev/null 2>&1 || true
printf '${REMOTE_SYNC_PUSH_ACK}=%s\\n' ${options.batch.highWaterSeq}
`;
}

export function buildRemoteProgressJournalShellFragment(): string {
  return `invoker_json_escape() {
  local value="\${1-}"
  value="\${value//\\\\/\\\\\\\\}"
  value="\${value//\\"/\\\\\\"}"
  value="\${value//$'\\n'/\\\\n}"
  value="\${value//$'\\r'/\\\\r}"
  value="\${value//$'\\t'/\\\\t}"
  printf '%s' "$value"
}

invoker_json_string() {
  printf '"%s"' "$(invoker_json_escape "\${1-}")"
}

invoker_json_nullable_string() {
  if [ -n "\${1-}" ]; then
    invoker_json_string "$1"
  else
    printf 'null'
  fi
}

invoker_remote_iso_now() {
  date -u '+%Y-%m-%dT%H:%M:%S.000Z'
}

invoker_remote_sync_init() {
  INVOKER_REMOTE_SYNC_ROOT="\${INVOKER_REMOTE_SYNC_ROOT:-$INVOKER_HOME/runtime/ssh-executor}"
  INVOKER_REMOTE_PROGRESS_JOURNAL_PATH="\${INVOKER_REMOTE_PROGRESS_JOURNAL_PATH:-$INVOKER_REMOTE_SYNC_ROOT/${REMOTE_PROGRESS_JOURNAL_FILE}}"
  INVOKER_REMOTE_PROGRESS_JOURNAL_SEQ_PATH="\${INVOKER_REMOTE_PROGRESS_JOURNAL_SEQ_PATH:-$INVOKER_REMOTE_SYNC_ROOT/${REMOTE_PROGRESS_JOURNAL_SEQ_FILE}}"
  INVOKER_REMOTE_SYNC_SPOOL_PATH="\${INVOKER_REMOTE_SYNC_SPOOL_PATH:-$INVOKER_REMOTE_SYNC_ROOT/${REMOTE_SYNC_SPOOL_FILE}}"
  mkdir -p "$INVOKER_REMOTE_SYNC_ROOT"
  touch "$INVOKER_REMOTE_PROGRESS_JOURNAL_PATH"
  touch "$INVOKER_REMOTE_SYNC_SPOOL_PATH"
}

invoker_remote_next_journal_seq() {
  invoker_remote_sync_init
  local lock_dir="$INVOKER_REMOTE_SYNC_ROOT/.progress-journal.lock"
  local waited=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    sleep 0.05
    waited=$((waited + 1))
    if [ "$waited" -gt 200 ]; then
      rm -rf "$lock_dir" >/dev/null 2>&1 || true
    fi
  done
  local seq_raw seq
  seq_raw=$(cat "$INVOKER_REMOTE_PROGRESS_JOURNAL_SEQ_PATH" 2>/dev/null || printf '0')
  case "$seq_raw" in
    ''|*[!0-9]*) seq=0 ;;
    *) seq="$seq_raw" ;;
  esac
  seq=$((seq + 1))
  printf '%s\\n' "$seq" > "$INVOKER_REMOTE_PROGRESS_JOURNAL_SEQ_PATH.tmp.$$"
  mv "$INVOKER_REMOTE_PROGRESS_JOURNAL_SEQ_PATH.tmp.$$" "$INVOKER_REMOTE_PROGRESS_JOURNAL_SEQ_PATH"
  rmdir "$lock_dir" >/dev/null 2>&1 || true
  printf '%s' "$seq"
}

invoker_remote_append_journal_line() {
  local line="$1"
  invoker_remote_sync_init
  printf '%s\\n' "$line" >> "$INVOKER_REMOTE_PROGRESS_JOURNAL_PATH"
  sync "$INVOKER_REMOTE_PROGRESS_JOURNAL_PATH" >/dev/null 2>&1 || true
}

invoker_remote_attempt_delta_json() {
  local status="$1"
  local at="$2"
  local exit_code="\${3-}"
  local error_text="\${4-}"
  local task_id="\${INVOKER_REMOTE_TASK_ID:-unknown-task}"
  local attempt_id="\${INVOKER_REMOTE_ATTEMPT_ID:-$task_id}"
  local branch="\${INVOKER_REMOTE_BRANCH:-}"
  local workspace_path="\${INVOKER_REMOTE_WORKSPACE_PATH:-}"
  local exit_fragment=""
  local error_fragment=""
  if [ -n "$exit_code" ]; then
    exit_fragment=',"exit_code":'"$exit_code"
  fi
  if [ -n "$error_text" ]; then
    error_fragment=',"error":'$(invoker_json_string "$error_text")
  fi
  printf '{"entityType":"attempt","entityId":%s,"op":"upsert","origin":"${REMOTE_PROGRESS_ORIGIN}","createdAt":%s,"payload":{"id":%s,"node_id":%s,"attempt_number":0,"queue_priority":0,"status":%s,"upstream_attempt_ids":"[]","created_at":%s,"started_at":%s,"last_heartbeat_at":%s,"branch":%s,"workspace_path":%s%s%s}}' \\
    "$(invoker_json_string "$attempt_id")" \\
    "$(invoker_json_string "$at")" \\
    "$(invoker_json_string "$attempt_id")" \\
    "$(invoker_json_string "$task_id")" \\
    "$(invoker_json_string "$status")" \\
    "$(invoker_json_string "\${INVOKER_REMOTE_ATTEMPT_CREATED_AT:-$at}")" \\
    "$(invoker_json_string "\${INVOKER_REMOTE_ATTEMPT_STARTED_AT:-$at}")" \\
    "$(invoker_json_string "$at")" \\
    "$(invoker_json_nullable_string "$branch")" \\
    "$(invoker_json_nullable_string "$workspace_path")" \\
    "$exit_fragment" \\
    "$error_fragment"
}

invoker_remote_task_delta_json() {
  local status="$1"
  local at="$2"
  local exit_code="\${3-}"
  local error_text="\${4-}"
  local workflow_id="\${INVOKER_REMOTE_WORKFLOW_ID:-}"
  if [ -z "$workflow_id" ]; then
    return 0
  fi
  local task_id="\${INVOKER_REMOTE_TASK_ID:-unknown-task}"
  local attempt_id="\${INVOKER_REMOTE_ATTEMPT_ID:-$task_id}"
  local description="\${INVOKER_REMOTE_TASK_DESCRIPTION:-$task_id}"
  local branch="\${INVOKER_REMOTE_BRANCH:-}"
  local workspace_path="\${INVOKER_REMOTE_WORKSPACE_PATH:-}"
  local generation="\${INVOKER_REMOTE_EXECUTION_GENERATION:-0}"
  case "$generation" in
    ''|*[!0-9]*) generation=0 ;;
  esac
  local exit_fragment=""
  local error_fragment=""
  local completed_fragment=""
  if [ -n "$exit_code" ]; then
    exit_fragment=',"exit_code":'"$exit_code"
  fi
  if [ -n "$error_text" ]; then
    error_fragment=',"error":'$(invoker_json_string "$error_text")
  fi
  if [ "$status" = "completed" ] || [ "$status" = "failed" ]; then
    completed_fragment=',"completed_at":'$(invoker_json_string "$at")
  fi
  printf '{"entityType":"task","entityId":%s,"op":"upsert","origin":"${REMOTE_PROGRESS_ORIGIN}","createdAt":%s,"payload":{"id":%s,"workflow_id":%s,"description":%s,"status":%s,"dependencies":"[]","created_at":%s,"started_at":%s,"last_heartbeat_at":%s,"branch":%s,"workspace_path":%s,"execution_generation":%s,"selected_attempt_id":%s,"task_state_version":%s%s%s%s}}' \\
    "$(invoker_json_string "$task_id")" \\
    "$(invoker_json_string "$at")" \\
    "$(invoker_json_string "$task_id")" \\
    "$(invoker_json_string "$workflow_id")" \\
    "$(invoker_json_string "$description")" \\
    "$(invoker_json_string "$status")" \\
    "$(invoker_json_string "\${INVOKER_REMOTE_ATTEMPT_CREATED_AT:-$at}")" \\
    "$(invoker_json_string "\${INVOKER_REMOTE_ATTEMPT_STARTED_AT:-$at}")" \\
    "$(invoker_json_string "$at")" \\
    "$(invoker_json_nullable_string "$branch")" \\
    "$(invoker_json_nullable_string "$workspace_path")" \\
    "$generation" \\
    "$(invoker_json_string "$attempt_id")" \\
    "$((generation + 1))" \\
    "$completed_fragment" \\
    "$exit_fragment" \\
    "$error_fragment"
}

invoker_remote_append_progress_entry() {
  local kind="$1"
  local delta_entries="$2"
  local at="\${3:-$(invoker_remote_iso_now)}"
  local seq
  seq=$(invoker_remote_next_journal_seq)
  local task_id="\${INVOKER_REMOTE_TASK_ID:-unknown-task}"
  local attempt_id="\${INVOKER_REMOTE_ATTEMPT_ID:-$task_id}"
  local workflow_id="\${INVOKER_REMOTE_WORKFLOW_ID:-}"
  local line
  line=$(printf '{"schemaVersion":${REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION},"seq":%s,"kind":%s,"taskId":%s,"attemptId":%s,"workflowId":%s,"createdAt":%s,"deltaEntries":%s}' \\
    "$seq" \\
    "$(invoker_json_string "$kind")" \\
    "$(invoker_json_string "$task_id")" \\
    "$(invoker_json_string "$attempt_id")" \\
    "$(invoker_json_nullable_string "$workflow_id")" \\
    "$(invoker_json_string "$at")" \\
    "$delta_entries")
  invoker_remote_append_journal_line "$line"
}

invoker_remote_journal_attempt_started() {
  local at
  at=$(invoker_remote_iso_now)
  INVOKER_REMOTE_ATTEMPT_CREATED_AT="\${INVOKER_REMOTE_ATTEMPT_CREATED_AT:-$at}"
  INVOKER_REMOTE_ATTEMPT_STARTED_AT="\${INVOKER_REMOTE_ATTEMPT_STARTED_AT:-$at}"
  local attempt_delta task_delta deltas
  attempt_delta=$(invoker_remote_attempt_delta_json "running" "$at")
  task_delta=$(invoker_remote_task_delta_json "running" "$at" || true)
  if [ -n "$task_delta" ]; then
    deltas="[$attempt_delta,$task_delta]"
  else
    deltas="[$attempt_delta]"
  fi
  invoker_remote_append_progress_entry "attempt_started" "$deltas" "$at"
}

invoker_remote_journal_heartbeat() {
  local at
  at=$(invoker_remote_iso_now)
  local attempt_delta
  attempt_delta=$(invoker_remote_attempt_delta_json "running" "$at")
  invoker_remote_append_progress_entry "heartbeat" "[$attempt_delta]" "$at"
}

invoker_remote_journal_output() {
  local stream="$1"
  local data="$2"
  local at
  at=$(invoker_remote_iso_now)
  local task_id="\${INVOKER_REMOTE_TASK_ID:-unknown-task}"
  local offset="\${INVOKER_REMOTE_OUTPUT_OFFSET:-0}"
  local bytes
  bytes=$(printf '%s' "$data" | wc -c | tr -d ' ')
  INVOKER_REMOTE_OUTPUT_OFFSET=$((offset + bytes))
  local entity_id="$task_id:$offset"
  local output_delta
  output_delta=$(printf '{"entityType":"output","entityId":%s,"op":"upsert","origin":"${REMOTE_PROGRESS_ORIGIN}","createdAt":%s,"payload":{"task_id":%s,"offset":%s,"data":%s,"created_at":%s,"stream":%s}}' \\
    "$(invoker_json_string "$entity_id")" \\
    "$(invoker_json_string "$at")" \\
    "$(invoker_json_string "$task_id")" \\
    "$offset" \\
    "$(invoker_json_string "$data")" \\
    "$(invoker_json_string "$at")" \\
    "$(invoker_json_string "$stream")")
  invoker_remote_append_progress_entry "output_chunk" "[$output_delta]" "$at"
}

invoker_remote_journal_attempt_finished() {
  local exit_code="$1"
  local at
  at=$(invoker_remote_iso_now)
  local status="completed"
  local error_text=""
  if [ "$exit_code" -ne 0 ]; then
    status="failed"
    if [ -f "\${INVOKER_REMOTE_TOMBSTONE_FLAG:-}" ]; then
      error_text="Terminated after workflow tombstone"
    fi
  fi
  local attempt_delta task_delta deltas
  attempt_delta=$(invoker_remote_attempt_delta_json "$status" "$at" "$exit_code" "$error_text")
  task_delta=$(invoker_remote_task_delta_json "$status" "$at" "$exit_code" "$error_text" || true)
  if [ -n "$task_delta" ]; then
    deltas="[$attempt_delta,$task_delta]"
  else
    deltas="[$attempt_delta]"
  fi
  invoker_remote_append_progress_entry "attempt_finished" "$deltas" "$at"
}

invoker_remote_workflow_tombstoned() {
  local workflow_id="\${INVOKER_REMOTE_WORKFLOW_ID:-}"
  if [ -z "$workflow_id" ] || [ ! -f "\${INVOKER_REMOTE_SYNC_SPOOL_PATH:-}" ]; then
    return 1
  fi
  local workflow_json
  workflow_json=$(invoker_json_string "$workflow_id")
  grep -F '"entityType":"workflow"' "$INVOKER_REMOTE_SYNC_SPOOL_PATH" 2>/dev/null \\
    | grep -F '"op":"tombstone"' \\
    | grep -F '"entityId":'"$workflow_json" >/dev/null 2>&1
}

invoker_remote_stream_with_journal() {
  local stream="$1"
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    invoker_remote_journal_output "$stream" "$line"$'\\n'
    printf '%s\\n' "$line"
  done
}
`;
}
