import {
  DELTA_BATCH_SCHEMA_VERSION,
  type DeltaBatch,
  type SyncJournalEntry,
} from '@invoker/data-store';
import { buildPortableBase64DecodeFunction } from './remote-shell-fragments.js';
import { base64Encode, shellPosixSingleQuote } from './ssh-git-exec.js';
import { buildSourceInvokerEnvScript } from './remote-shell-fragments.js';

export const REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION = 1;
export const REMOTE_PROGRESS_BASE_RELATIVE_DIR = 'runtime/ssh-executor';
export const REMOTE_PROGRESS_JOURNAL_FILE = 'progress-journal.ndjson';
export const REMOTE_PROGRESS_JOURNAL_SEQ_FILE = 'progress-journal.seq';
export const REMOTE_HOME_DELTA_SPOOL_FILE = 'home-delta-spool.ndjson';

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
  attemptId?: string;
  workflowId?: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

export interface RemoteProgressDeltaOptions {
  sinceSeq: number;
  entries: RemoteProgressJournalEntry[];
}

function asNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function text(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return String(value);
}

function requiredText(value: unknown, name: string): string {
  const out = text(value);
  if (!out) throw new Error(`${name} is required`);
  return out;
}

function integer(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const out = Number(value);
  return Number.isInteger(out) ? out : undefined;
}

function decodeDataBase64(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  return Buffer.from(raw, 'base64').toString('utf8');
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeRemoteEntry(value: unknown): RemoteProgressJournalEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('remote progress journal line must be a JSON object');
  }
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION) {
    throw new Error(`Unsupported remote progress journal schema version ${String(row.schemaVersion)}`);
  }
  const seq = Number(row.seq);
  asNonNegativeInteger('remote progress seq', seq);
  if (seq <= 0) throw new Error('remote progress seq must be positive');
  const kind = String(row.kind) as RemoteProgressJournalKind;
  if (!['attempt_started', 'heartbeat', 'output_chunk', 'attempt_finished'].includes(kind)) {
    throw new Error(`Unsupported remote progress journal kind ${String(row.kind)}`);
  }
  const taskId = requiredText(row.taskId, 'remote progress taskId');
  const createdAt = requiredText(row.createdAt, 'remote progress createdAt');
  return {
    schemaVersion: REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION,
    seq,
    kind,
    taskId,
    attemptId: text(row.attemptId),
    workflowId: text(row.workflowId),
    createdAt,
    payload: normalizePayload(row.payload),
  };
}

export function parseRemoteProgressJournalLine(line: string): RemoteProgressJournalEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  return normalizeRemoteEntry(JSON.parse(trimmed));
}

export function parseRemoteProgressJournalLines(textValue: string): RemoteProgressJournalEntry[] {
  const entries: RemoteProgressJournalEntry[] = [];
  for (const line of textValue.split('\n')) {
    const parsed = parseRemoteProgressJournalLine(line);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

function syncEntry(
  seq: number,
  entityType: SyncJournalEntry['entityType'],
  entityId: string,
  payload: unknown,
  createdAt: string,
): SyncJournalEntry {
  return {
    seq,
    entityType,
    entityId,
    op: 'upsert',
    payload,
    origin: 'ssh-remote',
    createdAt,
  };
}

function mapAttemptStarted(entry: RemoteProgressJournalEntry): SyncJournalEntry[] {
  const attemptId = text(entry.attemptId);
  if (!attemptId) return [];
  return [
    syncEntry(
      entry.seq,
      'attempt',
      attemptId,
      {
        id: attemptId,
        node_id: entry.taskId,
        status: 'running',
        started_at: entry.createdAt,
        last_heartbeat_at: entry.createdAt,
        workspace_path: text(entry.payload?.workspacePath),
        branch: text(entry.payload?.branch),
        agent_session_id: text(entry.payload?.agentSessionId),
      },
      entry.createdAt,
    ),
  ];
}

function mapHeartbeat(entry: RemoteProgressJournalEntry): SyncJournalEntry[] {
  const attemptId = text(entry.attemptId);
  if (!attemptId) return [];
  return [
    syncEntry(
      entry.seq,
      'attempt',
      attemptId,
      {
        id: attemptId,
        node_id: entry.taskId,
        status: 'running',
        last_heartbeat_at: entry.createdAt,
      },
      entry.createdAt,
    ),
  ];
}

function mapOutputChunk(entry: RemoteProgressJournalEntry): SyncJournalEntry[] {
  const data = text(entry.payload?.data) ?? decodeDataBase64(entry.payload?.dataBase64);
  if (data === undefined) return [];
  return [
    syncEntry(
      entry.seq,
      'output',
      `${entry.taskId}:${entry.seq}`,
      {
        task_id: entry.taskId,
        offset: integer(entry.payload?.offset) ?? entry.seq,
        data,
        created_at: entry.createdAt,
      },
      entry.createdAt,
    ),
  ];
}

function normalizeFinishedStatus(value: unknown): 'completed' | 'failed' | 'cancelled' {
  const raw = String(value ?? '').toLowerCase();
  if (raw === 'completed') return 'completed';
  if (raw === 'cancelled' || raw === 'canceled') return 'cancelled';
  return 'failed';
}

function mapAttemptFinished(entry: RemoteProgressJournalEntry): SyncJournalEntry[] {
  const attemptId = text(entry.attemptId);
  if (!attemptId) return [];
  const status = normalizeFinishedStatus(entry.payload?.status);
  const exitCode = integer(entry.payload?.exitCode);
  const error = text(entry.payload?.error);
  const out: SyncJournalEntry[] = [
    syncEntry(
      entry.seq,
      'attempt',
      attemptId,
      {
        id: attemptId,
        node_id: entry.taskId,
        status,
        completed_at: entry.createdAt,
        last_heartbeat_at: entry.createdAt,
        exit_code: exitCode,
        error,
        branch: text(entry.payload?.branch),
        commit_hash: text(entry.payload?.commitHash),
        summary: text(entry.payload?.summary),
        workspace_path: text(entry.payload?.workspacePath),
        agent_session_id: text(entry.payload?.agentSessionId),
      },
      entry.createdAt,
    ),
  ];

  if (entry.workflowId) {
    out.push(
      syncEntry(
        entry.seq,
        'task',
        entry.taskId,
        {
          id: entry.taskId,
          workflow_id: entry.workflowId,
          status: status === 'completed' ? 'completed' : 'failed',
          completed_at: entry.createdAt,
          exit_code: exitCode,
          error,
          branch: text(entry.payload?.branch),
          commit_hash: text(entry.payload?.commitHash),
          workspace_path: text(entry.payload?.workspacePath),
          agent_session_id: text(entry.payload?.agentSessionId),
        },
        entry.createdAt,
      ),
    );
  }
  return out;
}

function mapRemoteEntryToSyncEntries(entry: RemoteProgressJournalEntry): SyncJournalEntry[] {
  switch (entry.kind) {
    case 'attempt_started':
      return mapAttemptStarted(entry);
    case 'heartbeat':
      return mapHeartbeat(entry);
    case 'output_chunk':
      return mapOutputChunk(entry);
    case 'attempt_finished':
      return mapAttemptFinished(entry);
    default:
      return [];
  }
}

export function remoteProgressEntriesToDeltaBatch(options: RemoteProgressDeltaOptions): DeltaBatch {
  const sinceSeq = asNonNegativeInteger('sinceSeq', Math.trunc(options.sinceSeq));
  const sortedEntries = [...options.entries].sort((a, b) => a.seq - b.seq);
  const highWaterSeq = Math.max(sinceSeq, ...sortedEntries.map((entry) => entry.seq));
  const entries = sortedEntries
    .filter((entry) => entry.seq > sinceSeq)
    .flatMap((entry) => mapRemoteEntryToSyncEntries(entry));

  return {
    schemaVersion: DELTA_BATCH_SCHEMA_VERSION,
    sinceSeq,
    highWaterSeq,
    entries,
  };
}

export function remoteProgressBaseDirExpression(invokerHomeVar = 'INVOKER_HOME'): string {
  return `$${invokerHomeVar}/${REMOTE_PROGRESS_BASE_RELATIVE_DIR}`;
}

export function buildRemoteProgressJournalEnvScript(invokerHomeVar = 'INVOKER_HOME'): string {
  const base = remoteProgressBaseDirExpression(invokerHomeVar);
  return `INVOKER_PROGRESS_BASE_DIR="${base}"
INVOKER_PROGRESS_JOURNAL_PATH="$INVOKER_PROGRESS_BASE_DIR/${REMOTE_PROGRESS_JOURNAL_FILE}"
INVOKER_PROGRESS_JOURNAL_SEQ_PATH="$INVOKER_PROGRESS_BASE_DIR/${REMOTE_PROGRESS_JOURNAL_SEQ_FILE}"
INVOKER_DELTA_SPOOL_PATH="$INVOKER_PROGRESS_BASE_DIR/${REMOTE_HOME_DELTA_SPOOL_FILE}"
mkdir -p "$INVOKER_PROGRESS_BASE_DIR"
`;
}

export function buildRemoteProgressJournalShellFunctions(options: {
  heartbeatMarker: string;
}): string {
  const heartbeatMarker = options.heartbeatMarker.replace(/'/g, `'\\''`);
  return `${buildPortableBase64DecodeFunction('invoker_progress_base64_decode')}
invoker_progress_json_escape() {
  printf '%s' "$1" | sed \\
    -e 's/\\\\/\\\\\\\\/g' \\
    -e 's/"/\\\\"/g' \\
    -e 's/	/\\\\t/g'
}
invoker_progress_now_iso() {
  date -u '+%Y-%m-%dT%H:%M:%S.000Z'
}
invoker_progress_base64_one_line() {
  base64 | tr -d '\\n'
}
invoker_progress_sync_file() {
  if sync -f "$1" >/dev/null 2>&1; then
    return 0
  fi
  return 0
}
invoker_progress_append_locked() {
  local line="$1"
  local seq=0
  if [ -f "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH" ]; then
    read -r seq < "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH" || seq=0
  fi
  if ! [[ "$seq" =~ ^[0-9]+$ ]]; then
    seq=0
  fi
  seq=$((seq + 1))
  printf '%s\\n' "$seq" > "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH.tmp.$$"
  mv "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH.tmp.$$" "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH"
  printf '%s\\n' "\${line/__INVOKER_PROGRESS_SEQ__/$seq}" >> "$INVOKER_PROGRESS_JOURNAL_PATH"
  invoker_progress_sync_file "$INVOKER_PROGRESS_JOURNAL_PATH"
}
invoker_progress_append() {
  local line="$1"
  mkdir -p "$INVOKER_PROGRESS_BASE_DIR"
  if command -v flock >/dev/null 2>&1; then
    (
      flock -x 9
      invoker_progress_append_locked "$line"
    ) 9>>"$INVOKER_PROGRESS_JOURNAL_PATH.lock"
    return $?
  fi
  local lock_dir="$INVOKER_PROGRESS_JOURNAL_PATH.lockdir"
  local waited=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    sleep 0.05
    waited=$((waited + 1))
    if [ "$waited" -gt 200 ]; then
      return 1
    fi
  done
  invoker_progress_append_locked "$line"
  rmdir "$lock_dir" 2>/dev/null || true
}
invoker_progress_entry() {
  local kind="$1"
  local payload_json="$2"
  local created_at
  created_at=$(invoker_progress_now_iso)
  local task_id attempt_id workflow_id
  task_id=$(invoker_progress_json_escape "\${INVOKER_TASK_ID:-}")
  attempt_id=$(invoker_progress_json_escape "\${INVOKER_ATTEMPT_ID:-}")
  workflow_id=$(invoker_progress_json_escape "\${INVOKER_WORKFLOW_ID:-}")
  invoker_progress_append "{\\"schemaVersion\\":${REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION},\\"seq\\":__INVOKER_PROGRESS_SEQ__,\\"kind\\":\\"$kind\\",\\"taskId\\":\\"$task_id\\",\\"attemptId\\":\\"$attempt_id\\",\\"workflowId\\":\\"$workflow_id\\",\\"createdAt\\":\\"$created_at\\",\\"payload\\":$payload_json}"
}
invoker_progress_heartbeat() {
  local epoch="$1"
  invoker_progress_entry "heartbeat" "{\\"epoch\\":$epoch}"
}
invoker_progress_attempt_started() {
  local workspace branch execution_id
  workspace=$(invoker_progress_json_escape "\${INVOKER_WORKSPACE_PATH:-}")
  branch=$(invoker_progress_json_escape "\${INVOKER_BRANCH:-}")
  execution_id=$(invoker_progress_json_escape "\${INVOKER_EXECUTION_ID:-}")
  invoker_progress_entry "attempt_started" "{\\"workspacePath\\":\\"$workspace\\",\\"branch\\":\\"$branch\\",\\"executionId\\":\\"$execution_id\\"}"
}
invoker_progress_attempt_finished() {
  local status="$1"
  local exit_code="$2"
  local workspace branch
  workspace=$(invoker_progress_json_escape "\${INVOKER_WORKSPACE_PATH:-}")
  branch=$(invoker_progress_json_escape "\${INVOKER_BRANCH:-}")
  invoker_progress_entry "attempt_finished" "{\\"status\\":\\"$status\\",\\"exitCode\\":$exit_code,\\"workspacePath\\":\\"$workspace\\",\\"branch\\":\\"$branch\\"}"
}
invoker_progress_output_chunk() {
  local stream="$1"
  local data="$2"
  local data_b64
  data_b64=$(printf '%s' "$data" | invoker_progress_base64_one_line)
  invoker_progress_entry "output_chunk" "{\\"stream\\":\\"$stream\\",\\"dataBase64\\":\\"$data_b64\\"}"
}
invoker_progress_stream() {
  local stream="$1"
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$stream" = "stderr" ]; then
      printf '%s\\n' "$line" >&2
    else
      printf '%s\\n' "$line"
    fi
    invoker_progress_output_chunk "$stream" "$line
"
  done
}
invoker_progress_spool_requests_stop() {
  [ -f "\${INVOKER_DELTA_SPOOL_PATH:-}" ] || return 1
  if [ -n "\${INVOKER_TASK_ID:-}" ] && grep -F "\\"entityType\\":\\"task\\"" "$INVOKER_DELTA_SPOOL_PATH" 2>/dev/null \\
      | grep -F "\\"entityId\\":\\"\${INVOKER_TASK_ID}\\"" \\
      | grep -E "\\"status\\":\\"(closed|cancelled|canceled|stale)\\"" >/dev/null 2>&1; then
    return 0
  fi
  if [ -n "\${INVOKER_WORKFLOW_ID:-}" ] && grep -F "\\"entityType\\":\\"workflow\\"" "$INVOKER_DELTA_SPOOL_PATH" 2>/dev/null \\
      | grep -F "\\"op\\":\\"tombstone\\"" \\
      | grep -F "\\"entityId\\":\\"\${INVOKER_WORKFLOW_ID}\\"" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}
INVOKER_REMOTE_HEARTBEAT_MARKER='${heartbeatMarker}'
`;
}

export function buildReadRemoteProgressJournalScript(options: {
  remoteInvokerHome?: string;
  sinceSeq: number;
}): string {
  const sinceSeq = asNonNegativeInteger('sinceSeq', Math.trunc(options.sinceSeq));
  return `set -euo pipefail
${buildSourceInvokerEnvScript(options.remoteInvokerHome, 'INVOKER_HOME')}
${buildRemoteProgressJournalEnvScript('INVOKER_HOME')}
SINCE_SEQ=${sinceSeq}
if [ ! -f "$INVOKER_PROGRESS_JOURNAL_PATH" ]; then
  exit 0
fi
awk -v since="$SINCE_SEQ" '
  {
    line = $0
    seq = line
    sub(/^.*"seq"[[:space:]]*:[[:space:]]*/, "", seq)
    sub(/[^0-9].*$/, "", seq)
    n = seq + 0
    if (n > since) print line
  }
' "$INVOKER_PROGRESS_JOURNAL_PATH"
`;
}

export function buildAppendHomeDeltaSpoolScript(options: {
  remoteInvokerHome?: string;
  batch: DeltaBatch;
}): string {
  const batchJson = JSON.stringify(options.batch);
  const batchB64 = base64Encode(batchJson);
  return `set -euo pipefail
${buildPortableBase64DecodeFunction('invoker_progress_base64_decode')}
${buildSourceInvokerEnvScript(options.remoteInvokerHome, 'INVOKER_HOME')}
${buildRemoteProgressJournalEnvScript('INVOKER_HOME')}
TMP="$INVOKER_DELTA_SPOOL_PATH.tmp.$$"
printf '%s' ${shellPosixSingleQuote(batchB64)} | invoker_progress_base64_decode > "$TMP"
printf '\\n' >> "$TMP"
cat "$TMP" >> "$INVOKER_DELTA_SPOOL_PATH"
rm -f "$TMP"
if sync -f "$INVOKER_DELTA_SPOOL_PATH" >/dev/null 2>&1; then
  :
fi
printf 'ACK %s\\n' ${shellPosixSingleQuote(String(options.batch.highWaterSeq))}
`;
}
