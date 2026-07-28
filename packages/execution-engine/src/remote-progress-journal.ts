import type { WorkRequest } from '@invoker/contracts';
import {
  DELTA_BATCH_SCHEMA_VERSION,
  type DeltaBatch,
  type SyncJournalEntry,
} from '@invoker/data-store';
import { buildPortableBase64DecodeFunction } from './remote-shell-fragments.js';
import {
  bashNormalizeTildePath,
  base64Encode,
  shellPosixSingleQuote,
} from './ssh-git-exec.js';

export const REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION = 1;
export const REMOTE_PROGRESS_JOURNAL_FILENAME = 'progress.journal.ndjson';
export const REMOTE_PROGRESS_OUTPUT_FILENAME = 'output.log';
export const REMOTE_SYNC_SPOOL_DIRNAME = 'sync-spool';
export const REMOTE_SYNC_PUSH_ACK_PREFIX = '__INVOKER_SYNC_PUSH_ACK__=';

export type RemoteProgressJournalKind =
  | 'attempt_started'
  | 'heartbeat_checkpoint'
  | 'output_chunk'
  | 'attempt_finished';

export interface RemoteProgressJournalEntry {
  schemaVersion: typeof REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION;
  seq: number;
  kind: RemoteProgressJournalKind;
  createdAt: string;
  taskId: string;
  workflowId?: string;
  attemptId?: string;
  requestId?: string;
  executionId?: string;
  executionGeneration?: number;
  branch?: string;
  workspacePath?: string;
  heartbeatEpochSeconds?: number;
  stream?: 'stdout' | 'stderr';
  offset?: number;
  bytes?: number;
  dataBase64?: string;
  outputPathBase64?: string;
  status?: 'completed' | 'failed';
  exitCode?: number;
  terminationReason?: string;
  pid?: number;
}

export interface RemoteProgressJournalEnvOptions {
  request: WorkRequest;
  executionId: string;
  workspacePath?: string;
  branch?: string;
  workflowId?: string;
}

export interface ReadRemoteProgressJournalOptions {
  invokerHome?: string;
  sinceSeq: number;
  limit?: number;
}

export interface WriteRemoteSyncSpoolOptions {
  invokerHome?: string;
  peerId: string;
  batch: DeltaBatch;
}

function asNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function jsonFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .join(',');
}

function safePathToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return token || 'peer';
}

export function inferWorkflowIdFromWorkRequest(request: WorkRequest): string | undefined {
  const inputs = request.inputs as WorkRequest['inputs'] & { workflowId?: unknown };
  if (typeof inputs.workflowId === 'string' && inputs.workflowId.trim()) {
    return inputs.workflowId.trim();
  }
  const slash = request.actionId.indexOf('/');
  if (slash > 0) return request.actionId.slice(0, slash);
  return undefined;
}

export function buildRemoteProgressJournalEnvScript(options: RemoteProgressJournalEnvOptions): string {
  const workflowId = options.workflowId ?? inferWorkflowIdFromWorkRequest(options.request);
  const baseJson = jsonFields({
    taskId: options.request.actionId,
    workflowId,
    attemptId: options.request.attemptId,
    requestId: options.request.requestId,
    executionId: options.executionId,
    executionGeneration: options.request.executionGeneration,
    branch: options.branch,
    workspacePath: options.workspacePath,
  });
  const taskIdJson = JSON.stringify(options.request.actionId);
  const workflowIdJson = workflowId ? JSON.stringify(workflowId) : '';

  return `INVOKER_PROGRESS_JOURNAL_PATH="$STAGING_DIR/${REMOTE_PROGRESS_JOURNAL_FILENAME}"
INVOKER_PROGRESS_OUTPUT_PATH="$STAGING_DIR/${REMOTE_PROGRESS_OUTPUT_FILENAME}"
INVOKER_PROGRESS_JOURNAL_SEQ_PATH="$INVOKER_HOME/runtime/ssh-executor/progress.seq"
INVOKER_PROGRESS_JOURNAL_LOCK_DIR="$INVOKER_HOME/runtime/ssh-executor/progress.seq.lock"
INVOKER_SYNC_SPOOL_DIR="$INVOKER_HOME/runtime/ssh-executor/${REMOTE_SYNC_SPOOL_DIRNAME}"
INVOKER_PROGRESS_BASE_JSON=${shellPosixSingleQuote(baseJson || '"taskId":"unknown"')}
INVOKER_PROGRESS_TASK_ID_JSON=${shellPosixSingleQuote(taskIdJson)}
INVOKER_PROGRESS_WORKFLOW_ID_JSON=${shellPosixSingleQuote(workflowIdJson)}
mkdir -p "$STAGING_DIR" "$(dirname "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH")" "$INVOKER_SYNC_SPOOL_DIR"
touch "$INVOKER_PROGRESS_JOURNAL_PATH" "$INVOKER_PROGRESS_OUTPUT_PATH"
export INVOKER_PROGRESS_JOURNAL_PATH INVOKER_PROGRESS_OUTPUT_PATH INVOKER_PROGRESS_JOURNAL_SEQ_PATH
export INVOKER_PROGRESS_JOURNAL_LOCK_DIR INVOKER_SYNC_SPOOL_DIR INVOKER_PROGRESS_BASE_JSON
export INVOKER_PROGRESS_TASK_ID_JSON INVOKER_PROGRESS_WORKFLOW_ID_JSON
`;
}

export function buildRemoteProgressJournalRunnerFragment(): string {
  return `${buildPortableBase64DecodeFunction()}
invoker_base64_encode() {
  base64 | tr -d '\\n'
}

invoker_journal_enabled() {
  [ -n "\${INVOKER_PROGRESS_JOURNAL_PATH:-}" ] && [ -n "\${INVOKER_PROGRESS_JOURNAL_SEQ_PATH:-}" ]
}

invoker_journal_lock() {
  invoker_journal_enabled || return 1
  local attempts=0
  while ! mkdir "$INVOKER_PROGRESS_JOURNAL_LOCK_DIR" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -gt 200 ]; then
      return 1
    fi
    sleep 0.05
  done
  return 0
}

invoker_journal_unlock() {
  rmdir "$INVOKER_PROGRESS_JOURNAL_LOCK_DIR" >/dev/null 2>&1 || true
}

invoker_journal_next_seq_locked() {
  local seq
  seq=$(cat "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH" 2>/dev/null || printf '0')
  case "$seq" in
    ''|*[!0-9]*) seq=0 ;;
  esac
  seq=$((seq + 1))
  printf '%s\\n' "$seq" > "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH.tmp.$$" 2>/dev/null || true
  mv "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH.tmp.$$" "$INVOKER_PROGRESS_JOURNAL_SEQ_PATH" 2>/dev/null || true
  printf '%s' "$seq"
}

invoker_journal_append_locked() {
  local kind="$1"
  local extra="\${2:-}"
  local seq created_at
  seq=$(invoker_journal_next_seq_locked)
  created_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  printf '{"schemaVersion":1,"seq":%s,"kind":"%s","createdAt":"%s",%s%s}\\n' \
    "$seq" "$kind" "$created_at" "\${INVOKER_PROGRESS_BASE_JSON:-\\"taskId\\":\\"unknown\\"}" "$extra" \
    >> "$INVOKER_PROGRESS_JOURNAL_PATH" 2>/dev/null || true
  sync "$INVOKER_PROGRESS_JOURNAL_PATH" >/dev/null 2>&1 || true
}

invoker_journal_append() {
  local kind="$1"
  local extra="\${2:-}"
  if invoker_journal_lock; then
    invoker_journal_append_locked "$kind" "$extra"
    invoker_journal_unlock
  fi
}

invoker_journal_attempt_started() {
  local pid="\${1:-0}"
  invoker_journal_append "attempt_started" ",\\"pid\\":$pid"
}

invoker_journal_heartbeat() {
  local heartbeat_epoch_seconds="\${1:-0}"
  invoker_journal_append "heartbeat_checkpoint" ",\\"heartbeatEpochSeconds\\":$heartbeat_epoch_seconds"
}

invoker_journal_attempt_finished() {
  local exit_code="\${1:-1}"
  local reason="\${2:-}"
  local status="failed"
  if [ "$exit_code" -eq 0 ]; then
    status="completed"
  fi
  if [ -n "$reason" ]; then
    invoker_journal_append "attempt_finished" ",\\"status\\":\\"$status\\",\\"exitCode\\":$exit_code,\\"terminationReason\\":\\"$reason\\""
  else
    invoker_journal_append "attempt_finished" ",\\"status\\":\\"$status\\",\\"exitCode\\":$exit_code"
  fi
}

invoker_journal_output_chunk() {
  local stream="$1"
  local data="$2"
  local bytes b64 path_b64 offset seq created_at
  bytes=$(printf '%s' "$data" | wc -c | tr -d '[:space:]')
  b64=$(printf '%s' "$data" | invoker_base64_encode)
  path_b64=$(printf '%s' "\${INVOKER_PROGRESS_OUTPUT_PATH:-}" | invoker_base64_encode)
  if invoker_journal_lock; then
    offset=$(wc -c < "$INVOKER_PROGRESS_OUTPUT_PATH" 2>/dev/null | tr -d '[:space:]')
    case "$offset" in
      ''|*[!0-9]*) offset=0 ;;
    esac
    printf '%s' "$data" >> "$INVOKER_PROGRESS_OUTPUT_PATH" 2>/dev/null || true
    seq=$(invoker_journal_next_seq_locked)
    created_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    printf '{"schemaVersion":1,"seq":%s,"kind":"output_chunk","createdAt":"%s",%s,"stream":"%s","offset":%s,"bytes":%s,"dataBase64":"%s","outputPathBase64":"%s"}\\n' \
      "$seq" "$created_at" "\${INVOKER_PROGRESS_BASE_JSON:-\\"taskId\\":\\"unknown\\"}" "$stream" "$offset" "$bytes" "$b64" "$path_b64" \
      >> "$INVOKER_PROGRESS_JOURNAL_PATH" 2>/dev/null || true
    sync "$INVOKER_PROGRESS_JOURNAL_PATH" >/dev/null 2>&1 || true
    invoker_journal_unlock
  fi
  printf '%s' "$data"
}

invoker_capture_output_stream() {
  local stream="$1"
  local line
  while IFS= read -r line; do
    invoker_journal_output_chunk "$stream" "$line"$'\\n'
  done
}

invoker_remote_tombstone_seen() {
  [ -d "\${INVOKER_SYNC_SPOOL_DIR:-}" ] || return 1
  local workflow_json="\${INVOKER_PROGRESS_WORKFLOW_ID_JSON:-}"
  local task_json="\${INVOKER_PROGRESS_TASK_ID_JSON:-}"
  local file
  while IFS= read -r file; do
    [ -f "$file" ] || continue
    if [ -n "$workflow_json" ] \
      && grep -F '"entityType":"workflow"' "$file" >/dev/null 2>&1 \
      && grep -F '"op":"tombstone"' "$file" >/dev/null 2>&1 \
      && grep -F "\\"entityId\\":$workflow_json" "$file" >/dev/null 2>&1; then
      return 0
    fi
    if [ -n "$task_json" ] \
      && grep -F '"entityType":"task"' "$file" >/dev/null 2>&1 \
      && grep -F "\\"entityId\\":$task_json" "$file" >/dev/null 2>&1 \
      && { grep -F '"status":"closed"' "$file" >/dev/null 2>&1 || grep -F '"status":"failed"' "$file" >/dev/null 2>&1; }; then
      return 0
    fi
  done < <(find "$INVOKER_SYNC_SPOOL_DIR" -type f -name '*.ndjson' -print 2>/dev/null | sort)
  return 1
}
`;
}

export function buildReadRemoteProgressJournalScript(options: ReadRemoteProgressJournalOptions): string {
  const sinceSeq = asNonNegativeInteger('sinceSeq', Math.trunc(options.sinceSeq));
  const limit = asNonNegativeInteger('limit', Math.trunc(options.limit ?? 1000));
  const invokerHomeB64 = base64Encode(options.invokerHome ?? '~/.invoker');

  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(invokerHomeB64)} | invoker_base64_decode)
${bashNormalizeTildePath('INVOKER_HOME')}
BASE="$INVOKER_HOME/runtime/ssh-executor"
SINCE_SEQ=${sinceSeq}
LIMIT=${limit}
[ -d "$BASE" ] || exit 0
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
while IFS= read -r journal; do
  [ -f "$journal" ] || continue
  while IFS= read -r line; do
    seq=$(printf '%s\\n' "$line" | sed -n 's/.*"seq":[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')
    [ -n "$seq" ] || continue
    if [ "$seq" -gt "$SINCE_SEQ" ]; then
      printf '%s\\t%s\\n' "$seq" "$line" >> "$TMP"
    fi
  done < "$journal"
done < <(find "$BASE" -mindepth 2 -maxdepth 2 -type f -name ${shellPosixSingleQuote(REMOTE_PROGRESS_JOURNAL_FILENAME)} -print 2>/dev/null | sort)
if [ -s "$TMP" ]; then
  sort -n "$TMP" | head -n "$LIMIT" | cut -f2-
fi
`;
}

export function buildWriteRemoteSyncSpoolScript(options: WriteRemoteSyncSpoolOptions): string {
  asNonNegativeInteger('batch.highWaterSeq', Math.trunc(options.batch.highWaterSeq));
  const invokerHomeB64 = base64Encode(options.invokerHome ?? '~/.invoker');
  const peerToken = safePathToken(options.peerId);
  const ndjson = options.batch.entries.map((entry) => JSON.stringify(entry)).join('\n');
  const content = ndjson ? `${ndjson}\n` : '';
  const contentB64 = base64Encode(content);

  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(invokerHomeB64)} | invoker_base64_decode)
${bashNormalizeTildePath('INVOKER_HOME')}
SPOOL_DIR="$INVOKER_HOME/runtime/ssh-executor/${REMOTE_SYNC_SPOOL_DIRNAME}"
mkdir -p "$SPOOL_DIR"
chmod 700 "$SPOOL_DIR" 2>/dev/null || true
TARGET="$SPOOL_DIR/${peerToken}-${options.batch.highWaterSeq}-$(date +%s)-$$.ndjson"
TMP="$TARGET.tmp"
printf '%s' ${shellPosixSingleQuote(contentB64)} | invoker_base64_decode > "$TMP"
mv "$TMP" "$TARGET"
sync "$TARGET" >/dev/null 2>&1 || true
printf '${REMOTE_SYNC_PUSH_ACK_PREFIX}%s\\n' ${options.batch.highWaterSeq}
`;
}

export function parseRemoteProgressJournalLines(text: string): RemoteProgressJournalEntry[] {
  const entries: RemoteProgressJournalEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as Partial<RemoteProgressJournalEntry>;
    if (parsed.schemaVersion !== REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION) {
      throw new Error(`Unsupported remote progress journal schema ${String(parsed.schemaVersion)}`);
    }
    if (!Number.isInteger(parsed.seq) || parsed.seq! < 0) {
      throw new Error('Remote progress journal entry seq must be a non-negative integer');
    }
    if (!parsed.kind || !parsed.taskId || !parsed.createdAt) {
      throw new Error('Remote progress journal entry missing required fields');
    }
    entries.push(parsed as RemoteProgressJournalEntry);
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

function baseTaskPayload(entry: RemoteProgressJournalEntry, status: string): Record<string, unknown> | undefined {
  if (!entry.workflowId) return undefined;
  return {
    id: entry.taskId,
    workflow_id: entry.workflowId,
    description: entry.taskId,
    status,
    execution_generation: entry.executionGeneration ?? 0,
    action_request_id: entry.requestId,
    branch: entry.branch,
    workspace_path: entry.workspacePath,
    task_state_version: Math.max(1, entry.seq),
    created_at: entry.createdAt,
  };
}

function attemptPayload(entry: RemoteProgressJournalEntry, status: string): Record<string, unknown> | undefined {
  if (!entry.attemptId) return undefined;
  return {
    id: entry.attemptId,
    node_id: entry.taskId,
    attempt_number: 0,
    queue_priority: 0,
    status,
    upstream_attempt_ids: '[]',
    branch: entry.branch,
    workspace_path: entry.workspacePath,
    created_at: entry.createdAt,
  };
}

function makeEntry(
  entry: RemoteProgressJournalEntry,
  entityType: SyncJournalEntry['entityType'],
  entityId: string,
  payload: unknown,
): SyncJournalEntry {
  return {
    seq: entry.seq,
    entityType,
    entityId,
    op: 'upsert',
    payload,
    origin: 'remote-progress',
    createdAt: entry.createdAt,
  };
}

function decodeBase64Utf8(value: string | undefined): string {
  if (!value) return '';
  return Buffer.from(value, 'base64').toString('utf8');
}

export function remoteProgressEntriesToDeltaBatch(
  entries: readonly RemoteProgressJournalEntry[],
  sinceSeq: number,
): DeltaBatch {
  const cursor = asNonNegativeInteger('sinceSeq', Math.trunc(sinceSeq));
  const sorted = [...entries].filter((entry) => entry.seq > cursor).sort((a, b) => a.seq - b.seq);
  const journalEntries: SyncJournalEntry[] = [];

  for (const entry of sorted) {
    if (entry.kind === 'attempt_started') {
      const task = baseTaskPayload(entry, 'running');
      if (task) {
        journalEntries.push(makeEntry(entry, 'task', entry.taskId, {
          ...task,
          started_at: entry.createdAt,
          last_heartbeat_at: entry.createdAt,
        }));
      }
      const attempt = attemptPayload(entry, 'running');
      if (attempt) {
        journalEntries.push(makeEntry(entry, 'attempt', entry.attemptId!, {
          ...attempt,
          started_at: entry.createdAt,
          last_heartbeat_at: entry.createdAt,
        }));
      }
      continue;
    }

    if (entry.kind === 'heartbeat_checkpoint') {
      const heartbeatAt = entry.heartbeatEpochSeconds
        ? new Date(entry.heartbeatEpochSeconds * 1000).toISOString()
        : entry.createdAt;
      const task = baseTaskPayload(entry, 'running');
      if (task) {
        journalEntries.push(makeEntry(entry, 'task', entry.taskId, {
          ...task,
          last_heartbeat_at: heartbeatAt,
        }));
      }
      const attempt = attemptPayload(entry, 'running');
      if (attempt) {
        journalEntries.push(makeEntry(entry, 'attempt', entry.attemptId!, {
          ...attempt,
          last_heartbeat_at: heartbeatAt,
        }));
      }
      continue;
    }

    if (entry.kind === 'output_chunk') {
      journalEntries.push(makeEntry(entry, 'output', `${entry.taskId}:${entry.offset ?? entry.seq}`, {
        task_id: entry.taskId,
        offset: entry.offset ?? 0,
        data: decodeBase64Utf8(entry.dataBase64),
        created_at: entry.createdAt,
      }));
      continue;
    }

    if (entry.kind === 'attempt_finished') {
      const status = entry.status ?? (entry.exitCode === 0 ? 'completed' : 'failed');
      const task = baseTaskPayload(entry, status);
      if (task) {
        journalEntries.push(makeEntry(entry, 'task', entry.taskId, {
          ...task,
          completed_at: entry.createdAt,
          exit_code: entry.exitCode,
          error: entry.terminationReason,
        }));
      }
      const attempt = attemptPayload(entry, status);
      if (attempt) {
        journalEntries.push(makeEntry(entry, 'attempt', entry.attemptId!, {
          ...attempt,
          completed_at: entry.createdAt,
          exit_code: entry.exitCode,
          error: entry.terminationReason,
        }));
      }
    }
  }

  return {
    schemaVersion: DELTA_BATCH_SCHEMA_VERSION,
    sinceSeq: cursor,
    highWaterSeq: Math.max(cursor, ...sorted.map((entry) => entry.seq)),
    entries: journalEntries,
  };
}
