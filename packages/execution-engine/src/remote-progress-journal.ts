import type { DeltaBatch, SyncJournalEntry } from '@invoker/data-store';

export const REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION = 1;
export const REMOTE_PROGRESS_JOURNAL_DIRNAME = 'journals';
export const REMOTE_PROGRESS_SPOOL_DIRNAME = 'spool';

export type RemoteProgressJournalKind =
  | 'attempt_started'
  | 'heartbeat'
  | 'output_chunk'
  | 'attempt_finished';

export interface RemoteProgressJournalEntry {
  schemaVersion: typeof REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION;
  seq: number;
  kind: RemoteProgressJournalKind;
  taskId: string;
  attemptId: string;
  executionId: string;
  workflowId?: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

export interface RemoteProgressJournalShellOptions {
  runtimeDirVariable: string;
  journalToken: string;
  workflowId?: string;
  taskId: string;
  attemptId: string;
  executionId: string;
  branch?: string;
  workspacePath?: string;
}

export interface RemoteProgressDeltaOptions {
  sinceSeq: number;
  taskPayloadFor?: (taskId: string) => Record<string, unknown> | undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function jsonShellValue(value: string | undefined): string {
  return shellQuote(JSON.stringify(value ?? null));
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`remote progress journal entry requires ${name}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function decodePayload(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('remote progress journal payload must be an object');
}

function decodePayloadBase64(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (!decoded) return {};
  return decodePayload(JSON.parse(decoded));
}

export function encodeRemoteProgressPayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function serializeRemoteProgressJournalEntry(
  entry: Omit<RemoteProgressJournalEntry, 'schemaVersion'>,
): string {
  return JSON.stringify({
    ...entry,
    schemaVersion: REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION,
    payloadBase64: encodeRemoteProgressPayload(entry.payload ?? {}),
    payload: undefined,
  });
}

export function parseRemoteProgressJournalLines(text: string): RemoteProgressJournalEntry[] {
  const entries: RemoteProgressJournalEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const seq = Number(raw.seq);
    if (!Number.isInteger(seq) || seq <= 0) continue;
    const schemaVersion = Number(raw.schemaVersion ?? REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION);
    if (schemaVersion !== REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION) continue;
    const kind = raw.kind as RemoteProgressJournalKind;
    if (
      kind !== 'attempt_started'
      && kind !== 'heartbeat'
      && kind !== 'output_chunk'
      && kind !== 'attempt_finished'
    ) {
      continue;
    }

    const payload = raw.payloadBase64 !== undefined
      ? decodePayloadBase64(raw.payloadBase64)
      : decodePayload(raw.payload);

    entries.push({
      schemaVersion: REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION,
      seq,
      kind,
      taskId: requiredString(raw.taskId, 'taskId'),
      attemptId: requiredString(raw.attemptId, 'attemptId'),
      executionId: requiredString(raw.executionId, 'executionId'),
      workflowId: optionalString(raw.workflowId),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      payload,
    });
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

function attemptPayload(entry: RemoteProgressJournalEntry): Record<string, unknown> {
  const payload = entry.payload ?? {};
  const status = entry.kind === 'attempt_finished'
    ? String(payload.status ?? (integer(payload.exitCode) === 0 ? 'completed' : 'failed'))
    : 'running';
  const exitCode = integer(payload.exitCode);
  const row: Record<string, unknown> = {
    id: entry.attemptId,
    node_id: entry.taskId,
    attempt_number: integer(payload.attemptNumber) ?? 0,
    queue_priority: integer(payload.queuePriority) ?? 0,
    status,
    upstream_attempt_ids: '[]',
    created_at: String(payload.startedAt ?? entry.createdAt),
    started_at: String(payload.startedAt ?? entry.createdAt),
    last_heartbeat_at: entry.createdAt,
  };
  if (entry.kind === 'attempt_finished') {
    row.completed_at = String(payload.completedAt ?? entry.createdAt);
    if (exitCode !== undefined) row.exit_code = exitCode;
    if (typeof payload.error === 'string' && payload.error.length > 0) row.error = payload.error;
  }
  if (typeof payload.branch === 'string') row.branch = payload.branch;
  if (typeof payload.workspacePath === 'string') row.workspace_path = payload.workspacePath;
  if (typeof payload.agentSessionId === 'string') row.agent_session_id = payload.agentSessionId;
  return row;
}

function taskCompletionPayload(
  entry: RemoteProgressJournalEntry,
  taskPayloadFor: ((taskId: string) => Record<string, unknown> | undefined) | undefined,
): Record<string, unknown> | undefined {
  if (entry.kind !== 'attempt_finished' || !entry.workflowId || !taskPayloadFor) return undefined;
  const existing = taskPayloadFor(entry.taskId);
  if (!existing) return undefined;
  const payload = entry.payload ?? {};
  const exitCode = integer(payload.exitCode);
  const status = String(payload.status ?? (exitCode === 0 ? 'completed' : 'failed'));
  return {
    ...existing,
    status,
    completed_at: String(payload.completedAt ?? entry.createdAt),
    last_heartbeat_at: entry.createdAt,
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(typeof payload.error === 'string' && payload.error.length > 0 ? { error: payload.error } : {}),
  };
}

function outputPayload(entry: RemoteProgressJournalEntry): Record<string, unknown> {
  const payload = entry.payload ?? {};
  const data = typeof payload.data === 'string'
    ? payload.data
    : typeof payload.dataBase64 === 'string'
      ? Buffer.from(payload.dataBase64, 'base64').toString('utf8')
      : '';
  const offset = integer(payload.offset) ?? 0;
  return {
    task_id: entry.taskId,
    offset,
    data,
    created_at: entry.createdAt,
  };
}

export function remoteProgressEntriesToDeltaBatch(
  entries: RemoteProgressJournalEntry[],
  options: RemoteProgressDeltaOptions,
): DeltaBatch {
  const sinceSeq = Math.max(0, Math.trunc(options.sinceSeq));
  const selected = entries
    .filter((entry) => entry.seq > sinceSeq)
    .sort((a, b) => a.seq - b.seq);
  const deltaEntries: SyncJournalEntry[] = [];

  for (const entry of selected) {
    if (entry.kind === 'output_chunk') {
      const payload = outputPayload(entry);
      deltaEntries.push({
        seq: entry.seq,
        entityType: 'output',
        entityId: `${entry.taskId}:${String(payload.offset)}`,
        op: 'upsert',
        payload,
        origin: 'ssh-remote',
        createdAt: entry.createdAt,
      });
      continue;
    }

    deltaEntries.push({
      seq: entry.seq,
      entityType: 'attempt',
      entityId: entry.attemptId,
      op: 'upsert',
      payload: attemptPayload(entry),
      origin: 'ssh-remote',
      createdAt: entry.createdAt,
    });

    const taskPayload = taskCompletionPayload(entry, options.taskPayloadFor);
    if (taskPayload) {
      deltaEntries.push({
        seq: entry.seq,
        entityType: 'task',
        entityId: entry.taskId,
        op: 'upsert',
        payload: taskPayload,
        origin: 'ssh-remote',
        createdAt: entry.createdAt,
      });
    }
  }

  return {
    schemaVersion: 1,
    sinceSeq,
    highWaterSeq: Math.max(sinceSeq, ...selected.map((entry) => entry.seq)),
    entries: deltaEntries,
  };
}

export function buildRemoteProgressJournalShell(options: RemoteProgressJournalShellOptions): string {
  const workflowId = options.workflowId?.trim() || undefined;
  const branchPayload = options.branch ? `,"branch":${JSON.stringify(options.branch)}` : '';
  const workspacePayload = options.workspacePath ? `,"workspacePath":${JSON.stringify(options.workspacePath)}` : '';
  return `INVOKER_REMOTE_JOURNAL_SCHEMA_VERSION=${REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION}
INVOKER_REMOTE_JOURNAL_DIR="$${options.runtimeDirVariable}/${REMOTE_PROGRESS_JOURNAL_DIRNAME}"
INVOKER_REMOTE_JOURNAL_PATH="$INVOKER_REMOTE_JOURNAL_DIR/${options.journalToken}.ndjson"
INVOKER_REMOTE_GLOBAL_SEQ_PATH="$INVOKER_REMOTE_JOURNAL_DIR/global.seq"
INVOKER_REMOTE_SPOOL_DIR="$${options.runtimeDirVariable}/${REMOTE_PROGRESS_SPOOL_DIRNAME}"
INVOKER_REMOTE_SPOOL_PATH="$INVOKER_REMOTE_SPOOL_DIR/home.delta.json"
INVOKER_REMOTE_OUTPUT_OFFSET_PATH="$INVOKER_REMOTE_JOURNAL_DIR/${options.journalToken}.output.offset"
INVOKER_REMOTE_WORKFLOW_ID=${shellQuote(workflowId ?? '')}
INVOKER_REMOTE_WORKFLOW_ID_JSON=${jsonShellValue(workflowId)}
INVOKER_REMOTE_TASK_ID_JSON=${jsonShellValue(options.taskId)}
INVOKER_REMOTE_ATTEMPT_ID_JSON=${jsonShellValue(options.attemptId)}
INVOKER_REMOTE_EXECUTION_ID_JSON=${jsonShellValue(options.executionId)}
INVOKER_REMOTE_ATTEMPT_STARTED_PAYLOAD=${shellQuote(`{"status":"running"${branchPayload}${workspacePayload}}`)}
INVOKER_REMOTE_ATTEMPT_FINISHED_EXTRA_PAYLOAD=${shellQuote(`{${branchPayload.slice(1)}${branchPayload && workspacePayload ? ',' : ''}${workspacePayload.slice(1)}}`)}
export INVOKER_REMOTE_JOURNAL_SCHEMA_VERSION
export INVOKER_REMOTE_JOURNAL_DIR
export INVOKER_REMOTE_JOURNAL_PATH
export INVOKER_REMOTE_GLOBAL_SEQ_PATH
export INVOKER_REMOTE_SPOOL_DIR
export INVOKER_REMOTE_SPOOL_PATH
export INVOKER_REMOTE_OUTPUT_OFFSET_PATH
export INVOKER_REMOTE_WORKFLOW_ID
export INVOKER_REMOTE_WORKFLOW_ID_JSON
export INVOKER_REMOTE_TASK_ID_JSON
export INVOKER_REMOTE_ATTEMPT_ID_JSON
export INVOKER_REMOTE_EXECUTION_ID_JSON
export INVOKER_REMOTE_ATTEMPT_STARTED_PAYLOAD
export INVOKER_REMOTE_ATTEMPT_FINISHED_EXTRA_PAYLOAD

invoker_remote_base64_encode() {
  if base64 -w 0 </dev/null >/dev/null 2>&1; then
    base64 -w 0
  elif base64 -b 0 </dev/null >/dev/null 2>&1; then
    base64 -b 0
  else
    base64 | tr -d '\\n'
  fi
}

invoker_remote_now_iso() {
  date -u '+%Y-%m-%dT%H:%M:%S.000Z'
}

invoker_remote_next_seq() {
  mkdir -p "$INVOKER_REMOTE_JOURNAL_DIR"
  local lock_path="$INVOKER_REMOTE_GLOBAL_SEQ_PATH.lock"
  if command -v flock >/dev/null 2>&1; then
    (
      flock 9
      local current=0
      if [ -f "$INVOKER_REMOTE_GLOBAL_SEQ_PATH" ]; then
        current=$(cat "$INVOKER_REMOTE_GLOBAL_SEQ_PATH" 2>/dev/null || printf '0')
      fi
      case "$current" in ''|*[!0-9]*) current=0 ;; esac
      current=$((current + 1))
      printf '%s' "$current" > "$INVOKER_REMOTE_GLOBAL_SEQ_PATH"
      printf '%s' "$current"
    ) 9>"$lock_path"
  else
    local current=0
    if [ -f "$INVOKER_REMOTE_GLOBAL_SEQ_PATH" ]; then
      current=$(cat "$INVOKER_REMOTE_GLOBAL_SEQ_PATH" 2>/dev/null || printf '0')
    fi
    case "$current" in ''|*[!0-9]*) current=0 ;; esac
    current=$((current + 1))
    printf '%s' "$current" > "$INVOKER_REMOTE_GLOBAL_SEQ_PATH"
    printf '%s' "$current"
  fi
}

invoker_remote_next_output_offset() {
  local bytes="$1"
  mkdir -p "$INVOKER_REMOTE_JOURNAL_DIR"
  local lock_path="$INVOKER_REMOTE_OUTPUT_OFFSET_PATH.lock"
  if command -v flock >/dev/null 2>&1; then
    (
      flock 9
      local current=0
      if [ -f "$INVOKER_REMOTE_OUTPUT_OFFSET_PATH" ]; then
        current=$(cat "$INVOKER_REMOTE_OUTPUT_OFFSET_PATH" 2>/dev/null || printf '0')
      fi
      case "$current" in ''|*[!0-9]*) current=0 ;; esac
      printf '%s' $((current + bytes)) > "$INVOKER_REMOTE_OUTPUT_OFFSET_PATH"
      printf '%s' "$current"
    ) 9>"$lock_path"
  else
    local current=0
    if [ -f "$INVOKER_REMOTE_OUTPUT_OFFSET_PATH" ]; then
      current=$(cat "$INVOKER_REMOTE_OUTPUT_OFFSET_PATH" 2>/dev/null || printf '0')
    fi
    case "$current" in ''|*[!0-9]*) current=0 ;; esac
    printf '%s' $((current + bytes)) > "$INVOKER_REMOTE_OUTPUT_OFFSET_PATH"
    printf '%s' "$current"
  fi
}

invoker_remote_append_journal() {
  local kind="$1"
  local payload_b64="$2"
  mkdir -p "$INVOKER_REMOTE_JOURNAL_DIR"
  local seq
  seq=$(invoker_remote_next_seq)
  local created_at
  created_at=$(invoker_remote_now_iso)
  printf '{"schemaVersion":%s,"seq":%s,"kind":"%s","workflowId":%s,"taskId":%s,"attemptId":%s,"executionId":%s,"createdAt":"%s","payloadBase64":"%s"}\\n' \\
    "$INVOKER_REMOTE_JOURNAL_SCHEMA_VERSION" \\
    "$seq" \\
    "$kind" \\
    "$INVOKER_REMOTE_WORKFLOW_ID_JSON" \\
    "$INVOKER_REMOTE_TASK_ID_JSON" \\
    "$INVOKER_REMOTE_ATTEMPT_ID_JSON" \\
    "$INVOKER_REMOTE_EXECUTION_ID_JSON" \\
    "$created_at" \\
    "$payload_b64" >> "$INVOKER_REMOTE_JOURNAL_PATH"
  sync -f "$INVOKER_REMOTE_JOURNAL_PATH" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
}

invoker_remote_append_attempt_started() {
  local payload_b64
  payload_b64=$(printf '%s' "$INVOKER_REMOTE_ATTEMPT_STARTED_PAYLOAD" | invoker_remote_base64_encode)
  invoker_remote_append_journal attempt_started "$payload_b64"
}

invoker_remote_append_heartbeat_checkpoint() {
  local payload_b64
  payload_b64=$(printf '{"status":"running"}' | invoker_remote_base64_encode)
  invoker_remote_append_journal heartbeat "$payload_b64"
}

invoker_remote_append_attempt_finished() {
  local exit_code="$1"
  local status="completed"
  local error_json=""
  if [ "$exit_code" != "0" ]; then
    status="failed"
    if [ "\${INVOKER_REMOTE_TERMINATED_BY_TOMBSTONE:-}" = "1" ]; then
      error_json=',"error":"terminated by workflow tombstone"'
    fi
  fi
  local extra=""
  if [ "$INVOKER_REMOTE_ATTEMPT_FINISHED_EXTRA_PAYLOAD" != "{}" ]; then
    local trimmed_extra="\${INVOKER_REMOTE_ATTEMPT_FINISHED_EXTRA_PAYLOAD#\\{}"
    trimmed_extra="\${trimmed_extra%\\}}"
    if [ -n "$trimmed_extra" ]; then
      extra=",$trimmed_extra"
    fi
  fi
  local payload_b64
  payload_b64=$(printf '{"status":"%s","exitCode":%s%s%s}' "$status" "$exit_code" "$error_json" "$extra" | invoker_remote_base64_encode)
  invoker_remote_append_journal attempt_finished "$payload_b64"
}

invoker_remote_append_output_chunk() {
  local stream="$1"
  local data="$2"
  local bytes
  bytes=$(printf '%s' "$data" | wc -c | tr -d ' ')
  local offset
  offset=$(invoker_remote_next_output_offset "$bytes")
  local data_b64
  data_b64=$(printf '%s' "$data" | invoker_remote_base64_encode)
  local payload_b64
  payload_b64=$(printf '{"stream":"%s","offset":%s,"dataBase64":"%s"}' "$stream" "$offset" "$data_b64" | invoker_remote_base64_encode)
  invoker_remote_append_journal output_chunk "$payload_b64"
}

invoker_remote_stream_output() {
  local stream="$1"
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    local chunk="$line"$'\\n'
    invoker_remote_append_output_chunk "$stream" "$chunk"
    if [ "$stream" = "stderr" ]; then
      printf '%s\\n' "$line" >&2
    else
      printf '%s\\n' "$line"
    fi
  done
}

invoker_remote_should_stop_for_tombstone() {
  [ -n "$INVOKER_REMOTE_WORKFLOW_ID" ] || return 1
  [ -s "$INVOKER_REMOTE_SPOOL_PATH" ] || return 1
  grep -F '"entityType":"workflow"' "$INVOKER_REMOTE_SPOOL_PATH" >/dev/null 2>&1 || grep -F '"entity_type":"workflow"' "$INVOKER_REMOTE_SPOOL_PATH" >/dev/null 2>&1 || return 1
  grep -F '"op":"tombstone"' "$INVOKER_REMOTE_SPOOL_PATH" >/dev/null 2>&1 || return 1
  grep -F "$INVOKER_REMOTE_WORKFLOW_ID" "$INVOKER_REMOTE_SPOOL_PATH" >/dev/null 2>&1
}

export -f invoker_remote_base64_encode
export -f invoker_remote_now_iso
export -f invoker_remote_next_seq
export -f invoker_remote_next_output_offset
export -f invoker_remote_append_journal
export -f invoker_remote_append_attempt_started
export -f invoker_remote_append_heartbeat_checkpoint
export -f invoker_remote_append_attempt_finished
export -f invoker_remote_append_output_chunk
export -f invoker_remote_stream_output
export -f invoker_remote_should_stop_for_tombstone
`;
}
