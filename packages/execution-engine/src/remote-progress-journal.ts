import type { WorkRequest } from '@invoker/contracts';
import {
  DELTA_BATCH_SCHEMA_VERSION,
  type DeltaBatch,
  type SyncJournalEntry,
} from '@invoker/data-store';
import { base64Encode, shellPosixSingleQuote } from './ssh-git-exec.js';
import { buildPortableBase64DecodeFunction, buildSourceInvokerEnvScript } from './remote-shell-fragments.js';

export const SSH_SYNC_BASE_RELATIVE_DIR = 'runtime/ssh-executor/sync';
export const SSH_SYNC_INBOX_FILE_NAME = 'home.ndjson';
export const REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION = 1;

export type RemoteProgressJournalKind =
  | 'attempt_started'
  | 'heartbeat'
  | 'output_chunk'
  | 'attempt_finished';

export interface RemoteProgressJournalEntry {
  schemaVersion: typeof REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION;
  seq: number;
  kind: RemoteProgressJournalKind;
  createdAt: string;
  taskId: string;
  attemptId: string;
  workflowId?: string;
  executionId?: string;
  requestId?: string;
  actionType?: string;
  executionGeneration?: number;
  description?: string;
  command?: string;
  prompt?: string;
  workspacePath?: string;
  branch?: string;
  stream?: 'stdout' | 'stderr';
  offset?: number;
  sourceOffset?: number;
  bytes?: number;
  chunkPath?: string;
  data?: string;
  exitCode?: number;
  status?: 'completed' | 'failed';
  error?: string;
  agentSessionId?: string;
  commitHash?: string;
  summary?: string;
}

export interface RemoteDeltaTranslationOptions {
  peerId?: string;
  loadTaskPayload?: (taskId: string) => Record<string, unknown> | undefined;
  loadAttemptPayload?: (attemptId: string) => Record<string, unknown> | undefined;
}

function b64(value: string | undefined): string {
  return base64Encode(value ?? '');
}

function shellB64(value: string | undefined): string {
  return shellPosixSingleQuote(b64(value));
}

function jsonEscapedForShellGrep(value: string | undefined): string {
  return JSON.stringify(value ?? '').slice(1, -1);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function decodeBase64Field(raw: Record<string, unknown>, field: string): string | undefined {
  const direct = asOptionalString(raw[field]);
  if (direct !== undefined) return direct;
  const encoded = asOptionalString(raw[`${field}Base64`]);
  if (encoded === undefined) return undefined;
  try {
    return Buffer.from(encoded, 'base64').toString('utf8') || undefined;
  } catch {
    return undefined;
  }
}

function asNonNegativeInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function inferWorkflowIdFromTaskId(taskId: string): string | undefined {
  const slash = taskId.indexOf('/');
  return slash > 0 ? taskId.slice(0, slash) : undefined;
}

function isoNow(): string {
  return new Date().toISOString();
}

function buildPortableBase64EncodeFunction(functionName = 'invoker_base64_encode'): string {
  return `${functionName}() {
  if base64 --wrap=0 </dev/null >/dev/null 2>&1; then
    base64 --wrap=0
  elif base64 -w 0 </dev/null >/dev/null 2>&1; then
    base64 -w 0
  else
    base64 | tr -d '\\n'
  fi
}`;
}

export function buildRemoteProgressJournalBootstrapScript(options: {
  stagingToken: string;
  request: WorkRequest;
  workspacePath: string;
  branch?: string;
}): string {
  const workflowId = inferWorkflowIdFromTaskId(options.request.actionId);
  return `STAGING_TOKEN=${shellPosixSingleQuote(options.stagingToken)}
INVOKER_SYNC_DIR="$INVOKER_HOME/${SSH_SYNC_BASE_RELATIVE_DIR}"
INVOKER_SYNC_JOURNAL_DIR="$INVOKER_SYNC_DIR/journals"
INVOKER_SYNC_OUTPUT_DIR="$INVOKER_SYNC_DIR/output/$STAGING_TOKEN"
INVOKER_SYNC_INBOX_DIR="$INVOKER_SYNC_DIR/inbox"
INVOKER_SYNC_INBOX_PATH="$INVOKER_SYNC_INBOX_DIR/${SSH_SYNC_INBOX_FILE_NAME}"
INVOKER_SYNC_SEQ_FILE="$INVOKER_SYNC_DIR/remote.seq"
INVOKER_SYNC_SEQ_LOCK_DIR="$INVOKER_SYNC_DIR/remote.seq.lock"
INVOKER_SYNC_OUTPUT_OFFSET_FILE="$INVOKER_SYNC_OUTPUT_DIR/output.offset"
INVOKER_SYNC_OUTPUT_LOCK_DIR="$INVOKER_SYNC_OUTPUT_DIR/output.offset.lock"
INVOKER_PROGRESS_JOURNAL_PATH="$INVOKER_SYNC_JOURNAL_DIR/$STAGING_TOKEN.ndjson"
INVOKER_SYNC_STDOUT_PATH="$INVOKER_SYNC_OUTPUT_DIR/stdout.log"
INVOKER_SYNC_STDERR_PATH="$INVOKER_SYNC_OUTPUT_DIR/stderr.log"
INVOKER_SYNC_STDOUT_CURSOR_FILE="$INVOKER_SYNC_OUTPUT_DIR/stdout.cursor"
INVOKER_SYNC_STDERR_CURSOR_FILE="$INVOKER_SYNC_OUTPUT_DIR/stderr.cursor"
INVOKER_SYNC_TASK_ID_B64=${shellB64(options.request.actionId)}
INVOKER_SYNC_ATTEMPT_ID_B64=${shellB64(options.request.attemptId ?? options.request.requestId)}
INVOKER_SYNC_WORKFLOW_ID_B64=${shellB64(workflowId)}
INVOKER_SYNC_WORKFLOW_ID_JSON=${shellPosixSingleQuote(jsonEscapedForShellGrep(workflowId))}
INVOKER_SYNC_EXECUTION_ID_B64=${shellB64(options.request.requestId)}
INVOKER_SYNC_REQUEST_ID_B64=${shellB64(options.request.requestId)}
INVOKER_SYNC_ACTION_TYPE_B64=${shellB64(options.request.actionType)}
INVOKER_SYNC_DESCRIPTION_B64=${shellB64(options.request.inputs.description)}
INVOKER_SYNC_COMMAND_B64=${shellB64(options.request.inputs.command)}
INVOKER_SYNC_PROMPT_B64=${shellB64(options.request.inputs.prompt)}
INVOKER_SYNC_WORKSPACE_PATH_B64=${shellB64(options.workspacePath)}
INVOKER_SYNC_BRANCH_B64=${shellB64(options.branch)}
INVOKER_SYNC_EXECUTION_GENERATION=${Math.max(0, Math.trunc(options.request.executionGeneration ?? 0))}
INVOKER_SYNC_TERMINATED_BY_TOMBSTONE=0
mkdir -p "$INVOKER_SYNC_JOURNAL_DIR" "$INVOKER_SYNC_OUTPUT_DIR" "$INVOKER_SYNC_INBOX_DIR"
chmod 700 "$INVOKER_SYNC_DIR" "$INVOKER_SYNC_JOURNAL_DIR" "$INVOKER_SYNC_OUTPUT_DIR" "$INVOKER_SYNC_INBOX_DIR" 2>/dev/null || true
: > "$INVOKER_SYNC_STDOUT_PATH"
: > "$INVOKER_SYNC_STDERR_PATH"
printf '0\\n' > "$INVOKER_SYNC_STDOUT_CURSOR_FILE"
printf '0\\n' > "$INVOKER_SYNC_STDERR_CURSOR_FILE"
printf '0\\n' > "$INVOKER_SYNC_OUTPUT_OFFSET_FILE"
${buildRemoteProgressJournalShellFunctions()}
`;
}

export function buildRemoteProgressJournalRunnerScriptFragment(): string {
  return buildRemoteProgressJournalShellFunctions();
}

function buildRemoteProgressJournalShellFunctions(): string {
  return `${buildPortableBase64DecodeFunction()}
${buildPortableBase64EncodeFunction()}

invoker_sync_read_uint_file() {
  local path="$1"
  local value="0"
  if [ -f "$path" ]; then
    IFS= read -r value < "$path" || value="0"
  fi
  case "$value" in
    ''|*[!0-9]*) value="0" ;;
  esac
  printf '%s' "$value"
}

invoker_sync_with_lock() {
  local lock_dir="$1"
  shift
  local attempts=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -gt 200 ]; then
      rm -rf "$lock_dir" >/dev/null 2>&1 || true
    fi
    sleep 0.05
  done
  "$@"
  local status=$?
  rmdir "$lock_dir" >/dev/null 2>&1 || true
  return "$status"
}

invoker_journal_next_seq_locked() {
  local current next tmp
  current=$(invoker_sync_read_uint_file "$INVOKER_SYNC_SEQ_FILE")
  next=$((current + 1))
  tmp="$INVOKER_SYNC_SEQ_FILE.tmp.$$"
  printf '%s\\n' "$next" > "$tmp"
  mv "$tmp" "$INVOKER_SYNC_SEQ_FILE"
  printf '%s' "$next"
}

invoker_journal_next_seq() {
  invoker_sync_with_lock "$INVOKER_SYNC_SEQ_LOCK_DIR" invoker_journal_next_seq_locked
}

invoker_output_next_offset_locked() {
  local bytes="$1"
  local current next tmp
  current=$(invoker_sync_read_uint_file "$INVOKER_SYNC_OUTPUT_OFFSET_FILE")
  next=$((current + bytes))
  tmp="$INVOKER_SYNC_OUTPUT_OFFSET_FILE.tmp.$$"
  printf '%s\\n' "$next" > "$tmp"
  mv "$tmp" "$INVOKER_SYNC_OUTPUT_OFFSET_FILE"
  printf '%s' "$current"
}

invoker_output_next_offset() {
  invoker_sync_with_lock "$INVOKER_SYNC_OUTPUT_LOCK_DIR" invoker_output_next_offset_locked "$1"
}

invoker_journal_append() {
  if [ -z "\${INVOKER_PROGRESS_JOURNAL_PATH:-}" ]; then
    return 0
  fi
  local kind="$1"
  local extra="\${2:-}"
  local seq created_at
  seq=$(invoker_journal_next_seq) || return 0
  created_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  printf '{"schemaVersion":1,"seq":%s,"kind":"%s","createdAt":"%s","taskIdBase64":"%s","attemptIdBase64":"%s","workflowIdBase64":"%s","executionIdBase64":"%s"%s}\\n' \\
    "$seq" "$kind" "$created_at" "$INVOKER_SYNC_TASK_ID_B64" "$INVOKER_SYNC_ATTEMPT_ID_B64" "$INVOKER_SYNC_WORKFLOW_ID_B64" "$INVOKER_SYNC_EXECUTION_ID_B64" "$extra" \\
    >> "$INVOKER_PROGRESS_JOURNAL_PATH" || return 0
  sync "$INVOKER_PROGRESS_JOURNAL_PATH" >/dev/null 2>&1 || true
}

invoker_journal_attempt_started() {
  invoker_journal_append "attempt_started" ",\\"requestIdBase64\\":\\"$INVOKER_SYNC_REQUEST_ID_B64\\",\\"actionTypeBase64\\":\\"$INVOKER_SYNC_ACTION_TYPE_B64\\",\\"executionGeneration\\":$INVOKER_SYNC_EXECUTION_GENERATION,\\"descriptionBase64\\":\\"$INVOKER_SYNC_DESCRIPTION_B64\\",\\"commandBase64\\":\\"$INVOKER_SYNC_COMMAND_B64\\",\\"promptBase64\\":\\"$INVOKER_SYNC_PROMPT_B64\\",\\"workspacePathBase64\\":\\"$INVOKER_SYNC_WORKSPACE_PATH_B64\\",\\"branchBase64\\":\\"$INVOKER_SYNC_BRANCH_B64\\""
}

invoker_journal_heartbeat() {
  invoker_journal_append "heartbeat" ",\\"executionGeneration\\":$INVOKER_SYNC_EXECUTION_GENERATION"
}

invoker_journal_output_checkpoint() {
  local stream="$1"
  local source_path cursor_path
  if [ "$stream" = "stderr" ]; then
    source_path="$INVOKER_SYNC_STDERR_PATH"
    cursor_path="$INVOKER_SYNC_STDERR_CURSOR_FILE"
  else
    source_path="$INVOKER_SYNC_STDOUT_PATH"
    cursor_path="$INVOKER_SYNC_STDOUT_CURSOR_FILE"
  fi
  [ -f "$source_path" ] || return 0
  local source_offset size bytes output_offset chunk_path chunk_b64
  source_offset=$(invoker_sync_read_uint_file "$cursor_path")
  size=$(wc -c < "$source_path" 2>/dev/null | tr -d '[:space:]')
  case "$size" in
    ''|*[!0-9]*) size=0 ;;
  esac
  if [ "$size" -le "$source_offset" ]; then
    return 0
  fi
  bytes=$((size - source_offset))
  output_offset=$(invoker_output_next_offset "$bytes") || output_offset=0
  chunk_path="$INVOKER_SYNC_OUTPUT_DIR/$stream-$source_offset-$bytes.chunk"
  dd if="$source_path" of="$chunk_path" bs=1 skip="$source_offset" count="$bytes" 2>/dev/null || return 0
  printf '%s\\n' "$size" > "$cursor_path"
  chunk_b64=$(printf '%s' "$chunk_path" | invoker_base64_encode | tr -d '\\n')
  invoker_journal_append "output_chunk" ",\\"stream\\":\\"$stream\\",\\"offset\\":$output_offset,\\"sourceOffset\\":$source_offset,\\"bytes\\":$bytes,\\"chunkPathBase64\\":\\"$chunk_b64\\""
}

invoker_journal_flush_output() {
  invoker_journal_output_checkpoint stdout || true
  invoker_journal_output_checkpoint stderr || true
}

invoker_remote_should_stop_for_tombstone() {
  [ -n "\${INVOKER_SYNC_WORKFLOW_ID_JSON:-}" ] || return 1
  [ -f "\${INVOKER_SYNC_INBOX_PATH:-}" ] || return 1
  grep -F '"entityType":"workflow"' "$INVOKER_SYNC_INBOX_PATH" 2>/dev/null \\
    | grep -F '"op":"tombstone"' \\
    | grep -F "\\"entityId\\":\\"$INVOKER_SYNC_WORKFLOW_ID_JSON\\"" >/dev/null 2>&1
}

invoker_journal_attempt_finished() {
  local exit_code="$1"
  local status="failed"
  local error_b64=""
  if [ "$exit_code" -eq 0 ]; then
    status="completed"
  elif [ "\${INVOKER_SYNC_TERMINATED_BY_TOMBSTONE:-0}" = "1" ]; then
    error_b64=$(printf '%s' 'Terminated by workflow tombstone' | invoker_base64_encode | tr -d '\\n')
  fi
  local extra=",\\"executionGeneration\\":$INVOKER_SYNC_EXECUTION_GENERATION,\\"exitCode\\":$exit_code,\\"status\\":\\"$status\\",\\"workspacePathBase64\\":\\"$INVOKER_SYNC_WORKSPACE_PATH_B64\\",\\"branchBase64\\":\\"$INVOKER_SYNC_BRANCH_B64\\""
  if [ -n "$error_b64" ]; then
    extra="$extra,\\"errorBase64\\":\\"$error_b64\\""
  fi
  invoker_journal_append "attempt_finished" "$extra"
}
`;
}

export function buildReadRemoteProgressJournalScript(options: {
  remoteInvokerHome: string;
  sinceSeq: number;
  limit?: number;
}): string {
  const sinceSeq = Math.max(0, Math.trunc(options.sinceSeq));
  const limit = Math.max(0, Math.trunc(options.limit ?? 1000));
  return `set -euo pipefail
${buildSourceInvokerEnvScript(options.remoteInvokerHome, 'INVOKER_HOME')}
${buildPortableBase64DecodeFunction()}
${buildPortableBase64EncodeFunction()}
JOURNAL_DIR="$INVOKER_HOME/${SSH_SYNC_BASE_RELATIVE_DIR}/journals"
SINCE=${sinceSeq}
LIMIT=${limit}
if [ "$LIMIT" -eq 0 ] || [ ! -d "$JOURNAL_DIR" ]; then
  exit 0
fi
TMP_FILE=$(mktemp)
cleanup() { rm -f "$TMP_FILE" >/dev/null 2>&1 || true; }
trap cleanup EXIT
for journal_file in "$JOURNAL_DIR"/*.ndjson; do
  [ -f "$journal_file" ] || continue
  while IFS= read -r line || [ -n "$line" ]; do
    seq=$(printf '%s\\n' "$line" | sed -n 's/.*"seq":\\([0-9][0-9]*\\).*/\\1/p')
    case "$seq" in
      ''|*[!0-9]*) continue ;;
    esac
    if [ "$seq" -gt "$SINCE" ]; then
      printf '%s\\t%s\\n' "$seq" "$line" >> "$TMP_FILE"
    fi
  done < "$journal_file"
done
emit_line() {
  local line="$1"
  if printf '%s\\n' "$line" | grep -F '"kind":"output_chunk"' >/dev/null 2>&1; then
    chunk_b64=$(printf '%s\\n' "$line" | sed -n 's/.*"chunkPathBase64":"\\([^"]*\\)".*/\\1/p')
    if [ -n "$chunk_b64" ]; then
      chunk_path=$(printf '%s' "$chunk_b64" | invoker_base64_decode 2>/dev/null || true)
      if [ -f "$chunk_path" ]; then
        data_b64=$(invoker_base64_encode < "$chunk_path" | tr -d '\\n')
        line="\${line%?},\\"dataBase64\\":\\"$data_b64\\"}"
      fi
    fi
  fi
  printf '%s\\n' "$line"
}
count=0
sort -n "$TMP_FILE" | while IFS="$(printf '\\t')" read -r _seq json; do
  count=$((count + 1))
  if [ "$count" -gt "$LIMIT" ]; then
    break
  fi
  emit_line "$json"
done
`;
}

export function buildWriteRemoteDeltaSpoolScript(options: {
  remoteInvokerHome: string;
  batch: DeltaBatch;
}): string {
  const payload = JSON.stringify(options.batch);
  return `set -euo pipefail
${buildSourceInvokerEnvScript(options.remoteInvokerHome, 'INVOKER_HOME')}
${buildPortableBase64DecodeFunction()}
SYNC_DIR="$INVOKER_HOME/${SSH_SYNC_BASE_RELATIVE_DIR}"
INBOX_DIR="$SYNC_DIR/inbox"
INBOX_PATH="$INBOX_DIR/${SSH_SYNC_INBOX_FILE_NAME}"
mkdir -p "$INBOX_DIR"
chmod 700 "$SYNC_DIR" "$INBOX_DIR" 2>/dev/null || true
TMP_FILE=$(mktemp "$INBOX_DIR/.home-delta.XXXXXX")
cleanup() { rm -f "$TMP_FILE" >/dev/null 2>&1 || true; }
trap cleanup EXIT
printf '%s' ${shellPosixSingleQuote(base64Encode(payload))} | invoker_base64_decode > "$TMP_FILE"
cat "$TMP_FILE" >> "$INBOX_PATH"
printf '\\n' >> "$INBOX_PATH"
sync "$INBOX_PATH" >/dev/null 2>&1 || true
printf '{"ackSeq":%s}\\n' ${Math.max(0, Math.trunc(options.batch.highWaterSeq))}
`;
}

export function parseRemoteDeltaSpoolAck(stdout: string): { ackSeq: number } {
  const line = stdout.split('\n').find((candidate) => candidate.trim().length > 0);
  if (!line) throw new Error('SSH sync push did not return an acknowledgement');
  const parsed = JSON.parse(line) as { ackSeq?: unknown };
  const ackSeq = asNonNegativeInteger(parsed.ackSeq);
  if (ackSeq === undefined) {
    throw new Error('SSH sync push acknowledgement missing ackSeq');
  }
  return { ackSeq };
}

export function parseRemoteProgressJournalLines(stdout: string): RemoteProgressJournalEntry[] {
  const entries: RemoteProgressJournalEntry[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (raw.schemaVersion !== REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION) continue;
    const kind = raw.kind as RemoteProgressJournalKind;
    if (!['attempt_started', 'heartbeat', 'output_chunk', 'attempt_finished'].includes(kind)) {
      continue;
    }
    const seq = asNonNegativeInteger(raw.seq);
    const taskId = decodeBase64Field(raw, 'taskId');
    const attemptId = decodeBase64Field(raw, 'attemptId');
    const createdAt = asOptionalString(raw.createdAt);
    if (seq === undefined || !taskId || !attemptId || !createdAt) continue;

    const dataBase64 = asOptionalString(raw.dataBase64);
    const entry: RemoteProgressJournalEntry = {
      schemaVersion: REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION,
      seq,
      kind,
      createdAt,
      taskId,
      attemptId,
      workflowId: decodeBase64Field(raw, 'workflowId'),
      executionId: decodeBase64Field(raw, 'executionId'),
      requestId: decodeBase64Field(raw, 'requestId'),
      actionType: decodeBase64Field(raw, 'actionType'),
      executionGeneration: asNonNegativeInteger(raw.executionGeneration),
      description: decodeBase64Field(raw, 'description'),
      command: decodeBase64Field(raw, 'command'),
      prompt: decodeBase64Field(raw, 'prompt'),
      workspacePath: decodeBase64Field(raw, 'workspacePath'),
      branch: decodeBase64Field(raw, 'branch'),
      stream: raw.stream === 'stderr' ? 'stderr' : raw.stream === 'stdout' ? 'stdout' : undefined,
      offset: asNonNegativeInteger(raw.offset),
      sourceOffset: asNonNegativeInteger(raw.sourceOffset),
      bytes: asNonNegativeInteger(raw.bytes),
      chunkPath: decodeBase64Field(raw, 'chunkPath'),
      data: dataBase64 !== undefined ? Buffer.from(dataBase64, 'base64').toString('utf8') : undefined,
      exitCode: asNonNegativeInteger(raw.exitCode),
      status: raw.status === 'completed' ? 'completed' : raw.status === 'failed' ? 'failed' : undefined,
      error: decodeBase64Field(raw, 'error'),
      agentSessionId: decodeBase64Field(raw, 'agentSessionId'),
      commitHash: decodeBase64Field(raw, 'commitHash'),
      summary: decodeBase64Field(raw, 'summary'),
    };
    entries.push(entry);
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

function syncEntry(
  seq: number,
  entityType: SyncJournalEntry['entityType'],
  entityId: string,
  payload: Record<string, unknown>,
  createdAt: string,
  origin: string,
  op: SyncJournalEntry['op'] = 'upsert',
): SyncJournalEntry {
  return {
    seq,
    entityType,
    entityId,
    op,
    payload,
    origin,
    createdAt,
  };
}

function taskPayloadForEntry(
  entry: RemoteProgressJournalEntry,
  status: 'running' | 'completed' | 'failed',
  options: RemoteDeltaTranslationOptions,
): Record<string, unknown> | undefined {
  const base = options.loadTaskPayload?.(entry.taskId);
  const workflowId = asOptionalString(base?.workflow_id) ?? entry.workflowId ?? inferWorkflowIdFromTaskId(entry.taskId);
  if (!workflowId) return undefined;
  const currentVersion = Number(base?.task_state_version ?? 1);
  const nextVersion = Number.isInteger(currentVersion) && currentVersion > 0 ? currentVersion + 1 : 1;
  return {
    ...(base ?? {}),
    id: entry.taskId,
    workflow_id: workflowId,
    description: asOptionalString(base?.description) ?? entry.description ?? entry.taskId,
    status,
    dependencies: asOptionalString(base?.dependencies) ?? '[]',
    command: base && 'command' in base ? base.command : entry.command ?? null,
    prompt: base && 'prompt' in base ? base.prompt : entry.prompt ?? null,
    runner_kind: asOptionalString(base?.runner_kind) ?? 'ssh',
    action_request_id: asOptionalString(base?.action_request_id) ?? entry.requestId ?? null,
    started_at: status === 'running'
      ? asOptionalString(base?.started_at) ?? entry.createdAt
      : asOptionalString(base?.started_at) ?? entry.createdAt,
    completed_at: status === 'completed' || status === 'failed' ? entry.createdAt : base?.completed_at ?? null,
    last_heartbeat_at: entry.createdAt,
    exit_code: entry.exitCode ?? base?.exit_code ?? null,
    error: entry.error ?? base?.error ?? null,
    branch: entry.branch ?? base?.branch ?? null,
    commit_hash: entry.commitHash ?? base?.commit_hash ?? null,
    workspace_path: entry.workspacePath ?? base?.workspace_path ?? null,
    agent_session_id: entry.agentSessionId ?? base?.agent_session_id ?? null,
    execution_generation: entry.executionGeneration ?? base?.execution_generation ?? 0,
    task_state_version: nextVersion,
    created_at: asOptionalString(base?.created_at) ?? entry.createdAt,
  };
}

function attemptPayloadForEntry(
  entry: RemoteProgressJournalEntry,
  status: 'running' | 'completed' | 'failed',
  options: RemoteDeltaTranslationOptions,
): Record<string, unknown> {
  const base = options.loadAttemptPayload?.(entry.attemptId);
  return {
    ...(base ?? {}),
    id: entry.attemptId,
    node_id: entry.taskId,
    attempt_number: base?.attempt_number ?? 0,
    queue_priority: base?.queue_priority ?? 0,
    status,
    upstream_attempt_ids: asOptionalString(base?.upstream_attempt_ids) ?? '[]',
    claimed_at: asOptionalString(base?.claimed_at) ?? entry.createdAt,
    started_at: asOptionalString(base?.started_at) ?? entry.createdAt,
    completed_at: status === 'completed' || status === 'failed' ? entry.createdAt : base?.completed_at ?? null,
    exit_code: entry.exitCode ?? base?.exit_code ?? null,
    error: entry.error ?? base?.error ?? null,
    last_heartbeat_at: entry.createdAt,
    branch: entry.branch ?? base?.branch ?? null,
    commit_hash: entry.commitHash ?? base?.commit_hash ?? null,
    summary: entry.summary ?? base?.summary ?? null,
    workspace_path: entry.workspacePath ?? base?.workspace_path ?? null,
    agent_session_id: entry.agentSessionId ?? base?.agent_session_id ?? null,
    created_at: asOptionalString(base?.created_at) ?? entry.createdAt,
  };
}

export function remoteProgressEntriesToDeltaBatch(
  entries: RemoteProgressJournalEntry[],
  sinceSeq: number,
  options: RemoteDeltaTranslationOptions = {},
): DeltaBatch {
  const origin = options.peerId ?? 'ssh-remote';
  const syncEntries: SyncJournalEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'output_chunk') {
      if (entry.offset === undefined || entry.data === undefined) continue;
      syncEntries.push(syncEntry(
        entry.seq,
        'output',
        `${entry.taskId}@${entry.offset}`,
        {
          task_id: entry.taskId,
          offset: entry.offset,
          data: entry.data,
          created_at: entry.createdAt,
        },
        entry.createdAt,
        origin,
      ));
      continue;
    }

    const status = entry.kind === 'attempt_finished'
      ? entry.status ?? (entry.exitCode === 0 ? 'completed' : 'failed')
      : 'running';
    const taskPayload = taskPayloadForEntry(entry, status, options);
    if (taskPayload) {
      syncEntries.push(syncEntry(entry.seq, 'task', entry.taskId, taskPayload, entry.createdAt, origin));
    }
    syncEntries.push(syncEntry(
      entry.seq,
      'attempt',
      entry.attemptId,
      attemptPayloadForEntry(entry, status, options),
      entry.createdAt,
      origin,
    ));
  }
  const highWaterSeq = Math.max(Math.max(0, Math.trunc(sinceSeq)), ...entries.map((entry) => entry.seq));
  return {
    schemaVersion: DELTA_BATCH_SCHEMA_VERSION,
    sinceSeq: Math.max(0, Math.trunc(sinceSeq)),
    highWaterSeq,
    entries: syncEntries.sort((a, b) => a.seq - b.seq),
  };
}
