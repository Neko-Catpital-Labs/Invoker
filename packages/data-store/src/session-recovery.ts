import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SqliteExecutor } from './sqlite-executor.js';

export function resolveDefaultClaudeWorkerConfigDir(): string {
  const override = process.env.INVOKER_CLAUDE_CONFIG_DIR?.trim();
  if (override) return override;
  return join(homedir(), '.invoker', 'claude-worker');
}

export function normalizeAgentSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'none') return null;
  return trimmed;
}

export const UPSERT_SESSION_RECOVERY_SQL = `INSERT INTO task_session_recovery (
  workflow_id, agent_session_id, task_id, config_dir, workspace_path, pool_id,
  transcript_path, crash_preserved_at, crash_report_path, crash_diagnostic_summary,
  created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
ON CONFLICT(workflow_id, agent_session_id) DO UPDATE SET
  task_id = COALESCE(excluded.task_id, task_session_recovery.task_id),
  config_dir = COALESCE(excluded.config_dir, task_session_recovery.config_dir),
  workspace_path = COALESCE(excluded.workspace_path, task_session_recovery.workspace_path),
  pool_id = COALESCE(excluded.pool_id, task_session_recovery.pool_id),
  transcript_path = COALESCE(excluded.transcript_path, task_session_recovery.transcript_path),
  crash_preserved_at = COALESCE(excluded.crash_preserved_at, task_session_recovery.crash_preserved_at),
  crash_report_path = COALESCE(excluded.crash_report_path, task_session_recovery.crash_report_path),
  crash_diagnostic_summary = COALESCE(
    excluded.crash_diagnostic_summary,
    task_session_recovery.crash_diagnostic_summary
  ),
  updated_at = excluded.updated_at`;

export function sessionRecoveryUpsertParams(input: {
  workflowId: string;
  agentSessionId: string;
  taskId?: string | null;
  configDir?: string | null;
  workspacePath?: string | null;
  poolId?: string | null;
  transcriptPath?: string | null;
  crashPreservedAt?: string | null;
  crashReportPath?: string | null;
  crashDiagnosticSummary?: string | null;
}): unknown[] {
  return [
    input.workflowId,
    input.agentSessionId,
    input.taskId ?? null,
    input.configDir ?? null,
    input.workspacePath ?? null,
    input.poolId ?? null,
    input.transcriptPath ?? null,
    input.crashPreservedAt ?? null,
    input.crashReportPath ?? null,
    input.crashDiagnosticSummary ?? null,
  ];
}

export function upsertTaskSessionRecovery(
  exec: SqliteExecutor,
  input: {
    workflowId: string;
    agentSessionId: string;
    taskId?: string | null;
    configDir?: string | null;
    workspacePath?: string | null;
    poolId?: string | null;
    transcriptPath?: string | null;
    crashPreservedAt?: string | null;
    crashReportPath?: string | null;
    crashDiagnosticSummary?: string | null;
  },
): void {
  const agentSessionId = normalizeAgentSessionId(input.agentSessionId);
  if (!agentSessionId || !input.workflowId) return;
  exec.execRun(UPSERT_SESSION_RECOVERY_SQL, sessionRecoveryUpsertParams({
    ...input,
    agentSessionId,
  }));
}

export function preserveTaskSessionRecoveryForWorkflow(
  exec: SqliteExecutor,
  workflowId: string,
  configDir?: string | null,
): void {
  exec.execRun(
    `INSERT INTO task_session_recovery (
      workflow_id, agent_session_id, task_id, config_dir, workspace_path, pool_id,
      crash_preserved_at, crash_report_path, crash_diagnostic_summary,
      created_at, updated_at
    )
    SELECT
      t.workflow_id,
      sid.agent_session_id,
      t.id,
      ?,
      t.workspace_path,
      t.pool_id,
      cp.preserved_at,
      cp.diagnostic_report_path,
      cp.diagnostic_summary,
      datetime('now'),
      datetime('now')
    FROM tasks t
    JOIN (
      SELECT id AS task_id,
        CASE
          WHEN agent_session_id IS NOT NULL
            AND trim(agent_session_id) != ''
            AND agent_session_id != 'none'
            THEN agent_session_id
          WHEN last_agent_session_id IS NOT NULL
            AND trim(last_agent_session_id) != ''
            AND last_agent_session_id != 'none'
            THEN last_agent_session_id
          WHEN claude_session_id IS NOT NULL
            AND trim(claude_session_id) != ''
            AND claude_session_id != 'none'
            THEN claude_session_id
          ELSE NULL
        END AS agent_session_id
      FROM tasks
      WHERE workflow_id = ?
    ) sid ON sid.task_id = t.id
    LEFT JOIN task_crash_preservation cp ON cp.task_id = t.id
    WHERE t.workflow_id = ?
      AND sid.agent_session_id IS NOT NULL
    ON CONFLICT(workflow_id, agent_session_id) DO UPDATE SET
      task_id = COALESCE(excluded.task_id, task_session_recovery.task_id),
      config_dir = COALESCE(excluded.config_dir, task_session_recovery.config_dir),
      workspace_path = COALESCE(excluded.workspace_path, task_session_recovery.workspace_path),
      pool_id = COALESCE(excluded.pool_id, task_session_recovery.pool_id),
      crash_preserved_at = COALESCE(excluded.crash_preserved_at, task_session_recovery.crash_preserved_at),
      crash_report_path = COALESCE(excluded.crash_report_path, task_session_recovery.crash_report_path),
      crash_diagnostic_summary = COALESCE(
        excluded.crash_diagnostic_summary,
        task_session_recovery.crash_diagnostic_summary
      ),
      updated_at = excluded.updated_at`,
    [configDir ?? null, workflowId, workflowId],
  );
}
