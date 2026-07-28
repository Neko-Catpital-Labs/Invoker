import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import type { DeltaBatch } from '@invoker/data-store';
import { DELTA_BATCH_SCHEMA_VERSION } from '@invoker/data-store';
import type { SyncJournalEntry } from '@invoker/data-store';
import type { AttemptStatus } from '@invoker/workflow-core';
import { base64Encode, shellPosixSingleQuote } from './ssh-git-exec.js';
import { buildPortableBase64DecodeFunction } from './remote-shell-fragments.js';

export const REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION = 1;
export const REMOTE_PROGRESS_JOURNAL_ORIGIN = 'ssh-remote';
export const REMOTE_PROGRESS_JOURNAL_FILENAME = 'progress.ndjson';
export const REMOTE_SYNC_SPOOL_FILENAME = 'home-delta-spool.ndjson';

export type RemoteProgressJournalEntryType =
  | 'attempt_started'
  | 'heartbeat'
  | 'output_chunk'
  | 'attempt_finished';

export interface RemoteProgressJournalEntry {
  schemaVersion: typeof REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION;
  seq: number;
  type: RemoteProgressJournalEntryType;
  workflowId: string;
  taskId: string;
  requestId: string;
  executionGeneration: number;
  attemptId?: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface RemoteProgressJournalContext {
  workflowId: string;
  taskId: string;
  requestId: string;
  executionGeneration: number;
  attemptId?: string;
}

export interface RemoteProgressJournalPaths {
  journalFile: string;
  spoolFile: string;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function parseRemoteJournalLine(line: string): RemoteProgressJournalEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as Partial<RemoteProgressJournalEntry>;
  if (parsed.schemaVersion !== REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION) {
    throw new Error(`Unsupported remote progress journal schema version ${String(parsed.schemaVersion)}`);
  }
  if (!Number.isInteger(parsed.seq) || parsed.seq < 0) {
    throw new Error('Remote progress journal entry seq must be a non-negative integer');
  }
  if (!parsed.type || !parsed.workflowId || !parsed.taskId || !parsed.requestId || !parsed.createdAt) {
    throw new Error(`Malformed remote progress journal entry at seq ${parsed.seq}`);
  }
  if (!Number.isInteger(parsed.executionGeneration) || parsed.executionGeneration < 0) {
    throw new Error(`Malformed remote progress journal executionGeneration at seq ${parsed.seq}`);
  }
  if (!parsed.payload || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) {
    throw new Error(`Malformed remote progress journal payload at seq ${parsed.seq}`);
  }
  return parsed as RemoteProgressJournalEntry;
}

export function parseRemoteProgressJournal(text: string): RemoteProgressJournalEntry[] {
  return text
    .split('\n')
    .map((line) => parseRemoteJournalLine(line))
    .filter((entry): entry is RemoteProgressJournalEntry => !!entry);
}

function iso(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return fallback;
}

function text(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function integer(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function baseTaskPayload(entry: RemoteProgressJournalEntry): Record<string, unknown> {
  return {
    id: entry.taskId,
    workflow_id: entry.workflowId,
    description: text(entry.payload.description) ?? entry.taskId,
    dependencies: '[]',
    execution_generation: entry.executionGeneration,
  };
}

function baseAttemptPayload(entry: RemoteProgressJournalEntry): Record<string, unknown> {
  return {
    id: entry.attemptId ?? `${entry.taskId}:${entry.requestId}`,
    node_id: entry.taskId,
    attempt_number: integer(entry.payload.attemptNumber) ?? 0,
    queue_priority: integer(entry.payload.queuePriority) ?? 0,
    upstream_attempt_ids: '[]',
    created_at: iso(entry.payload.createdAt, entry.createdAt),
  };
}

function entryToSyncEntries(entry: RemoteProgressJournalEntry): SyncJournalEntry[] {
  switch (entry.type) {
    case 'attempt_started': {
      const startedAt = iso(entry.payload.startedAt, entry.createdAt);
      const taskPayload = {
        ...baseTaskPayload(entry),
        status: 'running',
        started_at: startedAt,
        last_heartbeat_at: startedAt,
        selected_attempt_id: entry.attemptId ?? null,
        action_request_id: entry.requestId,
        branch: text(entry.payload.branch) ?? null,
        workspace_path: text(entry.payload.workspacePath) ?? null,
        agent_session_id: text(entry.payload.agentSessionId) ?? null,
        agent_name: text(entry.payload.agentName) ?? null,
      };
      const attemptPayload = {
        ...baseAttemptPayload(entry),
        status: 'running' satisfies AttemptStatus,
        started_at: startedAt,
        last_heartbeat_at: startedAt,
        branch: text(entry.payload.branch) ?? null,
        workspace_path: text(entry.payload.workspacePath) ?? null,
        agent_session_id: text(entry.payload.agentSessionId) ?? null,
      };
      return [
        {
          seq: entry.seq,
          entityType: 'task',
          entityId: entry.taskId,
          op: 'upsert',
          payload: taskPayload,
          origin: REMOTE_PROGRESS_JOURNAL_ORIGIN,
          createdAt: entry.createdAt,
        },
        {
          seq: entry.seq,
          entityType: 'attempt',
          entityId: String(attemptPayload.id),
          op: 'upsert',
          payload: attemptPayload,
          origin: REMOTE_PROGRESS_JOURNAL_ORIGIN,
          createdAt: entry.createdAt,
        },
      ];
    }
    case 'heartbeat': {
      const heartbeatAt = iso(entry.payload.heartbeatAt, entry.createdAt);
      return [
        {
          seq: entry.seq,
          entityType: 'task',
          entityId: entry.taskId,
          op: 'upsert',
          payload: {
            ...baseTaskPayload(entry),
            status: 'running',
            last_heartbeat_at: heartbeatAt,
          },
          origin: REMOTE_PROGRESS_JOURNAL_ORIGIN,
          createdAt: entry.createdAt,
        },
        {
          seq: entry.seq,
          entityType: 'attempt',
          entityId: entry.attemptId ?? `${entry.taskId}:${entry.requestId}`,
          op: 'upsert',
          payload: {
            ...baseAttemptPayload(entry),
            status: 'running' satisfies AttemptStatus,
            last_heartbeat_at: heartbeatAt,
          },
          origin: REMOTE_PROGRESS_JOURNAL_ORIGIN,
          createdAt: entry.createdAt,
        },
      ];
    }
    case 'output_chunk': {
      const offset = integer(entry.payload.offset) ?? 0;
      return [
        {
          seq: entry.seq,
          entityType: 'output',
          entityId: `${entry.taskId}:${offset}`,
          op: 'upsert',
          payload: {
            task_id: entry.taskId,
            offset,
            data: text(entry.payload.data) ?? '',
            created_at: entry.createdAt,
          },
          origin: REMOTE_PROGRESS_JOURNAL_ORIGIN,
          createdAt: entry.createdAt,
        },
      ];
    }
    case 'attempt_finished': {
      const completedAt = iso(entry.payload.completedAt, entry.createdAt);
      const exitCode = integer(entry.payload.exitCode) ?? 0;
      const status = text(entry.payload.status) === 'completed' ? 'completed' : 'failed';
      const error = text(entry.payload.error);
      const commitHash = text(entry.payload.commitHash);
      const taskPayload = {
        ...baseTaskPayload(entry),
        status,
        completed_at: completedAt,
        exit_code: exitCode,
        error: error ?? null,
        commit_hash: commitHash ?? null,
        branch: text(entry.payload.branch) ?? null,
        workspace_path: text(entry.payload.workspacePath) ?? null,
        agent_session_id: text(entry.payload.agentSessionId) ?? null,
        agent_name: text(entry.payload.agentName) ?? null,
      };
      const attemptPayload = {
        ...baseAttemptPayload(entry),
        status: status satisfies AttemptStatus,
        completed_at: completedAt,
        exit_code: exitCode,
        error: error ?? null,
        commit_hash: commitHash ?? null,
        branch: text(entry.payload.branch) ?? null,
        workspace_path: text(entry.payload.workspacePath) ?? null,
        agent_session_id: text(entry.payload.agentSessionId) ?? null,
      };
      return [
        {
          seq: entry.seq,
          entityType: 'task',
          entityId: entry.taskId,
          op: 'upsert',
          payload: taskPayload,
          origin: REMOTE_PROGRESS_JOURNAL_ORIGIN,
          createdAt: entry.createdAt,
        },
        {
          seq: entry.seq,
          entityType: 'attempt',
          entityId: String(attemptPayload.id),
          op: 'upsert',
          payload: attemptPayload,
          origin: REMOTE_PROGRESS_JOURNAL_ORIGIN,
          createdAt: entry.createdAt,
        },
      ];
    }
    default:
      throw new Error(`Unsupported remote progress journal entry type ${(entry as { type?: unknown }).type}`);
  }
}

export function remoteProgressEntriesToDeltaBatch(
  entries: readonly RemoteProgressJournalEntry[],
  sinceSeq: number,
): DeltaBatch {
  const highWaterSeq = Math.max(sinceSeq, ...entries.map((entry) => entry.seq), 0);
  return {
    schemaVersion: DELTA_BATCH_SCHEMA_VERSION,
    sinceSeq,
    highWaterSeq,
    entries: entries.flatMap((entry) => entryToSyncEntries(entry)),
  };
}

export function serializeRemoteProgressJournalEntry(
  entry: Omit<RemoteProgressJournalEntry, 'schemaVersion'>,
): string {
  return JSON.stringify({ schemaVersion: REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION, ...entry }, jsonReplacer);
}

export function buildRemoteProgressJournalPaths(stagingDir: string): RemoteProgressJournalPaths {
  return {
    journalFile: `${stagingDir}/${REMOTE_PROGRESS_JOURNAL_FILENAME}`,
    spoolFile: `${stagingDir}/${REMOTE_SYNC_SPOOL_FILENAME}`,
  };
}

export function buildReadRemoteProgressJournalScript(opts: {
  invokerHome?: string;
  executionId: string;
  actionId: string;
  sinceSeq: number;
  limit?: number;
}): string {
  const invokerHomeB64 = base64Encode(opts.invokerHome ?? '~/.invoker');
  const executionIdB64 = base64Encode(opts.executionId);
  const actionIdB64 = base64Encode(opts.actionId);
  const sinceSeq = Math.max(0, Math.trunc(opts.sinceSeq));
  const limit = Math.max(0, Math.trunc(opts.limit ?? 1000));
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(invokerHomeB64)} | invoker_base64_decode)
EXECUTION_ID=$(printf '%s' ${shellPosixSingleQuote(executionIdB64)} | invoker_base64_decode)
ACTION_ID=$(printf '%s' ${shellPosixSingleQuote(actionIdB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
safe_token() {
  printf '%s' "$1" | sed -E 's/[^A-Za-z0-9._-]+/-/g; s/^-+//; s/-+$//' | awk '{ if (length($0) == 0) print "task"; else print $0 }'
}
STAGING_TOKEN="$(safe_token "$EXECUTION_ID")-$(safe_token "$ACTION_ID" | cut -c1-80)"
JOURNAL_FILE="$INVOKER_HOME/runtime/ssh-executor/$STAGING_TOKEN/${REMOTE_PROGRESS_JOURNAL_FILENAME}"
if [ ! -f "$JOURNAL_FILE" ]; then
  exit 0
fi
awk -v since='${sinceSeq}' -v limit='${limit}' '
  BEGIN { count = 0 }
  {
    seq = 0
    if (match($0, /"seq"[[:space:]]*:[[:space:]]*[0-9]+/)) {
      seqText = substr($0, RSTART, RLENGTH)
      sub(/.*:/, "", seqText)
      seq = seqText + 0
    }
    if (seq > since) {
      print $0
      count += 1
      if (limit > 0 && count >= limit) exit
    }
  }
' "$JOURNAL_FILE"
`;
}

export function buildWriteRemoteSyncSpoolScript(opts: {
  invokerHome?: string;
  executionId: string;
  actionId: string;
  batch: DeltaBatch;
}): string {
  const invokerHomeB64 = base64Encode(opts.invokerHome ?? '~/.invoker');
  const executionIdB64 = base64Encode(opts.executionId);
  const actionIdB64 = base64Encode(opts.actionId);
  const batchB64 = base64Encode(`${JSON.stringify(opts.batch, jsonReplacer)}\n`);
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(invokerHomeB64)} | invoker_base64_decode)
EXECUTION_ID=$(printf '%s' ${shellPosixSingleQuote(executionIdB64)} | invoker_base64_decode)
ACTION_ID=$(printf '%s' ${shellPosixSingleQuote(actionIdB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
safe_token() {
  printf '%s' "$1" | sed -E 's/[^A-Za-z0-9._-]+/-/g; s/^-+//; s/-+$//' | awk '{ if (length($0) == 0) print "task"; else print $0 }'
}
STAGING_TOKEN="$(safe_token "$EXECUTION_ID")-$(safe_token "$ACTION_ID" | cut -c1-80)"
STAGING_DIR="$INVOKER_HOME/runtime/ssh-executor/$STAGING_TOKEN"
mkdir -p "$STAGING_DIR"
chmod 700 "$STAGING_DIR"
SPOOL_FILE="$STAGING_DIR/${REMOTE_SYNC_SPOOL_FILENAME}"
TMP_FILE="$SPOOL_FILE.tmp.$$"
printf '%s' ${shellPosixSingleQuote(batchB64)} | invoker_base64_decode > "$TMP_FILE"
cat "$TMP_FILE" >> "$SPOOL_FILE"
rm -f "$TMP_FILE"
printf '__INVOKER_SSH_SYNC_ACK__=%s\\n' ${shellPosixSingleQuote(String(opts.batch.highWaterSeq))}
`;
}

export function buildRemoteProgressJournalBashLibrary(opts: {
  workflowId: string;
  taskId: string;
  request: WorkRequest;
  heartbeatMarker: string;
  journalFileExpression?: string;
  spoolFileExpression?: string;
}): string {
  const generation = Math.max(0, Math.trunc(opts.request.executionGeneration ?? 0));
  const journalFileExpression = opts.journalFileExpression ?? '"$REMOTE_PROGRESS_JOURNAL_FILE"';
  const spoolFileExpression = opts.spoolFileExpression ?? '"$REMOTE_SYNC_SPOOL_FILE"';

  return `
INVOKER_REMOTE_JOURNAL_SCHEMA_VERSION=${REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION}
INVOKER_REMOTE_WORKFLOW_ID=${shellPosixSingleQuote(opts.workflowId)}
INVOKER_REMOTE_TASK_ID=${shellPosixSingleQuote(opts.taskId)}
INVOKER_REMOTE_REQUEST_ID=${shellPosixSingleQuote(opts.request.requestId)}
INVOKER_REMOTE_ATTEMPT_ID=${shellPosixSingleQuote(opts.request.attemptId ?? '')}
INVOKER_REMOTE_TASK_DESCRIPTION=${shellPosixSingleQuote(opts.request.inputs.description ?? opts.taskId)}
INVOKER_REMOTE_AGENT_NAME=${shellPosixSingleQuote(opts.request.inputs.executionAgent ?? '')}
INVOKER_REMOTE_EXECUTION_GENERATION=${generation}
INVOKER_REMOTE_OUTPUT_OFFSET=0
INVOKER_REMOTE_SYNC_SPOOL_OFFSET=0
INVOKER_REMOTE_TERMINATE_REQUESTED=0
INVOKER_REMOTE_JOURNAL_FILE=${journalFileExpression}
INVOKER_REMOTE_SYNC_SPOOL_FILE=${spoolFileExpression}
INVOKER_HEARTBEAT_MARKER=${shellPosixSingleQuote(opts.heartbeatMarker)}

invoker_json_escape() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()), end="")'
  elif command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0, "utf8")));'
  else
    awk 'BEGIN { printf "\\"" } { gsub(/\\\\/, "\\\\\\\\"); gsub(/"/, "\\\\\\""); if (NR > 1) printf "\\\\n"; printf "%s", $0 } END { printf "\\"" }'
  fi
}

invoker_json_value() {
  printf '%s' "$1" | invoker_json_escape
}

invoker_now_iso() {
  date -u '+%Y-%m-%dT%H:%M:%S.000Z'
}

invoker_journal_next_seq() {
  if [ ! -f "$INVOKER_REMOTE_JOURNAL_FILE" ]; then
    printf '1'
    return
  fi
  awk '
    {
      if (match($0, /"seq"[[:space:]]*:[[:space:]]*[0-9]+/)) {
        seqText = substr($0, RSTART, RLENGTH)
        sub(/.*:/, "", seqText)
        if ((seqText + 0) > max) max = seqText + 0
      }
    }
    END { printf "%d", max + 1 }
  ' "$INVOKER_REMOTE_JOURNAL_FILE"
}

invoker_append_remote_journal_entry() {
  local type="$1"
  local payload="$2"
  local seq
  local now
  local attempt_fragment=''
  seq=$(invoker_journal_next_seq)
  now=$(invoker_now_iso)
  mkdir -p "$(dirname "$INVOKER_REMOTE_JOURNAL_FILE")"
  if [ -n "$INVOKER_REMOTE_ATTEMPT_ID" ]; then
    attempt_fragment=',"attemptId":'$(invoker_json_value "$INVOKER_REMOTE_ATTEMPT_ID")
  fi
  printf '{"schemaVersion":%s,"seq":%s,"type":%s,"workflowId":%s,"taskId":%s,"requestId":%s,"executionGeneration":%s%s,"createdAt":%s,"payload":%s}\\n' \\
    "$INVOKER_REMOTE_JOURNAL_SCHEMA_VERSION" \\
    "$seq" \\
    "$(invoker_json_value "$type")" \\
    "$(invoker_json_value "$INVOKER_REMOTE_WORKFLOW_ID")" \\
    "$(invoker_json_value "$INVOKER_REMOTE_TASK_ID")" \\
    "$(invoker_json_value "$INVOKER_REMOTE_REQUEST_ID")" \\
    "$INVOKER_REMOTE_EXECUTION_GENERATION" \\
    "$attempt_fragment" \\
    "$(invoker_json_value "$now")" \\
    "$payload" >> "$INVOKER_REMOTE_JOURNAL_FILE"
  sync "$INVOKER_REMOTE_JOURNAL_FILE" >/dev/null 2>&1 || true
}

invoker_json_payload_attempt_started() {
  local now="$1"
  local workspace_path="\${2:-}"
  local branch="\${3:-}"
  printf '{"startedAt":%s,"description":%s,"workspacePath":%s,"branch":%s,"agentName":%s}' \\
    "$(invoker_json_value "$now")" \\
    "$(invoker_json_value "$INVOKER_REMOTE_TASK_DESCRIPTION")" \\
    "$(invoker_json_value "$workspace_path")" \\
    "$(invoker_json_value "$branch")" \\
    "$(invoker_json_value "$INVOKER_REMOTE_AGENT_NAME")"
}

invoker_record_attempt_started() {
  local now
  now=$(invoker_now_iso)
  invoker_append_remote_journal_entry "attempt_started" "$(invoker_json_payload_attempt_started "$now" "\${INVOKER_REMOTE_WORKSPACE_PATH:-}" "\${INVOKER_REMOTE_BRANCH:-}")" || true
}

invoker_record_heartbeat() {
  local now
  now=$(invoker_now_iso)
  invoker_append_remote_journal_entry "heartbeat" '{"heartbeatAt":'"$(invoker_json_value "$now")"'}' || true
  printf '%s %s\\n' "$INVOKER_HEARTBEAT_MARKER" "$(date +%s)"
}

invoker_record_output_chunk() {
  local chunk="$1"
  local bytes
  bytes=$(printf '%s' "$chunk" | wc -c | tr -d ' ')
  invoker_append_remote_journal_entry "output_chunk" '{"offset":'"$INVOKER_REMOTE_OUTPUT_OFFSET"',"data":'"$(invoker_json_value "$chunk")"'}' || true
  INVOKER_REMOTE_OUTPUT_OFFSET=$((INVOKER_REMOTE_OUTPUT_OFFSET + bytes))
}

invoker_record_attempt_finished() {
  local exit_code="$1"
  local status="failed"
  local now
  if [ "$exit_code" -eq 0 ]; then
    status="completed"
  fi
  now=$(invoker_now_iso)
  invoker_append_remote_journal_entry "attempt_finished" '{"status":'"$(invoker_json_value "$status")"',"exitCode":'"$exit_code"',"completedAt":'"$(invoker_json_value "$now")"',"workspacePath":'"$(invoker_json_value "\${INVOKER_REMOTE_WORKSPACE_PATH:-}")"',"branch":'"$(invoker_json_value "\${INVOKER_REMOTE_BRANCH:-}")"',"agentName":'"$(invoker_json_value "$INVOKER_REMOTE_AGENT_NAME")"'}'
}

invoker_consume_sync_spool_for_tombstone() {
  [ -f "$INVOKER_REMOTE_SYNC_SPOOL_FILE" ] || return 0
  local size
  size=$(wc -c < "$INVOKER_REMOTE_SYNC_SPOOL_FILE" | tr -d ' ')
  if [ "$size" -le "$INVOKER_REMOTE_SYNC_SPOOL_OFFSET" ]; then
    return 0
  fi
  local chunk
  chunk=$(tail -c +"$((INVOKER_REMOTE_SYNC_SPOOL_OFFSET + 1))" "$INVOKER_REMOTE_SYNC_SPOOL_FILE" 2>/dev/null || true)
  INVOKER_REMOTE_SYNC_SPOOL_OFFSET="$size"
  if printf '%s' "$chunk" | python3 - "$INVOKER_REMOTE_WORKFLOW_ID" <<'PY'
import json
import sys

workflow_id = sys.argv[1]
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        batch = json.loads(line)
    except Exception:
        continue
    for entry in batch.get("entries", []):
        if entry.get("entityType") == "workflow" and entry.get("entityId") == workflow_id and entry.get("op") == "tombstone":
            sys.exit(42)
sys.exit(0)
PY
  then
    return 0
  else
    local status=$?
    if [ "$status" -eq 42 ]; then
      INVOKER_REMOTE_TERMINATE_REQUESTED=1
      return 42
    fi
    return 0
  fi
}
`;
}

export function workResponseToRemoteFinishedJournalEntry(
  context: RemoteProgressJournalContext,
  response: WorkResponse,
  seq: number,
): RemoteProgressJournalEntry {
  return {
    schemaVersion: REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION,
    seq,
    type: 'attempt_finished',
    workflowId: context.workflowId,
    taskId: context.taskId,
    requestId: context.requestId,
    executionGeneration: context.executionGeneration,
    attemptId: context.attemptId,
    createdAt: new Date().toISOString(),
    payload: {
      status: response.status === 'completed' || response.status === 'review_ready' ? 'completed' : 'failed',
      exitCode: response.outputs.exitCode ?? (response.status === 'completed' ? 0 : 1),
      completedAt: new Date().toISOString(),
      error: response.outputs.error,
      commitHash: response.outputs.commitHash,
      agentSessionId: response.outputs.agentSessionId,
      agentName: response.outputs.agentName,
      branch: response.outputs.branch,
      workspacePath: response.outputs.workspacePath,
    },
  };
}
