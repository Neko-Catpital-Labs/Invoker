/**
 * SQLiteAdapter — PersistenceAdapter backed by sql.js (WASM SQLite).
 *
 * Uses `:memory:` for testing, file path for production.
 * Construction is async (WASM init), all operations after init are synchronous.
 */

import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TaskState, TaskStateChanges, Attempt } from '@invoker/core';
import { normalizeFamiliarType } from '@invoker/core';
import type { PersistenceAdapter, Workflow, TaskEvent, ActivityLogEntry, Conversation, ConversationMessage } from './adapter.js';

/**
 * Rewrite `pnpm test packages/<pkg>/...` (incorrect root-level invocation)
 * to `cd packages/<pkg> && pnpm test -- <relative-path>`.
 */
function rewritePnpmTestCommand(cmd: string): string {
  const withFile = cmd.match(/^(pnpm test)\s+(?:--\s+)?packages\/([^/\s]+)\/(\S+)(.*)/);
  if (withFile) {
    const [, , pkg, rest, suffix] = withFile;
    return `cd packages/${pkg} && pnpm test -- ${rest}${suffix}`;
  }
  const pkgOnly = cmd.match(/^(pnpm test)\s+(?:--\s+)?packages\/([^/\s]+)(.*)/);
  if (pkgOnly) {
    const [, , pkg, suffix] = pkgOnly;
    return `cd packages/${pkg} && pnpm test${suffix}`;
  }
  return cmd;
}

/** Cached sql.js init promise — WASM is loaded only once per process. */
let sqlJsPromise: ReturnType<typeof initSqlJs> | null = null;

export class SQLiteAdapter implements PersistenceAdapter {
  private db: SqlJsDatabase;
  private dbPath: string | null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Use SQLiteAdapter.create() instead. */
  private constructor(db: SqlJsDatabase, dbPath: string | null) {
    this.db = db;
    this.dbPath = dbPath;
    this.db.run('PRAGMA foreign_keys = ON');
    this.initSchema();
    this.migrate();
  }

  /**
   * Async factory — loads WASM once, opens or creates the database.
   * If the on-disk file is corrupted, backs it up and starts fresh.
   * @param dbPath File path or ':memory:' (default).
   */
  static async create(dbPath: string = ':memory:'): Promise<SQLiteAdapter> {
    if (!sqlJsPromise) {
      sqlJsPromise = initSqlJs();
    }
    const SQL = await sqlJsPromise;

    const isFile = dbPath !== ':memory:';

    if (isFile && existsSync(dbPath)) {
      const buffer = readFileSync(dbPath);
      try {
        const db = new SQL.Database(buffer);
        return new SQLiteAdapter(db, dbPath);
      } catch (err) {
        const backupPath = `${dbPath}.corrupt-${Date.now()}`;
        console.error(
          `[SQLiteAdapter] Database corrupted (${err instanceof Error ? err.message : String(err)}). ` +
          `Backing up to ${backupPath} and starting fresh.`,
        );
        renameSync(dbPath, backupPath);
      }
    }

    const db = new SQL.Database();
    return new SQLiteAdapter(db, isFile ? dbPath : null);
  }

  // ── sql.js Helpers ───────────────────────────────────────

  /** Run a single-row SELECT, returning the row as an object or undefined. */
  private queryOne(sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as any[]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row as Record<string, unknown>;
    }
    stmt.free();
    return undefined;
  }

  /** Run a multi-row SELECT, returning an array of row objects. */
  private queryAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as any[]);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as Record<string, unknown>);
    }
    stmt.free();
    return rows;
  }

  /** Run an INSERT/UPDATE/DELETE and schedule a flush. */
  private execRun(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as any[]);
    this.scheduleFlush();
  }

  /** Flush DB to disk (no-op for :memory:). */
  private flush(): void {
    if (!this.dbPath) return;
    const dir = dirname(this.dbPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  /** Debounced flush — coalesces rapid writes into a single I/O. */
  private scheduleFlush(): void {
    if (!this.dbPath) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flush();
      this.flushTimer = null;
    }, 1000);
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'running',
        plan_file TEXT,
        repo_url TEXT,
        branch TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        blocked_by TEXT,
        dependencies TEXT DEFAULT '[]',
        command TEXT,
        prompt TEXT,
        exit_code INTEGER,
        error TEXT,
        input_prompt TEXT,

        -- Context
        summary TEXT,
        problem TEXT,
        approach TEXT,
        test_plan TEXT,
        repro_command TEXT,

        -- Git
        branch TEXT,
        commit_hash TEXT,
        parent_task TEXT,

        -- Experiments
        pivot INTEGER DEFAULT 0,
        experiment_variants TEXT,
        is_reconciliation INTEGER DEFAULT 0,
        selected_experiment TEXT,
        experiment_results TEXT,
        requires_manual_approval INTEGER DEFAULT 0,

        -- Repository
        repo_url TEXT,
        feature_branch TEXT,

        -- Merge node
        is_merge_node INTEGER DEFAULT 0,

        -- Claude session
        claude_session_id TEXT,
        workspace_path TEXT,

        -- Timestamps
        created_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,

        FOREIGN KEY (workflow_id) REFERENCES workflows(id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        source TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        thread_ts TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        extracted_plan TEXT,
        plan_submitted INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_ts TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (thread_ts) REFERENCES conversations(thread_ts)
      );

      CREATE INDEX IF NOT EXISTS idx_conv_messages_thread
        ON conversation_messages(thread_ts, seq);

      CREATE TABLE IF NOT EXISTS task_output (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_task_output_task
        ON task_output(task_id);

      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',

        -- Input snapshot
        snapshot_commit TEXT,
        base_branch TEXT,
        upstream_attempt_ids TEXT DEFAULT '[]',

        -- Overrides
        command_override TEXT,
        prompt_override TEXT,

        -- Execution state
        started_at TEXT,
        completed_at TEXT,
        exit_code INTEGER,
        error TEXT,
        last_heartbeat_at TEXT,

        -- Output
        branch TEXT,
        commit_hash TEXT,
        summary TEXT,
        workspace_path TEXT,
        claude_session_id TEXT,
        container_id TEXT,

        -- Lineage
        supersedes_attempt_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),

        -- Merge conflict
        merge_conflict TEXT,

        FOREIGN KEY (node_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_attempts_node
        ON attempts(node_id, attempt_number);
    `);
  }

  /** Add columns that may not exist in older databases. */
  private migrate(): void {
    const migrations = [
      'ALTER TABLE tasks ADD COLUMN claude_session_id TEXT',
      'ALTER TABLE tasks ADD COLUMN workspace_path TEXT',
      'ALTER TABLE tasks ADD COLUMN familiar_type TEXT',
      'ALTER TABLE tasks ADD COLUMN container_id TEXT',
      'ALTER TABLE tasks ADD COLUMN is_merge_node INTEGER DEFAULT 0',
      'ALTER TABLE workflows ADD COLUMN on_finish TEXT',
      'ALTER TABLE workflows ADD COLUMN base_branch TEXT',
      'ALTER TABLE workflows ADD COLUMN feature_branch TEXT',
      'ALTER TABLE workflows ADD COLUMN generation INTEGER DEFAULT 0',
      'ALTER TABLE tasks ADD COLUMN last_heartbeat_at TEXT',
      'ALTER TABLE tasks ADD COLUMN experiment_prompt TEXT',
      'ALTER TABLE tasks ADD COLUMN auto_fix INTEGER DEFAULT 0',
      'ALTER TABLE tasks ADD COLUMN max_fix_attempts INTEGER',
      'ALTER TABLE tasks ADD COLUMN action_request_id TEXT',
      'ALTER TABLE tasks ADD COLUMN experiments TEXT',
      'ALTER TABLE tasks ADD COLUMN selected_experiments TEXT',
      'ALTER TABLE tasks ADD COLUMN utilization INTEGER',
      'ALTER TABLE tasks ADD COLUMN pending_fix_error TEXT',
      'ALTER TABLE workflows ADD COLUMN merge_mode TEXT',
      'ALTER TABLE tasks ADD COLUMN review_url TEXT',
      'ALTER TABLE tasks ADD COLUMN review_id TEXT',
      'ALTER TABLE tasks ADD COLUMN review_status TEXT',
      'ALTER TABLE tasks ADD COLUMN review_provider_id TEXT',
      'ALTER TABLE tasks ADD COLUMN is_fixing_with_ai INTEGER DEFAULT 0',
      'ALTER TABLE tasks ADD COLUMN selected_attempt_id TEXT',
      'ALTER TABLE tasks ADD COLUMN remote_target_id TEXT',
      'ALTER TABLE workflows ADD COLUMN description TEXT',
      'ALTER TABLE workflows ADD COLUMN visual_proof INTEGER',
      // agent_session_id: new column for pluggable agent architecture
      'ALTER TABLE tasks ADD COLUMN agent_session_id TEXT',
      'ALTER TABLE attempts ADD COLUMN agent_session_id TEXT',
      'ALTER TABLE workflows ADD COLUMN review_provider TEXT',
    ];
    for (const sql of migrations) {
      try { this.db.run(sql); } catch { /* Column already exists */ }
    }

    this.migrateTestCommands();
  }

  /**
   * Rewrite `pnpm test packages/<pkg>/...` (incorrect root-level invocation)
   * to `cd packages/<pkg> && pnpm test -- <relative-path>`.
   * Idempotent: already-rewritten commands won't match the LIKE pattern.
   */
  private migrateTestCommands(): void {
    try {
      const rows = this.queryAll(
        `SELECT id, command FROM tasks WHERE command LIKE 'pnpm test packages/%' OR command LIKE 'pnpm test -- packages/%'`,
      ) as Array<{ id: string; command: string }>;

      for (const row of rows) {
        const fixed = rewritePnpmTestCommand(row.command);
        if (fixed !== row.command) {
          this.execRun('UPDATE tasks SET command = ? WHERE id = ?', [fixed, row.id]);
        }
      }
    } catch {
      // Table may not exist yet on first run
    }
  }

  // ── Workflows ─────────────────────────────────────────

  saveWorkflow(workflow: Workflow): void {
    this.execRun(`
      INSERT OR REPLACE INTO workflows (id, name, description, visual_proof, status, plan_file, repo_url, branch, on_finish, base_branch, feature_branch, merge_mode, review_provider, generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      workflow.id, workflow.name,
      workflow.description ?? null,
      workflow.visualProof ? 1 : 0,
      workflow.status,
      workflow.planFile ?? null, workflow.repoUrl ?? null, workflow.branch ?? null,
      workflow.onFinish ?? null, workflow.baseBranch ?? null, workflow.featureBranch ?? null,
      workflow.mergeMode ?? null,
      workflow.reviewProvider ?? null,
      workflow.generation ?? 0,
      workflow.createdAt, workflow.updatedAt,
    ]);
  }

  updateWorkflow(workflowId: string, changes: Partial<Pick<Workflow, 'status' | 'updatedAt' | 'baseBranch' | 'generation' | 'mergeMode'>>): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    if (changes.status !== undefined) {
      setClauses.push('status = ?');
      values.push(changes.status);
    }
    if (changes.baseBranch !== undefined) {
      setClauses.push('base_branch = ?');
      values.push(changes.baseBranch);
    }
    if (changes.generation !== undefined) {
      setClauses.push('generation = ?');
      values.push(changes.generation);
    }
    if (changes.mergeMode !== undefined) {
      setClauses.push('merge_mode = ?');
      values.push(changes.mergeMode);
    }
    setClauses.push('updated_at = ?');
    values.push(changes.updatedAt ?? new Date().toISOString());
    if (setClauses.length === 0) return;
    values.push(workflowId);
    this.execRun(`UPDATE workflows SET ${setClauses.join(', ')} WHERE id = ?`, values);
  }

  loadWorkflow(workflowId: string): Workflow | undefined {
    const row = this.queryOne('SELECT * FROM workflows WHERE id = ?', [workflowId]);
    if (!row) return undefined;
    return this.rowToWorkflow(row);
  }

  listWorkflows(): Workflow[] {
    const rows = this.queryAll(
      'SELECT * FROM workflows ORDER BY created_at DESC',
    );
    return rows.map((row: any) => this.rowToWorkflow(row));
  }

  // ── Tasks ─────────────────────────────────────────────

  saveTask(workflowId: string, task: TaskState): void {
    const cfg = task.config;
    const exec = task.execution;
    this.execRun(`
      INSERT OR REPLACE INTO tasks (
        id, workflow_id, description, status, blocked_by, dependencies,
        command, prompt, experiment_prompt, exit_code, error, input_prompt,
        summary, problem, approach, test_plan, repro_command,
        branch, commit_hash, parent_task,
        pivot, experiment_variants, is_reconciliation, selected_experiment,
        selected_experiments, experiment_results, requires_manual_approval,
        repo_url, feature_branch,
        is_merge_node, auto_fix, max_fix_attempts,
        familiar_type, agent_session_id, workspace_path, container_id,
        action_request_id, experiments,
        created_at, started_at, completed_at, last_heartbeat_at,
        utilization, pending_fix_error,
        review_url, review_id, review_status, review_provider_id,
        is_fixing_with_ai,
        remote_target_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?,
        ?
      )
    `, [
      task.id, workflowId, task.description, task.status,
      exec.blockedBy ?? null,
      JSON.stringify(task.dependencies),
      cfg.command ?? null, cfg.prompt ?? null, cfg.experimentPrompt ?? null,
      exec.exitCode ?? null, exec.error ?? null, exec.inputPrompt ?? null,
      cfg.summary ?? null, cfg.problem ?? null, cfg.approach ?? null,
      cfg.testPlan ?? null, cfg.reproCommand ?? null,
      exec.branch ?? null, exec.commit ?? null, cfg.parentTask ?? null,
      cfg.pivot ? 1 : 0,
      cfg.experimentVariants ? JSON.stringify(cfg.experimentVariants) : null,
      cfg.isReconciliation ? 1 : 0,
      exec.selectedExperiment ?? null,
      exec.selectedExperiments ? JSON.stringify(exec.selectedExperiments) : null,
      exec.experimentResults ? JSON.stringify(exec.experimentResults) : null,
      cfg.requiresManualApproval ? 1 : 0,
      null, cfg.featureBranch ?? null,
      cfg.isMergeNode ? 1 : 0,
      cfg.autoFix ? 1 : 0, null,
      cfg.familiarType ?? null,
      exec.agentSessionId ?? null,
      exec.workspacePath ?? null,
      exec.containerId ?? null,
      exec.actionRequestId ?? null,
      exec.experiments ? JSON.stringify(exec.experiments) : null,
      task.createdAt.toISOString(),
      exec.startedAt?.toISOString() ?? null,
      exec.completedAt?.toISOString() ?? null,
      exec.lastHeartbeatAt?.toISOString() ?? null,
      cfg.utilization ?? null,
      exec.pendingFixError ?? null,
      exec.reviewUrl ?? null,
      exec.reviewId ?? null,
      exec.reviewStatus ?? null,
      exec.reviewProviderId ?? null,
      exec.isFixingWithAI ? 1 : 0,
      cfg.remoteTargetId ?? null,
    ]);
  }

  updateTask(taskId: string, changes: TaskStateChanges): void {
    const setClauses: string[] = [];
    const values: any[] = [];

    if (changes.status !== undefined) {
      setClauses.push('status = ?');
      values.push(changes.status);
    }
    if (changes.dependencies !== undefined) {
      setClauses.push('dependencies = ?');
      values.push(JSON.stringify(changes.dependencies));
    }

    if (changes.config) {
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
        familiarType: 'familiar_type',
        remoteTargetId: 'remote_target_id',
      };
      const configBoolMap: Record<string, string> = {
        pivot: 'pivot',
        isReconciliation: 'is_reconciliation',
        requiresManualApproval: 'requires_manual_approval',
        isMergeNode: 'is_merge_node',
        autoFix: 'auto_fix',
      };

      for (const [key, col] of Object.entries(configMap)) {
        if (key in changes.config) {
          setClauses.push(`${col} = ?`);
          values.push((changes.config as any)[key] ?? null);
        }
      }
      for (const [key, col] of Object.entries(configBoolMap)) {
        if (key in changes.config) {
          setClauses.push(`${col} = ?`);
          values.push((changes.config as any)[key] ? 1 : 0);
        }
      }
      if ('utilization' in changes.config) {
        setClauses.push('utilization = ?');
        values.push(changes.config.utilization ?? null);
      }
      if ('experimentVariants' in changes.config) {
        setClauses.push('experiment_variants = ?');
        values.push(changes.config.experimentVariants ? JSON.stringify(changes.config.experimentVariants) : null);
      }
    }

    if (changes.execution) {
      const execMap: Record<string, string> = {
        blockedBy: 'blocked_by',
        inputPrompt: 'input_prompt',
        exitCode: 'exit_code',
        error: 'error',
        actionRequestId: 'action_request_id',
        branch: 'branch',
        commit: 'commit_hash',
        agentSessionId: 'agent_session_id',
        workspacePath: 'workspace_path',
        containerId: 'container_id',
        selectedExperiment: 'selected_experiment',
        pendingFixError: 'pending_fix_error',
        reviewUrl: 'review_url',
        reviewId: 'review_id',
        reviewStatus: 'review_status',
        reviewProviderId: 'review_provider_id',
        selectedAttemptId: 'selected_attempt_id',
      };
      const execDateMap: Record<string, string> = {
        startedAt: 'started_at',
        completedAt: 'completed_at',
        lastHeartbeatAt: 'last_heartbeat_at',
      };
      const execJsonFields: Record<string, string> = {
        experiments: 'experiments',
        selectedExperiments: 'selected_experiments',
        experimentResults: 'experiment_results',
      };

      for (const [key, col] of Object.entries(execMap)) {
        if (key in changes.execution) {
          setClauses.push(`${col} = ?`);
          values.push((changes.execution as any)[key] ?? null);
        }
      }
      for (const [key, col] of Object.entries(execDateMap)) {
        if (key in changes.execution) {
          setClauses.push(`${col} = ?`);
          const val = (changes.execution as any)[key];
          values.push(val instanceof Date ? val.toISOString() : val ?? null);
        }
      }
      for (const [key, col] of Object.entries(execJsonFields)) {
        if (key in changes.execution) {
          setClauses.push(`${col} = ?`);
          const val = (changes.execution as any)[key];
          values.push(val ? JSON.stringify(val) : null);
        }
      }
      const execBoolMap: Record<string, string> = {
        isFixingWithAI: 'is_fixing_with_ai',
      };
      for (const [key, col] of Object.entries(execBoolMap)) {
        if (key in changes.execution) {
          setClauses.push(`${col} = ?`);
          values.push((changes.execution as any)[key] ? 1 : 0);
        }
      }
    }

    if (setClauses.length === 0) return;

    if (changes.execution && 'workspacePath' in changes.execution) {
      try {
        const row = this.queryOne(
          'SELECT is_merge_node AS isMerge, workspace_path AS prevPath FROM tasks WHERE id = ?',
          [taskId],
        ) as { isMerge?: number; prevPath?: string | null } | undefined;
        if (row?.isMerge === 1) {
          const nextWs = (changes.execution as { workspacePath?: string }).workspacePath;
          console.log(
            `[merge-gate-workspace] sqlite.updateTask mergeNode task=${taskId} ` +
              `workspace_path ${row.prevPath ?? 'NULL'} → ${nextWs ?? 'NULL'} ` +
              '(caller sets familiar worktree path and/or gate clone path)',
          );
        }
      } catch {
        /* best-effort diagnostics only */
      }
    }

    values.push(taskId);
    this.execRun(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`, values);
  }

  loadTasks(workflowId: string): TaskState[] {
    const rows = this.queryAll('SELECT * FROM tasks WHERE workflow_id = ?', [workflowId]);
    return rows.map(this.rowToTask);
  }

  getAllTaskIds(): string[] {
    const rows = this.queryAll('SELECT id FROM tasks') as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  getAllTaskBranches(): string[] {
    const rows = this.queryAll(
      'SELECT DISTINCT branch FROM tasks WHERE branch IS NOT NULL',
    ) as Array<{ branch: string }>;
    return rows.map((r) => r.branch);
  }

  loadAllCompletedTasks(): Array<TaskState & { workflowName: string }> {
    const rows = this.queryAll(`
      SELECT t.*, w.name AS workflow_name
      FROM tasks t
      JOIN workflows w ON w.id = t.workflow_id
      WHERE t.status = 'completed'
      ORDER BY t.completed_at DESC
    `);
    return rows.map((row: any) => ({
      ...this.rowToTask(row),
      workflowName: row.workflow_name,
    }));
  }

  deleteAllTasks(workflowId: string): void {
    this.execRun('DELETE FROM tasks WHERE workflow_id = ?', [workflowId]);
  }

  deleteAllWorkflows(): void {
    this.db.run('DELETE FROM events');
    this.db.run('DELETE FROM task_output');
    this.db.run('DELETE FROM attempts');
    this.db.run('DELETE FROM tasks');
    this.db.run('DELETE FROM workflows');
    this.scheduleFlush();
  }

  deleteWorkflow(workflowId: string): void {
    this.db.run('BEGIN');
    try {
      // Delete events first (FK constraint: events -> tasks)
      this.db.run(`
        DELETE FROM events WHERE task_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId]);

      // Delete task output (FK constraint: task_output -> tasks)
      this.db.run(`
        DELETE FROM task_output WHERE task_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId]);

      // Delete attempts (FK constraint: attempts -> tasks)
      this.db.run(`
        DELETE FROM attempts WHERE node_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId]);

      // Delete tasks (FK constraint: tasks -> workflows)
      this.db.run('DELETE FROM tasks WHERE workflow_id = ?', [workflowId]);

      // Finally delete the workflow
      this.db.run('DELETE FROM workflows WHERE id = ?', [workflowId]);

      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleFlush();
  }

  // ── Events ────────────────────────────────────────────

  logEvent(taskId: string, eventType: string, payload?: unknown): void {
    this.execRun(`
      INSERT INTO events (task_id, event_type, payload)
      VALUES (?, ?, ?)
    `, [taskId, eventType, payload ? JSON.stringify(payload) : null]);
  }

  getEvents(taskId: string): TaskEvent[] {
    const rows = this.queryAll(
      'SELECT * FROM events WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    );
    return rows.map((row: any) => ({
      id: row.id,
      taskId: row.task_id,
      eventType: row.event_type,
      payload: row.payload ?? undefined,
      createdAt: row.created_at,
    }));
  }

  // ── Queries ─────────────────────────────────────────

  getSelectedExperiment(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT selected_experiment FROM tasks WHERE id = ?',
      [taskId],
    );
    return (row?.selected_experiment as string) ?? null;
  }

  getWorkspacePath(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT workspace_path FROM tasks WHERE id = ?',
      [taskId],
    );
    return (row?.workspace_path as string) ?? null;
  }

  getAgentSessionId(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT agent_session_id FROM tasks WHERE id = ?',
      [taskId],
    );
    const val = (row?.agent_session_id as string) ?? null;
    return val === 'none' ? null : val;
  }

  getFamiliarType(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT familiar_type FROM tasks WHERE id = ?',
      [taskId],
    );
    const raw = (row?.familiar_type as string) ?? null;
    if (raw === null) return null;
    return normalizeFamiliarType(raw) ?? raw;
  }

  getTaskStatus(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT status FROM tasks WHERE id = ?',
      [taskId],
    );
    return (row?.status as string) ?? null;
  }

  getContainerId(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT container_id FROM tasks WHERE id = ?',
      [taskId],
    );
    const val = (row?.container_id as string) ?? null;
    return val === 'none' ? null : val;
  }

  getBranch(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT branch FROM tasks WHERE id = ?',
      [taskId],
    );
    return (row?.branch as string) ?? null;
  }

  getRemoteTargetId(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT remote_target_id FROM tasks WHERE id = ?',
      [taskId],
    );
    return (row?.remote_target_id as string) ?? null;
  }

  // ── Conversations ───────────────────────────────────────

  saveConversation(conversation: Conversation): void {
    this.execRun(`
      INSERT OR REPLACE INTO conversations (thread_ts, channel_id, user_id, extracted_plan, plan_submitted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      conversation.threadTs,
      conversation.channelId,
      conversation.userId,
      conversation.extractedPlan,
      conversation.planSubmitted ? 1 : 0,
      conversation.createdAt,
      conversation.updatedAt,
    ]);
  }

  loadConversation(threadTs: string): Conversation | undefined {
    const row = this.queryOne('SELECT * FROM conversations WHERE thread_ts = ?', [threadTs]);
    if (!row) return undefined;
    return {
      threadTs: row.thread_ts as string,
      channelId: row.channel_id as string,
      userId: row.user_id as string,
      extractedPlan: (row.extracted_plan as string) ?? null,
      planSubmitted: row.plan_submitted === 1,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  updateConversation(threadTs: string, changes: Partial<Pick<Conversation, 'extractedPlan' | 'planSubmitted' | 'updatedAt'>>): void {
    const setClauses: string[] = [];
    const values: any[] = [];

    if ('extractedPlan' in changes) {
      setClauses.push('extracted_plan = ?');
      values.push(changes.extractedPlan ?? null);
    }
    if ('planSubmitted' in changes) {
      setClauses.push('plan_submitted = ?');
      values.push(changes.planSubmitted ? 1 : 0);
    }

    // Always bump updated_at
    setClauses.push('updated_at = ?');
    values.push(changes.updatedAt ?? new Date().toISOString());

    if (setClauses.length === 0) return;
    values.push(threadTs);
    this.execRun(`UPDATE conversations SET ${setClauses.join(', ')} WHERE thread_ts = ?`, values);
  }

  deleteConversation(threadTs: string): void {
    this.execRun('DELETE FROM conversation_messages WHERE thread_ts = ?', [threadTs]);
    this.execRun('DELETE FROM conversations WHERE thread_ts = ?', [threadTs]);
  }

  listActiveConversations(): Conversation[] {
    const rows = this.queryAll(
      'SELECT * FROM conversations WHERE plan_submitted = 0 ORDER BY updated_at DESC',
    );
    return rows.map((row: any) => ({
      threadTs: row.thread_ts as string,
      channelId: row.channel_id as string,
      userId: row.user_id as string,
      extractedPlan: (row.extracted_plan as string) ?? null,
      planSubmitted: row.plan_submitted === 1,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }));
  }

  deleteConversationsOlderThan(cutoffIso: string): number {
    // Delete messages first (FK constraint)
    this.db.run(`
      DELETE FROM conversation_messages WHERE thread_ts IN (
        SELECT thread_ts FROM conversations WHERE updated_at < ?
      )
    `, [cutoffIso]);
    this.db.run(
      'DELETE FROM conversations WHERE updated_at < ?',
      [cutoffIso],
    );
    const changes = this.db.getRowsModified();
    this.scheduleFlush();
    return changes;
  }

  // ── Conversation Messages ──────────────────────────────

  appendMessage(threadTs: string, role: 'user' | 'assistant', content: string): void {
    const row = this.queryOne(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM conversation_messages WHERE thread_ts = ?',
      [threadTs],
    ) as { max_seq: number } | undefined;
    const nextSeq = ((row?.max_seq as number) ?? 0) + 1;

    this.execRun(`
      INSERT INTO conversation_messages (thread_ts, seq, role, content)
      VALUES (?, ?, ?, ?)
    `, [threadTs, nextSeq, role, content]);
  }

  loadMessages(threadTs: string): ConversationMessage[] {
    const rows = this.queryAll(
      'SELECT * FROM conversation_messages WHERE thread_ts = ? ORDER BY seq ASC',
      [threadTs],
    );
    return rows.map((row: any) => ({
      id: row.id,
      threadTs: row.thread_ts,
      seq: row.seq,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  // ── Task Output ─────────────────────────────────────

  appendTaskOutput(taskId: string, data: string): void {
    this.execRun(
      'INSERT INTO task_output (task_id, data) VALUES (?, ?)',
      [taskId, data],
    );
  }

  getTaskOutput(taskId: string): string {
    const rows = this.queryAll(
      'SELECT data FROM task_output WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    ) as Array<{ data: string }>;
    return rows.map((r) => r.data).join('');
  }

  // ── Attempts ────────────────────────────────────────────

  saveAttempt(attempt: Attempt): void {
    this.execRun(`
      INSERT OR REPLACE INTO attempts (
        id, node_id, attempt_number, status,
        snapshot_commit, base_branch, upstream_attempt_ids,
        command_override, prompt_override,
        started_at, completed_at, exit_code, error, last_heartbeat_at,
        branch, commit_hash, summary, workspace_path, agent_session_id, container_id,
        supersedes_attempt_id, created_at, merge_conflict
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `, [
      attempt.id, attempt.nodeId, attempt.attemptNumber, attempt.status,
      attempt.snapshotCommit ?? null, attempt.baseBranch ?? null,
      JSON.stringify(attempt.upstreamAttemptIds),
      attempt.commandOverride ?? null, attempt.promptOverride ?? null,
      attempt.startedAt?.toISOString() ?? null,
      attempt.completedAt?.toISOString() ?? null,
      attempt.exitCode ?? null, attempt.error ?? null,
      attempt.lastHeartbeatAt?.toISOString() ?? null,
      attempt.branch ?? null, attempt.commit ?? null, attempt.summary ?? null,
      attempt.workspacePath ?? null, attempt.agentSessionId ?? null,
      attempt.containerId ?? null,
      attempt.supersedesAttemptId ?? null,
      attempt.createdAt.toISOString(),
      attempt.mergeConflict ? JSON.stringify(attempt.mergeConflict) : null,
    ]);
  }

  loadAttempts(nodeId: string): Attempt[] {
    const rows = this.queryAll(
      'SELECT * FROM attempts WHERE node_id = ? ORDER BY attempt_number ASC',
      [nodeId],
    );
    return rows.map(this.rowToAttempt);
  }

  loadAttempt(attemptId: string): Attempt | undefined {
    const row = this.queryOne(
      'SELECT * FROM attempts WHERE id = ?',
      [attemptId],
    );
    if (!row) return undefined;
    return this.rowToAttempt(row);
  }

  updateAttempt(attemptId: string, changes: Partial<Pick<Attempt, 'status' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'branch' | 'commit' | 'summary' | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>): void {
    const setClauses: string[] = [];
    const values: any[] = [];

    if (changes.status !== undefined) { setClauses.push('status = ?'); values.push(changes.status); }
    if (changes.startedAt !== undefined) { setClauses.push('started_at = ?'); values.push(changes.startedAt instanceof Date ? changes.startedAt.toISOString() : changes.startedAt ?? null); }
    if (changes.completedAt !== undefined) { setClauses.push('completed_at = ?'); values.push(changes.completedAt instanceof Date ? changes.completedAt.toISOString() : changes.completedAt ?? null); }
    if (changes.exitCode !== undefined) { setClauses.push('exit_code = ?'); values.push(changes.exitCode); }
    if (changes.error !== undefined) { setClauses.push('error = ?'); values.push(changes.error); }
    if (changes.lastHeartbeatAt !== undefined) { setClauses.push('last_heartbeat_at = ?'); values.push(changes.lastHeartbeatAt instanceof Date ? changes.lastHeartbeatAt.toISOString() : changes.lastHeartbeatAt ?? null); }
    if (changes.branch !== undefined) { setClauses.push('branch = ?'); values.push(changes.branch); }
    if (changes.commit !== undefined) { setClauses.push('commit_hash = ?'); values.push(changes.commit); }
    if (changes.summary !== undefined) { setClauses.push('summary = ?'); values.push(changes.summary); }
    if (changes.workspacePath !== undefined) { setClauses.push('workspace_path = ?'); values.push(changes.workspacePath); }
    if (changes.agentSessionId !== undefined) { setClauses.push('agent_session_id = ?'); values.push(changes.agentSessionId); }
    if (changes.containerId !== undefined) { setClauses.push('container_id = ?'); values.push(changes.containerId); }
    if (changes.mergeConflict !== undefined) { setClauses.push('merge_conflict = ?'); values.push(changes.mergeConflict ? JSON.stringify(changes.mergeConflict) : null); }

    if (setClauses.length === 0) return;
    values.push(attemptId);
    this.execRun(`UPDATE attempts SET ${setClauses.join(', ')} WHERE id = ?`, values);
  }

  // ── Activity Log ─────────────────────────────────────

  writeActivityLog(source: string, level: string, message: string): void {
    this.execRun(
      'INSERT INTO activity_log (source, level, message) VALUES (?, ?, ?)',
      [source, level, message],
    );
  }

  getActivityLogs(sinceId = 0, limit = 200): ActivityLogEntry[] {
    const rows = this.queryAll(
      'SELECT * FROM activity_log WHERE id > ? ORDER BY id ASC LIMIT ?',
      [sinceId, limit],
    );
    return rows.map((row: any) => ({
      id: row.id,
      timestamp: row.timestamp,
      source: row.source,
      level: row.level,
      message: row.message,
    }));
  }

  // ── Lifecycle ─────────────────────────────────────────

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    this.db.close();
  }

  // ── Helpers ───────────────────────────────────────────

  private rowToWorkflow(row: any): Workflow {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      visualProof: row.visual_proof === 1,
      status: row.status,
      planFile: row.plan_file ?? undefined,
      repoUrl: row.repo_url ?? undefined,
      branch: row.branch ?? undefined,
      onFinish: row.on_finish ?? undefined,
      baseBranch: row.base_branch ?? undefined,
      featureBranch: row.feature_branch ?? undefined,
      mergeMode: row.merge_mode ?? undefined,
      reviewProvider: row.review_provider ?? undefined,
      generation: row.generation ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToTask(row: any): TaskState {
    return {
      id: row.id,
      description: row.description,
      status: row.status,
      dependencies: JSON.parse(row.dependencies || '[]'),
      createdAt: new Date(row.created_at),
      config: {
        workflowId: row.workflow_id ?? undefined,
        parentTask: row.parent_task ?? undefined,
        command: row.command ?? undefined,
        prompt: row.prompt ?? undefined,
        experimentPrompt: row.experiment_prompt ?? undefined,
        pivot: row.pivot === 1 ? true : undefined,
        experimentVariants: row.experiment_variants ? JSON.parse(row.experiment_variants) : undefined,
        isReconciliation: row.is_reconciliation === 1 ? true : undefined,
        requiresManualApproval: row.requires_manual_approval === 1 ? true : undefined,
        featureBranch: row.feature_branch ?? undefined,
        familiarType: normalizeFamiliarType(row.familiar_type ?? undefined),
        remoteTargetId: row.remote_target_id ?? undefined,
        autoFix: row.auto_fix === 1 ? true : undefined,
        isMergeNode: row.is_merge_node === 1 ? true : undefined,
        summary: row.summary ?? undefined,
        problem: row.problem ?? undefined,
        approach: row.approach ?? undefined,
        testPlan: row.test_plan ?? undefined,
        reproCommand: row.repro_command ?? undefined,
        utilization: row.utilization ?? undefined,
      },
      execution: {
        blockedBy: row.blocked_by ?? undefined,
        inputPrompt: row.input_prompt ?? undefined,
        exitCode: row.exit_code ?? undefined,
        error: row.error ?? undefined,
        startedAt: row.started_at ? new Date(row.started_at) : undefined,
        completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
        lastHeartbeatAt: row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : undefined,
        actionRequestId: row.action_request_id ?? undefined,
        branch: row.branch ?? undefined,
        commit: row.commit_hash ?? undefined,
        agentSessionId: row.agent_session_id || undefined,
        workspacePath: row.workspace_path ?? undefined,
        containerId: row.container_id ?? undefined,
        experiments: row.experiments ? JSON.parse(row.experiments) : undefined,
        selectedExperiment: row.selected_experiment ?? undefined,
        selectedExperiments: row.selected_experiments ? JSON.parse(row.selected_experiments) : undefined,
        experimentResults: row.experiment_results ? JSON.parse(row.experiment_results) : undefined,
        pendingFixError: row.pending_fix_error ?? undefined,
        isFixingWithAI: row.is_fixing_with_ai ? true : undefined,
        reviewUrl: row.review_url ?? undefined,
        reviewId: row.review_id ?? undefined,
        reviewStatus: row.review_status ?? undefined,
        reviewProviderId: row.review_provider_id ?? undefined,
        selectedAttemptId: row.selected_attempt_id ?? undefined,
      },
    };
  }

  private rowToAttempt(row: any): Attempt {
    return {
      id: row.id,
      nodeId: row.node_id,
      attemptNumber: row.attempt_number,
      status: row.status,
      snapshotCommit: row.snapshot_commit ?? undefined,
      baseBranch: row.base_branch ?? undefined,
      upstreamAttemptIds: JSON.parse(row.upstream_attempt_ids || '[]'),
      commandOverride: row.command_override ?? undefined,
      promptOverride: row.prompt_override ?? undefined,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      exitCode: row.exit_code ?? undefined,
      error: row.error ?? undefined,
      lastHeartbeatAt: row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : undefined,
      branch: row.branch ?? undefined,
      commit: row.commit_hash ?? undefined,
      summary: row.summary ?? undefined,
      workspacePath: row.workspace_path ?? undefined,
      agentSessionId: row.agent_session_id || undefined,
      containerId: row.container_id ?? undefined,
      supersedesAttemptId: row.supersedes_attempt_id ?? undefined,
      createdAt: new Date(row.created_at),
      mergeConflict: row.merge_conflict ? JSON.parse(row.merge_conflict) : undefined,
    };
  }
}
