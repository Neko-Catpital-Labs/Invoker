import {
  DELTA_BATCH_SCHEMA_VERSION,
  type DeltaBatch,
  type SyncJournalEntry,
} from '@invoker/data-store';
import { buildPortableBase64DecodeFunction } from './remote-shell-fragments.js';
import { base64Encode, shellPosixSingleQuote } from './ssh-git-exec.js';

export const REMOTE_PROGRESS_SCHEMA_VERSION = 1;
export const REMOTE_PROGRESS_DIR_RELATIVE = 'runtime/ssh-executor';
export const REMOTE_PROGRESS_JOURNAL_FILENAME = 'progress.journal.ndjson';
export const REMOTE_PROGRESS_SEQUENCE_FILENAME = 'progress.seq';
export const REMOTE_PROGRESS_SPOOL_FILENAME = 'sync-spool.ndjson';
export const REMOTE_PROGRESS_TOMBSTONES_FILENAME = 'workflow-tombstones';
export const SSH_SYNC_PUSH_ACK_PREFIX = '__INVOKER_SSH_SYNC_PUSH_ACK__=';

export type RemoteProgressKind =
  | 'attempt_started'
  | 'heartbeat'
  | 'output'
  | 'attempt_finished';

export interface RemoteProgressJournalEntry {
  schemaVersion: typeof REMOTE_PROGRESS_SCHEMA_VERSION;
  seq: number;
  kind: RemoteProgressKind;
  createdAt: string;
  taskId: string;
  attemptId: string;
  workflowId?: string;
  payload?: Record<string, unknown>;
}

interface EncodedRemoteProgressJournalEntry {
  schemaVersion?: unknown;
  seq?: unknown;
  kind?: unknown;
  createdAt?: unknown;
  taskId?: unknown;
  attemptId?: unknown;
  workflowId?: unknown;
  taskIdB64?: unknown;
  attemptIdB64?: unknown;
  workflowIdB64?: unknown;
  payload?: unknown;
}

function asNonNegativeInteger(name: string, value: unknown): number {
  const out = Number(value);
  if (!Number.isInteger(out) || out < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return out;
}

function text(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function requiredText(value: unknown, name: string): string {
  const out = text(value);
  if (!out) throw new Error(`${name} is required`);
  return out;
}

function decodeBase64Text(value: unknown, fallback?: unknown): string | undefined {
  const encoded = text(value);
  if (encoded !== undefined) return Buffer.from(encoded, 'base64').toString('utf8');
  return text(fallback);
}

function decodePayloadText(payload: Record<string, unknown>, key: string): string | undefined {
  return decodeBase64Text(payload[`${key}B64`], payload[key]);
}

function optionalObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeRemoteEntry(raw: EncodedRemoteProgressJournalEntry): RemoteProgressJournalEntry {
  if (raw.schemaVersion !== REMOTE_PROGRESS_SCHEMA_VERSION) {
    throw new Error(`Unsupported remote progress schema version ${String(raw.schemaVersion)}`);
  }
  const kind = requiredText(raw.kind, 'remote progress kind') as RemoteProgressKind;
  if (
    kind !== 'attempt_started'
    && kind !== 'heartbeat'
    && kind !== 'output'
    && kind !== 'attempt_finished'
  ) {
    throw new Error(`Unsupported remote progress kind ${kind}`);
  }
  return {
    schemaVersion: REMOTE_PROGRESS_SCHEMA_VERSION,
    seq: asNonNegativeInteger('remote progress seq', raw.seq),
    kind,
    createdAt: requiredText(raw.createdAt, 'remote progress createdAt'),
    taskId: requiredText(decodeBase64Text(raw.taskIdB64, raw.taskId), 'remote progress taskId'),
    attemptId: requiredText(decodeBase64Text(raw.attemptIdB64, raw.attemptId), 'remote progress attemptId'),
    workflowId: decodeBase64Text(raw.workflowIdB64, raw.workflowId) || undefined,
    payload: optionalObject(raw.payload),
  };
}

export function parseRemoteProgressJournal(textBlock: string): RemoteProgressJournalEntry[] {
  const entries: RemoteProgressJournalEntry[] = [];
  const lines = textBlock.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `Invalid remote progress journal JSON on line ${index + 1}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid remote progress journal entry on line ${index + 1}`);
    }
    entries.push(normalizeRemoteEntry(parsed as EncodedRemoteProgressJournalEntry));
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

function attemptPayload(entry: RemoteProgressJournalEntry, status: string): Record<string, unknown> {
  const payload = entry.payload ?? {};
  const out: Record<string, unknown> = {
    id: entry.attemptId,
    node_id: entry.taskId,
    attempt_number: 0,
    queue_priority: 0,
    status,
    upstream_attempt_ids: '[]',
    created_at: text(payload.createdAt) ?? entry.createdAt,
  };
  const branch = decodePayloadText(payload, 'branch');
  const workspacePath = decodePayloadText(payload, 'workspacePath');
  const agentSessionId = decodePayloadText(payload, 'agentSessionId');
  const commit = decodePayloadText(payload, 'commit');
  const summary = decodePayloadText(payload, 'summary');
  const error = decodePayloadText(payload, 'error');
  if (branch) out.branch = branch;
  if (workspacePath) out.workspace_path = workspacePath;
  if (agentSessionId) out.agent_session_id = agentSessionId;
  if (commit) out.commit_hash = commit;
  if (summary) out.summary = summary;
  if (error) out.error = error;
  return out;
}

function entryToSyncJournalEntry(entry: RemoteProgressJournalEntry): SyncJournalEntry {
  switch (entry.kind) {
    case 'attempt_started':
      return {
        seq: entry.seq,
        entityType: 'attempt',
        entityId: entry.attemptId,
        op: 'upsert',
        payload: {
          ...attemptPayload(entry, 'running'),
          started_at: entry.createdAt,
          last_heartbeat_at: entry.createdAt,
        },
        origin: 'remote',
        createdAt: entry.createdAt,
      };
    case 'heartbeat':
      return {
        seq: entry.seq,
        entityType: 'attempt',
        entityId: entry.attemptId,
        op: 'upsert',
        payload: {
          ...attemptPayload(entry, 'running'),
          last_heartbeat_at: entry.createdAt,
        },
        origin: 'remote',
        createdAt: entry.createdAt,
      };
    case 'output': {
      const payload = entry.payload ?? {};
      const offset = asNonNegativeInteger('remote output offset', payload.offset);
      const data = decodePayloadText(payload, 'data') ?? '';
      return {
        seq: entry.seq,
        entityType: 'output',
        entityId: `${entry.taskId}:${offset}`,
        op: 'upsert',
        payload: {
          task_id: entry.taskId,
          offset,
          data,
          created_at: entry.createdAt,
        },
        origin: 'remote',
        createdAt: entry.createdAt,
      };
    }
    case 'attempt_finished': {
      const payload = entry.payload ?? {};
      const exitCode = payload.exitCode === undefined ? undefined : Number(payload.exitCode);
      const status = text(payload.status) ?? (exitCode === 0 ? 'completed' : 'failed');
      return {
        seq: entry.seq,
        entityType: 'attempt',
        entityId: entry.attemptId,
        op: 'upsert',
        payload: {
          ...attemptPayload(entry, status),
          completed_at: entry.createdAt,
          ...(Number.isInteger(exitCode) ? { exit_code: exitCode } : {}),
        },
        origin: 'remote',
        createdAt: entry.createdAt,
      };
    }
  }
}

export function remoteProgressEntriesToDeltaBatch(
  entries: readonly RemoteProgressJournalEntry[],
  sinceSeq: number,
): DeltaBatch {
  const cursor = asNonNegativeInteger('sinceSeq', Math.trunc(sinceSeq));
  const sorted = entries
    .filter((entry) => entry.seq > cursor)
    .sort((a, b) => a.seq - b.seq);
  const highWaterSeq = Math.max(cursor, ...sorted.map((entry) => entry.seq));
  return {
    schemaVersion: DELTA_BATCH_SCHEMA_VERSION,
    sinceSeq: cursor,
    highWaterSeq,
    entries: sorted.map((entry) => entryToSyncJournalEntry(entry)),
  };
}

function invokerHomePrelude(invokerHome: string): string {
  const homeB64 = base64Encode(invokerHome);
  return `${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(homeB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
`;
}

export function buildReadRemoteJournalScript(opts: {
  invokerHome: string;
  sinceSeq: number;
  limit?: number;
}): string {
  const sinceSeq = asNonNegativeInteger('sinceSeq', Math.trunc(opts.sinceSeq));
  const limit = asNonNegativeInteger('limit', Math.trunc(opts.limit ?? 500));
  return `set -euo pipefail
${invokerHomePrelude(opts.invokerHome)}
SYNC_DIR="$INVOKER_HOME/${REMOTE_PROGRESS_DIR_RELATIVE}"
JOURNAL_PATH="$SYNC_DIR/${REMOTE_PROGRESS_JOURNAL_FILENAME}"
SINCE_SEQ=${sinceSeq}
LIMIT=${limit}
if [ ! -f "$JOURNAL_PATH" ]; then
  exit 0
fi
awk -v since="$SINCE_SEQ" -v limit="$LIMIT" '
  match($0, /"seq":[[:space:]]*([0-9]+)/, m) {
    if ((m[1] + 0) > since) {
      print
      count += 1
      if (count >= limit) exit
    }
  }
' "$JOURNAL_PATH"
`;
}

export function buildAppendRemoteSpoolScript(opts: {
  invokerHome: string;
  batch: DeltaBatch;
}): string {
  const payload = JSON.stringify(opts.batch);
  const payloadB64 = base64Encode(payload);
  const tombstones = opts.batch.entries
    .filter((entry) => entry.entityType === 'workflow' && entry.op === 'tombstone')
    .map((entry) => entry.entityId);
  const tombstonePayload = tombstones.length > 0 ? `${tombstones.join('\n')}\n` : '';
  const tombstoneB64 = base64Encode(tombstonePayload);

  return `set -euo pipefail
${invokerHomePrelude(opts.invokerHome)}
SYNC_DIR="$INVOKER_HOME/${REMOTE_PROGRESS_DIR_RELATIVE}"
SPOOL_PATH="$SYNC_DIR/${REMOTE_PROGRESS_SPOOL_FILENAME}"
TOMBSTONE_PATH="$SYNC_DIR/${REMOTE_PROGRESS_TOMBSTONES_FILENAME}"
mkdir -p "$SYNC_DIR"
chmod 700 "$SYNC_DIR"
PAYLOAD=$(printf '%s' ${shellPosixSingleQuote(payloadB64)} | invoker_base64_decode)
printf '%s\\n' "$PAYLOAD" >> "$SPOOL_PATH"
if [ -n ${shellPosixSingleQuote(tombstonePayload)} ]; then
  printf '%s' ${shellPosixSingleQuote(tombstoneB64)} | invoker_base64_decode >> "$TOMBSTONE_PATH"
fi
if command -v python3 >/dev/null 2>&1; then
  python3 - "$SPOOL_PATH" "$TOMBSTONE_PATH" <<'PY' >/dev/null 2>&1 || true
import os
import sys
for path in sys.argv[1:]:
    if not os.path.exists(path):
        continue
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
PY
else
  sync -f "$SPOOL_PATH" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
fi
printf '${SSH_SYNC_PUSH_ACK_PREFIX}%s\\n' ${opts.batch.highWaterSeq}
`;
}

export function buildRemoteProgressJournalBash(): string {
  return `
invoker_progress_base64_encode() {
  if base64 --help 2>/dev/null | grep -q -- '-w'; then
    base64 -w 0
  elif base64 -b 0 </dev/null >/dev/null 2>&1; then
    base64 -b 0
  elif command -v openssl >/dev/null 2>&1; then
    openssl base64 -A
  else
    base64 | tr -d '\\n'
  fi
}

invoker_progress_now_iso() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

invoker_progress_file_sync() {
  local path="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$path" <<'PY' >/dev/null 2>&1 || true
import os
import sys
path = sys.argv[1]
fd = os.open(path, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
  else
    sync -f "$path" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
  fi
}

invoker_progress_with_lock() {
  local lock_dir="$INVOKER_PROGRESS_SYNC_DIR/progress.lock"
  local waited=0
  mkdir -p "$INVOKER_PROGRESS_SYNC_DIR"
  until mkdir "$lock_dir" 2>/dev/null; do
    sleep 0.05
    waited=$((waited + 1))
    if [ "$waited" -gt 600 ]; then
      echo "[SshExecutor] timed out waiting for remote progress journal lock" >&2
      return 1
    fi
  done
  "$@"
  local rc=$?
  rmdir "$lock_dir" >/dev/null 2>&1 || true
  return "$rc"
}

invoker_progress_append_locked() {
  local kind="$1"
  local payload_json="$2"
  local seq=0
  if [ -f "$INVOKER_PROGRESS_SEQ_PATH" ]; then
    seq=$(cat "$INVOKER_PROGRESS_SEQ_PATH" 2>/dev/null || printf '0')
  fi
  case "$seq" in
    ''|*[!0-9]*) seq=0 ;;
  esac
  seq=$((seq + 1))
  printf '%s' "$seq" > "$INVOKER_PROGRESS_SEQ_PATH.tmp.$$"
  mv "$INVOKER_PROGRESS_SEQ_PATH.tmp.$$" "$INVOKER_PROGRESS_SEQ_PATH"
  local task_b64 attempt_b64 workflow_b64 created_at
  task_b64=$(printf '%s' "$INVOKER_TASK_ID" | invoker_progress_base64_encode)
  attempt_b64=$(printf '%s' "$INVOKER_ATTEMPT_ID" | invoker_progress_base64_encode)
  workflow_b64=$(printf '%s' "\${INVOKER_WORKFLOW_ID:-}" | invoker_progress_base64_encode)
  created_at=$(invoker_progress_now_iso)
  printf '{"schemaVersion":1,"seq":%s,"kind":"%s","taskIdB64":"%s","attemptIdB64":"%s","workflowIdB64":"%s","createdAt":"%s","payload":%s}\\n' \\
    "$seq" "$kind" "$task_b64" "$attempt_b64" "$workflow_b64" "$created_at" "$payload_json" >> "$INVOKER_PROGRESS_JOURNAL_PATH"
  invoker_progress_file_sync "$INVOKER_PROGRESS_JOURNAL_PATH"
}

invoker_progress_append() {
  invoker_progress_with_lock invoker_progress_append_locked "$@" || true
}

invoker_progress_payload_field_b64() {
  local value="$1"
  printf '%s' "$value" | invoker_progress_base64_encode
}

invoker_progress_attempt_started() {
  local branch_b64 workspace_b64 agent_b64
  branch_b64=$(invoker_progress_payload_field_b64 "\${INVOKER_REMOTE_BRANCH:-}")
  workspace_b64=$(invoker_progress_payload_field_b64 "\${INVOKER_REMOTE_WORKSPACE_PATH:-}")
  agent_b64=$(invoker_progress_payload_field_b64 "\${INVOKER_AGENT_SESSION_ID:-}")
  invoker_progress_append "attempt_started" "{\\"branchB64\\":\\"$branch_b64\\",\\"workspacePathB64\\":\\"$workspace_b64\\",\\"agentSessionIdB64\\":\\"$agent_b64\\"}"
}

invoker_progress_heartbeat() {
  invoker_progress_append "heartbeat" "{}"
}

invoker_progress_output_locked() {
  local data_b64="$1"
  local len="$2"
  local offset=0
  if [ -f "$INVOKER_PROGRESS_OUTPUT_OFFSET_PATH" ]; then
    offset=$(cat "$INVOKER_PROGRESS_OUTPUT_OFFSET_PATH" 2>/dev/null || printf '0')
  fi
  case "$offset" in
    ''|*[!0-9]*) offset=0 ;;
  esac
  printf '%s' "$((offset + len))" > "$INVOKER_PROGRESS_OUTPUT_OFFSET_PATH.tmp.$$"
  mv "$INVOKER_PROGRESS_OUTPUT_OFFSET_PATH.tmp.$$" "$INVOKER_PROGRESS_OUTPUT_OFFSET_PATH"
  invoker_progress_append_locked "output" "{\\"offset\\":$offset,\\"dataB64\\":\\"$data_b64\\"}"
}

invoker_progress_output() {
  local chunk="$1"
  local len data_b64
  len=$(printf '%s' "$chunk" | wc -c | tr -d '[:space:]')
  data_b64=$(printf '%s' "$chunk" | invoker_progress_base64_encode)
  invoker_progress_with_lock invoker_progress_output_locked "$data_b64" "$len" || true
}

invoker_progress_stream_stdout() {
  local line chunk
  while IFS= read -r line || [ -n "$line" ]; do
    chunk="${line}"$'\\n'
    printf '%s' "$chunk"
    invoker_progress_output "$chunk"
  done
}

invoker_progress_stream_stderr() {
  local line chunk
  while IFS= read -r line || [ -n "$line" ]; do
    chunk="${line}"$'\\n'
    printf '%s' "$chunk" >&2
    invoker_progress_output "$chunk"
  done
}

invoker_progress_attempt_finished() {
  local exit_code="$1"
  local error_message="\${2:-}"
  local status="completed"
  if [ "$exit_code" -ne 0 ]; then
    status="failed"
  fi
  local branch_b64 workspace_b64 agent_b64 error_b64
  branch_b64=$(invoker_progress_payload_field_b64 "\${INVOKER_REMOTE_BRANCH:-}")
  workspace_b64=$(invoker_progress_payload_field_b64 "\${INVOKER_REMOTE_WORKSPACE_PATH:-}")
  agent_b64=$(invoker_progress_payload_field_b64 "\${INVOKER_AGENT_SESSION_ID:-}")
  error_b64=$(invoker_progress_payload_field_b64 "$error_message")
  invoker_progress_append "attempt_finished" "{\\"status\\":\\"$status\\",\\"exitCode\\":$exit_code,\\"branchB64\\":\\"$branch_b64\\",\\"workspacePathB64\\":\\"$workspace_b64\\",\\"agentSessionIdB64\\":\\"$agent_b64\\",\\"errorB64\\":\\"$error_b64\\"}"
}

invoker_progress_has_workflow_tombstone() {
  [ -n "\${INVOKER_WORKFLOW_ID:-}" ] || return 1
  [ -f "$INVOKER_PROGRESS_TOMBSTONE_PATH" ] || return 1
  grep -F -x -- "$INVOKER_WORKFLOW_ID" "$INVOKER_PROGRESS_TOMBSTONE_PATH" >/dev/null 2>&1
}
`;
}
