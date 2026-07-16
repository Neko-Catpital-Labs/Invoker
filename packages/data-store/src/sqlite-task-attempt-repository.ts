/**
 * SqliteTaskAttemptRepository — task and attempt CRUD, scalar task-column
 * getters, and the task↔attempt reconciliation/failure paths, extracted from
 * SQLiteAdapter as a class over a {@link SqliteExecutor} context.
 *
 * Tasks and attempts live together because reconcileTaskFromSelectedAttempt,
 * failTaskAndAttempt, and claimAttemptForLaunch span both tables inside single
 * transactions. Row mapping keeps coming from sqlite-row-mappers.ts; the
 * adapter retains one-line delegates for every method here.
 */
import type { TaskState, TaskStateChanges, Attempt, TaskExecution } from '@invoker/workflow-core';
import {
  assertTaskConsistent,
  isDiscardedAttempt,
  normalizeRunnerKind,
} from '@invoker/workflow-core';
import { mapRowToTask, mapRowToAttempt } from './sqlite-row-mappers.js';
import type { SqliteExecutor } from './sqlite-executor.js';

const ACTION_GRAPH_RECENT_ATTEMPT_LIMIT = 3;

/**
 * Adapter-side task/attempt mutators that {@link SqliteTaskAttemptRepository.failTaskAndAttempt}
 * dispatches through inside its shared transaction. The adapter supplies its own
 * updateTask/updateAttempt so instance-level overrides of those methods remain
 * honored — matching the pre-extraction behavior where failTaskAndAttempt called
 * the adapter's own methods (tests inject a mid-transaction fault by overriding
 * updateAttempt on the adapter instance).
 */
export interface TaskAttemptMutators {
  updateTask(taskId: string, changes: TaskStateChanges): void;
  updateAttempt(
    attemptId: string,
    changes: Partial<Pick<Attempt, 'status' | 'claimedAt' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'leaseExpiresAt' | 'branch' | 'commit' | 'summary' | 'queuePriority' | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>,
  ): void;
}

export class SqliteTaskAttemptRepository {
  constructor(
    private readonly exec: SqliteExecutor,
    private readonly mutators: TaskAttemptMutators,
  ) {}

  private hasCrashPreservationTableCache: boolean | null = null;

  private hasCrashPreservationTable(): boolean {
    if (this.hasCrashPreservationTableCache !== null) return this.hasCrashPreservationTableCache;
    const row = this.exec.queryOne(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'task_crash_preservation'",
    ) as { present?: number } | undefined;
    this.hasCrashPreservationTableCache = row?.present === 1;
    return this.hasCrashPreservationTableCache;
  }

  private syncCrashPreservationState(
    taskId: string,
    beforeTask: TaskState | undefined,
    changes: Partial<TaskExecution>,
  ): void {
    const crashKeys = [
      'crashPreservedAt',
      'crashPreservedOwnerPid',
      'crashPreservedReportPath',
      'crashPreservedDiagnosticSummary',
    ] as const satisfies readonly (keyof TaskExecution)[];
    if (!crashKeys.some((key) => key in changes)) return;
    const next = { ...(beforeTask?.execution ?? {}), ...changes };
    if (next.crashPreservedAt instanceof Date) {
      this.exec.execRun(
        `INSERT INTO task_crash_preservation (
            task_id,
            preserved_at,
            owner_pid,
            diagnostic_report_path,
            diagnostic_summary
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            preserved_at = excluded.preserved_at,
            owner_pid = excluded.owner_pid,
            diagnostic_report_path = excluded.diagnostic_report_path,
            diagnostic_summary = excluded.diagnostic_summary`,
        [
          taskId,
          next.crashPreservedAt.toISOString(),
          next.crashPreservedOwnerPid ?? null,
          next.crashPreservedReportPath ?? null,
          next.crashPreservedDiagnosticSummary ?? null,
        ],
      );
      return;
    }
    this.exec.execRun('DELETE FROM task_crash_preservation WHERE task_id = ?', [taskId]);
  }

  private taskSelectColumns(alias: string): string {
    if (!this.hasCrashPreservationTable()) return `${alias}.*`;
    return `${alias}.*,
             cp.preserved_at AS crash_preserved_at,
             cp.owner_pid AS crash_preserved_owner_pid,
             cp.diagnostic_report_path AS crash_preserved_report_path,
             cp.diagnostic_summary AS crash_preserved_diagnostic_summary`;
  }

  private taskSelectJoin(alias: string): string {
    if (!this.hasCrashPreservationTable()) return '';
    return ` LEFT JOIN task_crash_preservation cp ON cp.task_id = ${alias}.id`;
  }

  // ── Task CRUD ────────────────────────────────────────────

  saveTask(workflowId: string, task: TaskState): void {
    assertTaskConsistent(task);
    const cfg = task.config;
    const exec = task.execution;
    this.exec.execRun(`
      INSERT OR REPLACE INTO tasks (
        id, workflow_id, description, status, blocked_by, dependencies,
        command, prompt, experiment_prompt, exit_code, error, protocol_error_code, protocol_error_message, input_prompt, external_dependencies,
        summary, problem, approach, test_plan, repro_command, fix_prompt, fix_context,
        branch, commit_hash, fixed_integration_sha, fixed_integration_recorded_at, fixed_integration_source, parent_task,
        pivot, experiment_variants, is_reconciliation, selected_experiment,
        selected_experiments, experiment_results, requires_manual_approval,
        repo_url, feature_branch,
        is_merge_node, auto_fix, max_fix_attempts,
        runner_kind, pool_id, agent_session_id, workspace_path, container_id,
        last_agent_session_id, last_agent_name,
        action_request_id, experiments,
        created_at, launch_phase, launch_started_at, launch_completed_at, started_at, completed_at, last_heartbeat_at,
        utilization, pending_fix_error, fix_session_entry_status, failure_class,
        review_url, review_id, review_status, review_provider_id, review_gate,
        is_fixing_with_ai,
        execution_generation,
        selected_attempt_id,
        pool_member_id,
        docker_image,
        execution_agent,
        execution_model,
        agent_name,
        task_state_version
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      )
    `, [
      task.id, workflowId, task.description, task.status,
      exec.blockedBy ?? null,
      JSON.stringify(task.dependencies),
      cfg.command ?? null, cfg.prompt ?? null, cfg.experimentPrompt ?? null,
      exec.exitCode ?? null, exec.error ?? null, exec.protocolErrorCode ?? null, exec.protocolErrorMessage ?? null, exec.inputPrompt ?? null,
      null,
      cfg.summary ?? null, cfg.problem ?? null, cfg.approach ?? null,
      cfg.testPlan ?? null, cfg.reproCommand ?? null, cfg.fixPrompt ?? null, cfg.fixContext ?? null,
      exec.branch ?? null,
      exec.commit ?? null,
      exec.fixedIntegrationSha ?? null,
      exec.fixedIntegrationRecordedAt?.toISOString() ?? null,
      exec.fixedIntegrationSource ?? null,
      cfg.parentTask ?? null,
      cfg.pivot ? 1 : 0,
      cfg.experimentVariants ? JSON.stringify(cfg.experimentVariants) : null,
      cfg.isReconciliation ? 1 : 0,
      exec.selectedExperiment ?? null,
      exec.selectedExperiments ? JSON.stringify(exec.selectedExperiments) : null,
      exec.experimentResults ? JSON.stringify(exec.experimentResults) : null,
      cfg.requiresManualApproval ? 1 : 0,
      null, cfg.featureBranch ?? null,
      cfg.isMergeNode ? 1 : 0,
      0, null,
      cfg.runnerKind ?? null,
      cfg.poolId ?? null,
      exec.agentSessionId ?? null,
      exec.workspacePath ?? null,
      exec.containerId ?? null,
      exec.lastAgentSessionId ?? null,
      exec.lastAgentName ?? null,
      exec.actionRequestId ?? null,
      exec.experiments ? JSON.stringify(exec.experiments) : null,
      task.createdAt.toISOString(),
      exec.phase ?? null,
      exec.launchStartedAt?.toISOString() ?? null,
      exec.launchCompletedAt?.toISOString() ?? null,
      exec.startedAt?.toISOString() ?? null,
      exec.completedAt?.toISOString() ?? null,
      exec.lastHeartbeatAt?.toISOString() ?? null,
      null,
      exec.pendingFixError ?? null,
      exec.fixSessionEntryStatus ?? null,
      exec.failureClass ?? null,
      exec.reviewUrl ?? null,
      exec.reviewId ?? null,
      exec.reviewStatus ?? null,
      exec.reviewProviderId ?? null,
      exec.reviewGate ? JSON.stringify(exec.reviewGate) : null,
      exec.isFixingWithAI ? 1 : 0,
      exec.generation ?? 0,
      exec.selectedAttemptId ?? null,
      (cfg as { poolMemberId?: string }).poolMemberId ?? null,
      cfg.dockerImage ?? null,
      cfg.executionAgent ?? null,
      cfg.executionModel ?? null,
      exec.agentName ?? null,
      task.taskStateVersion ?? 1,
    ]);
    this.syncCrashPreservationState(task.id, undefined, task.execution);
  }

  updateTask(taskId: string, changes: TaskStateChanges): void {
    const beforeTask = this.loadTask(taskId);
    if (!beforeTask) return;

    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (changes.description !== undefined) {
      setClauses.push('description = ?');
      values.push(changes.description);
    }
    if (changes.status !== undefined) {
      setClauses.push('status = ?');
      values.push(changes.status);
    }
    if (changes.dependencies !== undefined) {
      setClauses.push('dependencies = ?');
      values.push(JSON.stringify(changes.dependencies));
    }

    if (changes.config) {
      const config = changes.config as Record<string, unknown>;
      const configMap: Record<string, string> = {
        workflowId: 'workflow_id',
        parentTask: 'parent_task',
        command: 'command',
        prompt: 'prompt',
        experimentPrompt: 'experiment_prompt',
        summary: 'summary',
        problem: 'problem',
        approach: 'approach',
        testPlan: 'test_plan',
        reproCommand: 'repro_command',
        featureBranch: 'feature_branch',
        runnerKind: 'runner_kind',
        poolId: 'pool_id',
        poolMemberId: 'pool_member_id',
        dockerImage: 'docker_image',
        executionAgent: 'execution_agent',
        executionModel: 'execution_model',
        fixPrompt: 'fix_prompt',
        fixContext: 'fix_context',
      };
      const configBoolMap: Record<string, string> = {
        pivot: 'pivot',
        isReconciliation: 'is_reconciliation',
        requiresManualApproval: 'requires_manual_approval',
        isMergeNode: 'is_merge_node',
      };

      for (const [key, col] of Object.entries(configMap)) {
        if (key in config) {
          setClauses.push(`${col} = ?`);
          values.push(config[key] ?? null);
        }
      }
      for (const [key, col] of Object.entries(configBoolMap)) {
        if (key in config) {
          setClauses.push(`${col} = ?`);
          values.push(config[key] ? 1 : 0);
        }
      }
      if ('experimentVariants' in changes.config) {
        setClauses.push('experiment_variants = ?');
        values.push(changes.config.experimentVariants ? JSON.stringify(changes.config.experimentVariants) : null);
      }
      if ('externalDependencies' in changes.config) {
        setClauses.push('external_dependencies = ?');
        values.push(changes.config.externalDependencies ? JSON.stringify(changes.config.externalDependencies) : null);
      }
    }

    if (changes.execution) {
      this.syncCrashPreservationState(taskId, beforeTask, changes.execution);
      const execution = changes.execution as Record<string, unknown>;
      const execMap: Record<string, string> = {
        blockedBy: 'blocked_by',
        inputPrompt: 'input_prompt',
        exitCode: 'exit_code',
        error: 'error',
        protocolErrorCode: 'protocol_error_code',
        protocolErrorMessage: 'protocol_error_message',
        actionRequestId: 'action_request_id',
        branch: 'branch',
        commit: 'commit_hash',
        fixedIntegrationSha: 'fixed_integration_sha',
        fixedIntegrationSource: 'fixed_integration_source',
        agentSessionId: 'agent_session_id',
        lastAgentSessionId: 'last_agent_session_id',
        workspacePath: 'workspace_path',
        containerId: 'container_id',
        selectedExperiment: 'selected_experiment',
        fixSessionEntryStatus: 'fix_session_entry_status',
        pendingFixError: 'pending_fix_error',
        failureClass: 'failure_class',
        reviewUrl: 'review_url',
        reviewId: 'review_id',
        reviewStatus: 'review_status',
        reviewProviderId: 'review_provider_id',
        phase: 'launch_phase',
        generation: 'execution_generation',
        selectedAttemptId: 'selected_attempt_id',
        agentName: 'agent_name',
        lastAgentName: 'last_agent_name',
      };
      const execDateMap: Record<string, string> = {
        startedAt: 'started_at',
        completedAt: 'completed_at',
        lastHeartbeatAt: 'last_heartbeat_at',
        launchStartedAt: 'launch_started_at',
        launchCompletedAt: 'launch_completed_at',
        fixedIntegrationRecordedAt: 'fixed_integration_recorded_at',
      };
      const execJsonFields: Record<string, string> = {
        experiments: 'experiments',
        selectedExperiments: 'selected_experiments',
        experimentResults: 'experiment_results',
        reviewGate: 'review_gate',
      };

      for (const [key, col] of Object.entries(execMap)) {
        if (key in execution) {
          setClauses.push(`${col} = ?`);
          values.push(execution[key] ?? null);
        }
      }
      for (const [key, col] of Object.entries(execDateMap)) {
        if (key in execution) {
          setClauses.push(`${col} = ?`);
          const val = execution[key];
          values.push(val instanceof Date ? val.toISOString() : val ?? null);
        }
      }
      for (const [key, col] of Object.entries(execJsonFields)) {
        if (key in execution) {
          setClauses.push(`${col} = ?`);
          const val = execution[key];
          values.push(val ? JSON.stringify(val) : null);
        }
      }
      const execBoolMap: Record<string, string> = {
        isFixingWithAI: 'is_fixing_with_ai',
      };
      for (const [key, col] of Object.entries(execBoolMap)) {
        if (key in execution) {
          setClauses.push(`${col} = ?`);
          values.push(execution[key] ? 1 : 0);
        }
      }
    }


    assertTaskConsistent({
      ...beforeTask,
      ...changes,
      config: changes.config ? ({ ...beforeTask.config, ...changes.config } as TaskState['config']) : beforeTask.config,
      execution: changes.execution ? { ...beforeTask.execution, ...changes.execution } : beforeTask.execution,
    });

    if (setClauses.length === 0) return;

    // Atomically bump task-state version with every mutation
    setClauses.push('task_state_version = task_state_version + 1');

    if (changes.execution && 'workspacePath' in changes.execution) {
      try {
        const row = this.exec.queryOne(
          'SELECT is_merge_node AS isMerge, workspace_path AS prevPath FROM tasks WHERE id = ?',
          [taskId],
        ) as { isMerge?: number; prevPath?: string | null } | undefined;
        if (row?.isMerge === 1) {
          const nextWs = (changes.execution as { workspacePath?: string }).workspacePath;
          console.log(
            `[merge-gate-workspace] sqlite.updateTask mergeNode task=${taskId} ` +
              `workspace_path ${row.prevPath ?? 'NULL'} → ${nextWs ?? 'NULL'} ` +
              '(caller sets executor worktree path and/or gate clone path)',
          );
        }
      } catch {
        /* best-effort diagnostics only */
      }
    }

    values.push(taskId);
    const heartbeatOnly =
      setClauses.length === 1 && setClauses[0].trimStart().startsWith('last_heartbeat_at =');

    if (!heartbeatOnly && process.env.NODE_ENV !== 'test' && process.env.INVOKER_TRACE_PERSIST_SQL === '1') {
      const cols = setClauses.map((c) => c.split(/\s*=\s*/)[0]!.trim()).join(', ');
      console.log(`[persist-sql] taskId=${taskId} columns=[${cols}]`);
    }
    this.exec.execRun(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`, values);
  }

  loadTasks(workflowId: string): TaskState[] {
    const rows = this.exec.queryAll(
      `SELECT ${this.taskSelectColumns('t')}
       FROM tasks t${this.taskSelectJoin('t')}
       WHERE t.workflow_id = ?`,
      [workflowId],
    );
    return rows.map((row) => this.reconcileTaskFromSelectedAttempt(mapRowToTask(row)));
  }

  loadTask(taskId: string): TaskState | undefined {
    const row = this.exec.queryOne(
      `SELECT ${this.taskSelectColumns('t')}
       FROM tasks t${this.taskSelectJoin('t')}
       WHERE t.id = ?`,
      [taskId],
    );
    if (!row) return undefined;
    return this.reconcileTaskFromSelectedAttempt(mapRowToTask(row));
  }

  getAllTaskIds(): string[] {
    const rows = this.exec.queryAll('SELECT id FROM tasks') as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  getAllTaskBranches(): string[] {
    const rows = this.exec.queryAll(
      'SELECT DISTINCT branch FROM tasks WHERE branch IS NOT NULL',
    ) as Array<{ branch: string }>;
    return rows.map((r) => r.branch);
  }

  loadAllCompletedTasks(): Array<TaskState & { workflowName: string }> {
    const rows = this.exec.queryAll(`
      SELECT ${this.taskSelectColumns('t')},
             w.name AS workflow_name
      FROM tasks t${this.taskSelectJoin('t')}
      JOIN workflows w ON w.id = t.workflow_id
      WHERE t.status = 'completed'
      ORDER BY t.completed_at DESC
    `);
    return rows.map((row) => ({
      ...mapRowToTask(row),
      workflowName: row.workflow_name as string,
    }));
  }

  loadAllHistoryTasks(): Array<TaskState & { workflowName: string; lastEventAt: string | null; eventCount: number }> {
    const rows = this.exec.queryAll(`
      SELECT ${this.taskSelectColumns('t')},
             w.name AS workflow_name,
             e.max_created_at AS last_event_at,
             COALESCE(e.event_count, 0) AS event_count
      FROM tasks t${this.taskSelectJoin('t')}
      JOIN workflows w ON w.id = t.workflow_id
      LEFT JOIN (
        SELECT task_id, MAX(created_at) AS max_created_at, COUNT(*) AS event_count
        FROM events
        GROUP BY task_id
      ) e ON e.task_id = t.id
      WHERE COALESCE(e.event_count, 0) > 0 OR t.status != 'pending'
      ORDER BY COALESCE(e.max_created_at, t.completed_at, t.started_at, t.created_at) DESC
    `);
    return rows.map((row) => {
      const task = this.reconcileTaskFromSelectedAttempt(mapRowToTask(row));
      return {
        ...task,
        workflowName: row.workflow_name as string,
        lastEventAt: (row.last_event_at as string | null) ?? null,
        eventCount: Number(row.event_count ?? 0),
      };
    });
  }

  // ── Scalar task-column getters ───────────────────────────

  getSelectedExperiment(taskId: string): string | null {
    const row = this.exec.queryOne(
      'SELECT selected_experiment FROM tasks WHERE id = ?',
      [taskId],
    );
    return (row?.selected_experiment as string) ?? null;
  }

  getWorkspacePath(taskId: string): string | null {
    const row = this.exec.queryOne(
      'SELECT workspace_path FROM tasks WHERE id = ?',
      [taskId],
    );
    return (row?.workspace_path as string) ?? null;
  }

  getAgentSessionId(taskId: string): string | null {
    const row = this.exec.queryOne(
      'SELECT agent_session_id, last_agent_session_id FROM tasks WHERE id = ?',
      [taskId],
    );
    const val = ((row?.agent_session_id as string) ?? (row?.last_agent_session_id as string) ?? null);
    return val === 'none' ? null : val;
  }

  getLastAgentSessionId(taskId: string): string | null {
    const row = this.exec.queryOne(
      'SELECT last_agent_session_id FROM tasks WHERE id = ?',
      [taskId],
    );
    const val = (row?.last_agent_session_id as string) ?? null;
    return val === 'none' ? null : val;
  }

  getRunnerKind(taskId: string): string | null {
    const row = this.exec.queryOne(
      'SELECT runner_kind FROM tasks WHERE id = ?',
      [taskId],
    );
    const raw = (row?.runner_kind as string) ?? null;
    if (raw === null) return null;
    return normalizeRunnerKind(raw) ?? raw;
  }

  getTaskStatus(taskId: string): string | null {
    const row = this.exec.queryOne(
      'SELECT status FROM tasks WHERE id = ?',
      [taskId],
    ) as { status?: string } | undefined;
    if (!row?.status) return null;
    return row.status;
  }

  getContainerId(taskId: string): string | null {
    const row = this.exec.queryOne(
      'SELECT container_id FROM tasks WHERE id = ?',
      [taskId],
    );
    const val = (row?.container_id as string) ?? null;
    return val === 'none' ? null : val;
  }

  getBranch(taskId: string): string | null {
    const row = this.exec.queryOne(
      'SELECT branch FROM tasks WHERE id = ?',
      [taskId],
    );
    return (row?.branch as string) ?? null;
  }

  getExecutionAgent(taskId: string): string | null {
    const row = this.exec.queryOne(
      `
      SELECT
        CASE
          WHEN prompt IS NOT NULL AND TRIM(prompt) != '' THEN COALESCE(execution_agent, agent_name, last_agent_name)
          ELSE COALESCE(agent_name, last_agent_name, execution_agent)
        END AS agent
      FROM tasks
      WHERE id = ?
      `,
      [taskId],
    );
    return (row?.agent as string) ?? null;
  }

  getPoolMemberId(taskId: string): string | null {
    const row = this.exec.queryOne(
      'SELECT pool_member_id FROM tasks WHERE id = ?',
      [taskId],
    );
    return (row?.pool_member_id as string) ?? null;
  }

  // ── Attempt CRUD ─────────────────────────────────────────

  saveAttempt(attempt: Attempt): void {
    this.exec.execRun(`
      INSERT OR REPLACE INTO attempts (
        id, node_id, attempt_number, queue_priority, status,
        snapshot_commit, base_branch, upstream_attempt_ids,
        command_override, prompt_override,
        claimed_at, started_at, completed_at, exit_code, error, last_heartbeat_at, lease_expires_at,
        branch, commit_hash, summary, workspace_path, agent_session_id, container_id,
        supersedes_attempt_id, created_at, merge_conflict
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `, [
      attempt.id, attempt.nodeId, 0, attempt.queuePriority, attempt.status,
      attempt.snapshotCommit ?? null, attempt.baseBranch ?? null,
      JSON.stringify(attempt.upstreamAttemptIds),
      attempt.commandOverride ?? null, attempt.promptOverride ?? null,
      attempt.claimedAt?.toISOString() ?? null,
      attempt.startedAt?.toISOString() ?? null,
      attempt.completedAt?.toISOString() ?? null,
      attempt.exitCode ?? null, attempt.error ?? null,
      attempt.lastHeartbeatAt?.toISOString() ?? null,
      attempt.leaseExpiresAt?.toISOString() ?? null,
      attempt.branch ?? null, attempt.commit ?? null, attempt.summary ?? null,
      attempt.workspacePath ?? null, attempt.agentSessionId ?? null,
      attempt.containerId ?? null,
      attempt.supersedesAttemptId ?? null,
      attempt.createdAt.toISOString(),
      attempt.mergeConflict ? JSON.stringify(attempt.mergeConflict) : null,
    ]);
  }

  loadAttempts(nodeId: string): Attempt[] {
    const rows = this.exec.queryAll(
      'SELECT * FROM attempts WHERE node_id = ? ORDER BY created_at ASC',
      [nodeId],
    );
    return rows.map((row) => mapRowToAttempt(row));
  }

  loadActionGraphAttempts(
    nodeId: string,
    selectedAttemptId?: string,
    recentAttemptLimit = ACTION_GRAPH_RECENT_ATTEMPT_LIMIT,
  ): Attempt[] {
    const limit = Math.max(0, Math.trunc(recentAttemptLimit));
    const rows = this.exec.queryAll(
      `SELECT * FROM attempts
      WHERE node_id = ?
        AND (
          status IN ('pending', 'claimed', 'running', 'needs_input')
          OR id = ?
          OR id IN (
            SELECT id FROM attempts
            WHERE node_id = ?
            ORDER BY created_at DESC
            LIMIT ?
          )
        )
      ORDER BY created_at ASC`,
      [nodeId, selectedAttemptId ?? null, nodeId, limit],
    );
    return rows.map((row) => mapRowToAttempt(row));
  }

  loadAttempt(attemptId: string): Attempt | undefined {
    const row = this.exec.queryOne(
      'SELECT * FROM attempts WHERE id = ?',
      [attemptId],
    );
    if (!row) return undefined;
    return mapRowToAttempt(row);
  }

  updateAttempt(attemptId: string, changes: Partial<Pick<Attempt, 'status' | 'claimedAt' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'leaseExpiresAt' | 'branch' | 'commit' | 'summary' | 'queuePriority' | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (changes.status !== undefined) { setClauses.push('status = ?'); values.push(changes.status); }
    if (changes.claimedAt !== undefined) { setClauses.push('claimed_at = ?'); values.push(changes.claimedAt instanceof Date ? changes.claimedAt.toISOString() : changes.claimedAt ?? null); }
    if (changes.startedAt !== undefined) { setClauses.push('started_at = ?'); values.push(changes.startedAt instanceof Date ? changes.startedAt.toISOString() : changes.startedAt ?? null); }
    if (changes.completedAt !== undefined) { setClauses.push('completed_at = ?'); values.push(changes.completedAt instanceof Date ? changes.completedAt.toISOString() : changes.completedAt ?? null); }
    if (changes.exitCode !== undefined) { setClauses.push('exit_code = ?'); values.push(changes.exitCode); }
    if (changes.error !== undefined) { setClauses.push('error = ?'); values.push(changes.error); }
    if (changes.lastHeartbeatAt !== undefined) { setClauses.push('last_heartbeat_at = ?'); values.push(changes.lastHeartbeatAt instanceof Date ? changes.lastHeartbeatAt.toISOString() : changes.lastHeartbeatAt ?? null); }
    if (changes.leaseExpiresAt !== undefined) { setClauses.push('lease_expires_at = ?'); values.push(changes.leaseExpiresAt instanceof Date ? changes.leaseExpiresAt.toISOString() : changes.leaseExpiresAt ?? null); }
    if (changes.branch !== undefined) { setClauses.push('branch = ?'); values.push(changes.branch); }
    if (changes.commit !== undefined) { setClauses.push('commit_hash = ?'); values.push(changes.commit); }
    if (changes.summary !== undefined) { setClauses.push('summary = ?'); values.push(changes.summary); }
    if (changes.queuePriority !== undefined) { setClauses.push('queue_priority = ?'); values.push(changes.queuePriority); }
    if (changes.workspacePath !== undefined) { setClauses.push('workspace_path = ?'); values.push(changes.workspacePath); }
    if (changes.agentSessionId !== undefined) { setClauses.push('agent_session_id = ?'); values.push(changes.agentSessionId); }
    if (changes.containerId !== undefined) { setClauses.push('container_id = ?'); values.push(changes.containerId); }
    if (changes.mergeConflict !== undefined) { setClauses.push('merge_conflict = ?'); values.push(changes.mergeConflict ? JSON.stringify(changes.mergeConflict) : null); }

    if (setClauses.length === 0) return;
    values.push(attemptId);
    this.exec.execRun(`UPDATE attempts SET ${setClauses.join(', ')} WHERE id = ?`, values);
  }

  claimAttemptForLaunch(
    attemptId: string,
    changes: Partial<Pick<Attempt, 'status' | 'claimedAt' | 'startedAt' | 'lastHeartbeatAt' | 'leaseExpiresAt' | 'queuePriority'>>,
    now: Date,
  ): boolean {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (changes.status !== undefined) { setClauses.push('status = ?'); values.push(changes.status); }
    if (changes.claimedAt !== undefined) { setClauses.push('claimed_at = ?'); values.push(changes.claimedAt instanceof Date ? changes.claimedAt.toISOString() : changes.claimedAt ?? null); }
    if (changes.startedAt !== undefined) { setClauses.push('started_at = ?'); values.push(changes.startedAt instanceof Date ? changes.startedAt.toISOString() : changes.startedAt ?? null); }
    if (changes.lastHeartbeatAt !== undefined) { setClauses.push('last_heartbeat_at = ?'); values.push(changes.lastHeartbeatAt instanceof Date ? changes.lastHeartbeatAt.toISOString() : changes.lastHeartbeatAt ?? null); }
    if (changes.leaseExpiresAt !== undefined) { setClauses.push('lease_expires_at = ?'); values.push(changes.leaseExpiresAt instanceof Date ? changes.leaseExpiresAt.toISOString() : changes.leaseExpiresAt ?? null); }
    if (changes.queuePriority !== undefined) { setClauses.push('queue_priority = ?'); values.push(changes.queuePriority); }

    if (setClauses.length === 0) return false;
    values.push(attemptId, now.toISOString());
    if (this.exec.readOnly) {
      throw new Error('SQLiteAdapter is read-only in this process');
    }
    this.exec.run(
      `UPDATE attempts SET ${setClauses.join(', ')}
       WHERE id = ?
         AND (
           status = 'pending'
           OR (
             status IN ('claimed', 'running')
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= ?
           )
         )`,
      values,
    );
    const claimed = this.exec.getRowsModified() > 0;
    if (claimed) {
      this.exec.markDirty();
    }
    return claimed;
  }

  // ── Task ↔ attempt reconciliation ────────────────────────

  failTaskAndAttempt(
    taskId: string,
    taskChanges: TaskStateChanges,
    attemptPatch: Partial<Pick<Attempt, 'status' | 'exitCode' | 'error' | 'completedAt'>>
  ): void {
    this.exec.runTransaction(() => {
      // Update task state
      this.mutators.updateTask(taskId, taskChanges);

      // Load the latest attempt for this task
      const row = this.exec.queryOne(
        'SELECT id, status FROM attempts WHERE node_id = ? ORDER BY created_at DESC LIMIT 1',
        [taskId],
      ) as { id: string; status: string } | undefined;

      // If there's an active attempt, update it with the failure details.
      // Claimed is included because launch-time failures can happen before
      // the attempt reaches persisted running state.
      if (row && (row.status === 'running' || row.status === 'claimed')) {
        this.mutators.updateAttempt(row.id, attemptPatch);
      }
    });
  }

  reconcileTaskFromSelectedAttempt(task: TaskState): TaskState {
    const attemptId = task.execution.selectedAttemptId;
    if (!attemptId) return task;

    const taskIsTerminal =
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'fixing_with_ai' ||
      task.status === 'needs_input' ||
      task.status === 'awaiting_approval' ||
      task.status === 'review_ready' ||
      task.status === 'stale';
    if (taskIsTerminal) return task;

    const attempt = this.loadAttempt(attemptId);
    if (!attempt) return task;

    if (attempt.status === 'failed' || isDiscardedAttempt(attempt)) {
      const [activeAfter] = this.findActiveAttemptsAfter(task.id, attempt, 1);
      if (activeAfter) {
        const cleaned: TaskState = {
          ...task,
          execution: {
            ...task.execution,
            error: undefined,
            exitCode: undefined,
            completedAt: undefined,
          },
        };
        if (activeAfter.status === 'needs_input') {
          return { ...cleaned, status: 'needs_input' };
        }
        return cleaned;
      }
    }

    if (isDiscardedAttempt(attempt)) {
      return {
        ...task,
        status: 'stale',
      };
    }

    if (attempt.status === 'failed') {
      return {
        ...task,
        status: 'failed',
        execution: {
          ...task.execution,
          exitCode: attempt.exitCode ?? task.execution.exitCode,
          error: attempt.error ?? task.execution.error,
          completedAt: attempt.completedAt ?? task.execution.completedAt,
          lastHeartbeatAt: attempt.lastHeartbeatAt ?? task.execution.lastHeartbeatAt,
          branch: attempt.branch ?? task.execution.branch,
          commit: attempt.commit ?? task.execution.commit,
          workspacePath: attempt.workspacePath ?? task.execution.workspacePath,
          agentSessionId: attempt.agentSessionId ?? task.execution.agentSessionId,
          containerId: attempt.containerId ?? task.execution.containerId,
        },
      };
    }


    if (attempt.status === 'completed') {
      return {
        ...task,
        status: 'completed',
        config: {
          ...task.config,
          summary: attempt.summary ?? task.config.summary,
        },
        execution: {
          ...task.execution,
          exitCode: attempt.exitCode ?? task.execution.exitCode,
          completedAt: attempt.completedAt ?? task.execution.completedAt,
          lastHeartbeatAt: attempt.lastHeartbeatAt ?? task.execution.lastHeartbeatAt,
          branch: attempt.branch ?? task.execution.branch,
          commit: attempt.commit ?? task.execution.commit,
          workspacePath: attempt.workspacePath ?? task.execution.workspacePath,
          agentSessionId: attempt.agentSessionId ?? task.execution.agentSessionId,
          containerId: attempt.containerId ?? task.execution.containerId,
        },
      };
    }

    if (attempt.status === 'needs_input') {
      return {
        ...task,
        status: 'needs_input',
      };
    }

    return task;
  }

  private findActiveAttemptsAfter(nodeId: string, selected: Attempt, limit = 1): Attempt[] {
    const cappedLimit = Math.max(0, Math.floor(limit));
    if (cappedLimit === 0) return [];
    const rows = this.exec.queryAll(
      `SELECT * FROM attempts
       WHERE node_id = ?
         AND created_at > ?
         AND status IN ('pending', 'claimed', 'running', 'needs_input')
       ORDER BY created_at DESC
       LIMIT ?`,
      [nodeId, selected.createdAt.toISOString(), cappedLimit],
    );
    return rows.map((row) => mapRowToAttempt(row));
  }
}
