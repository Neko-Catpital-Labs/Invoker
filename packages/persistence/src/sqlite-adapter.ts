/**
 * SQLiteAdapter — PersistenceAdapter backed by better-sqlite3.
 *
 * Uses `:memory:` for testing, file path for production.
 */

import Database from 'better-sqlite3';
import type { TaskState } from '@invoker/core';
import type { PersistenceAdapter, Workflow, TaskEvent, ActivityLogEntry, Conversation, ConversationMessage } from './adapter.js';

export class SQLiteAdapter implements PersistenceAdapter {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    this.migrate();
  }

  private initSchema(): void {
    this.db.exec(`
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
    ];
    for (const sql of migrations) {
      try { this.db.exec(sql); } catch { /* Column already exists */ }
    }
  }

  // ── Workflows ─────────────────────────────────────────

  saveWorkflow(workflow: Workflow): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO workflows (id, name, status, plan_file, repo_url, branch, on_finish, base_branch, feature_branch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workflow.id, workflow.name, workflow.status,
      workflow.planFile ?? null, workflow.repoUrl ?? null, workflow.branch ?? null,
      workflow.onFinish ?? null, workflow.baseBranch ?? null, workflow.featureBranch ?? null,
      workflow.createdAt, workflow.updatedAt,
    );
  }

  updateWorkflow(workflowId: string, changes: Partial<Pick<Workflow, 'status' | 'updatedAt' | 'baseBranch'>>): void {
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
    setClauses.push('updated_at = ?');
    values.push(changes.updatedAt ?? new Date().toISOString());
    if (setClauses.length === 0) return;
    values.push(workflowId);
    this.db.prepare(`UPDATE workflows SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
  }

  loadWorkflow(workflowId: string): Workflow | undefined {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as any;
    if (!row) return undefined;
    return this.rowToWorkflow(row);
  }

  listWorkflows(): Workflow[] {
    const rows = this.db.prepare(
      'SELECT * FROM workflows ORDER BY created_at DESC',
    ).all() as any[];
    return rows.map((row: any) => this.rowToWorkflow(row));
  }

  // ── Tasks ─────────────────────────────────────────────

  saveTask(workflowId: string, task: TaskState): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO tasks (
        id, workflow_id, description, status, blocked_by, dependencies,
        command, prompt, exit_code, error, input_prompt,
        summary, problem, approach, test_plan, repro_command,
        branch, commit_hash, parent_task,
        pivot, experiment_variants, is_reconciliation, selected_experiment,
        experiment_results, requires_manual_approval,
        repo_url, feature_branch,
        is_merge_node,
        familiar_type, claude_session_id, workspace_path, container_id,
        created_at, started_at, completed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?,
        ?,
        ?, ?, ?, ?,
        ?, ?, ?
      )
    `).run(
      task.id, workflowId, task.description, task.status,
      task.blockedBy ?? null,
      JSON.stringify(task.dependencies),
      task.command ?? null, task.prompt ?? null,
      task.exitCode ?? null, task.error ?? null, task.inputPrompt ?? null,
      task.summary ?? null, task.problem ?? null, task.approach ?? null,
      task.testPlan ?? null, task.reproCommand ?? null,
      task.branch ?? null, task.commit ?? null, task.parentTask ?? null,
      task.pivot ? 1 : 0,
      task.experimentVariants ? JSON.stringify(task.experimentVariants) : null,
      task.isReconciliation ? 1 : 0,
      task.selectedExperiment ?? null,
      task.experimentResults ? JSON.stringify(task.experimentResults) : null,
      task.requiresManualApproval ? 1 : 0,
      task.repoUrl ?? null, task.featureBranch ?? null,
      task.isMergeNode ? 1 : 0,
      task.familiarType ?? null,
      task.claudeSessionId ?? null,
      task.workspacePath ?? null,
      task.containerId ?? null,
      task.createdAt.toISOString(),
      task.startedAt?.toISOString() ?? null,
      task.completedAt?.toISOString() ?? null,
    );
  }

  updateTask(taskId: string, changes: Partial<TaskState>): void {
    const setClauses: string[] = [];
    const values: any[] = [];

    const fieldMap: Record<string, string> = {
      status: 'status',
      blockedBy: 'blocked_by',
      dependencies: 'dependencies',
      command: 'command',
      prompt: 'prompt',
      exitCode: 'exit_code',
      error: 'error',
      inputPrompt: 'input_prompt',
      summary: 'summary',
      problem: 'problem',
      approach: 'approach',
      testPlan: 'test_plan',
      reproCommand: 'repro_command',
      branch: 'branch',
      commit: 'commit_hash',
      parentTask: 'parent_task',
      selectedExperiment: 'selected_experiment',
      claudeSessionId: 'claude_session_id',
      workspacePath: 'workspace_path',
      familiarType: 'familiar_type',
      containerId: 'container_id',
      startedAt: 'started_at',
      completedAt: 'completed_at',
    };

    for (const [key, value] of Object.entries(changes)) {
      const col = fieldMap[key];
      if (!col) continue;

      setClauses.push(`${col} = ?`);

      if (key === 'dependencies') {
        values.push(JSON.stringify(value));
      } else if (key === 'experimentResults' || key === 'experimentVariants') {
        values.push(JSON.stringify(value));
      } else if (value instanceof Date) {
        values.push(value.toISOString());
      } else {
        values.push(value ?? null);
      }
    }

    // Handle JSON fields separately
    if ('experimentResults' in changes) {
      setClauses.push('experiment_results = ?');
      values.push(changes.experimentResults ? JSON.stringify(changes.experimentResults) : null);
    }
    if ('experimentVariants' in changes) {
      setClauses.push('experiment_variants = ?');
      values.push(changes.experimentVariants ? JSON.stringify(changes.experimentVariants) : null);
    }

    if (setClauses.length === 0) return;

    values.push(taskId);
    this.db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
  }

  loadTasks(workflowId: string): TaskState[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE workflow_id = ?').all(workflowId) as any[];
    return rows.map(this.rowToTask);
  }

  getAllTaskIds(): string[] {
    const rows = this.db.prepare('SELECT id FROM tasks').all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  getAllTaskBranches(): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT branch FROM tasks WHERE branch IS NOT NULL',
    ).all() as Array<{ branch: string }>;
    return rows.map((r) => r.branch);
  }

  loadAllCompletedTasks(): Array<TaskState & { workflowName: string }> {
    const rows = this.db.prepare(`
      SELECT t.*, w.name AS workflow_name
      FROM tasks t
      JOIN workflows w ON w.id = t.workflow_id
      WHERE t.status = 'completed'
      ORDER BY t.completed_at DESC
    `).all() as any[];
    return rows.map((row: any) => ({
      ...this.rowToTask(row),
      workflowName: row.workflow_name,
    }));
  }

  deleteAllTasks(workflowId: string): void {
    this.db.prepare('DELETE FROM tasks WHERE workflow_id = ?').run(workflowId);
  }

  deleteAllWorkflows(): void {
    this.db.exec('DELETE FROM events');
    this.db.exec('DELETE FROM tasks');
    this.db.exec('DELETE FROM workflows');
  }

  // ── Events ────────────────────────────────────────────

  logEvent(taskId: string, eventType: string, payload?: unknown): void {
    this.db.prepare(`
      INSERT INTO events (task_id, event_type, payload)
      VALUES (?, ?, ?)
    `).run(taskId, eventType, payload ? JSON.stringify(payload) : null);
  }

  getEvents(taskId: string): TaskEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM events WHERE task_id = ? ORDER BY id ASC',
    ).all(taskId) as any[];
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      eventType: row.event_type,
      payload: row.payload ?? undefined,
      createdAt: row.created_at,
    }));
  }

  // ── Queries ─────────────────────────────────────────

  getSelectedExperiment(taskId: string): string | null {
    const row = this.db.prepare(
      'SELECT selected_experiment FROM tasks WHERE id = ?',
    ).get(taskId) as { selected_experiment: string | null } | undefined;
    return row?.selected_experiment ?? null;
  }

  getWorkspacePath(taskId: string): string | null {
    const row = this.db.prepare(
      'SELECT workspace_path FROM tasks WHERE id = ?',
    ).get(taskId) as { workspace_path: string | null } | undefined;
    return row?.workspace_path ?? null;
  }

  getClaudeSessionId(taskId: string): string | null {
    const row = this.db.prepare(
      'SELECT claude_session_id FROM tasks WHERE id = ?',
    ).get(taskId) as { claude_session_id: string | null } | undefined;
    const val = row?.claude_session_id ?? null;
    return val === 'none' ? null : val;
  }

  getFamiliarType(taskId: string): string | null {
    const row = this.db.prepare(
      'SELECT familiar_type FROM tasks WHERE id = ?',
    ).get(taskId) as { familiar_type: string | null } | undefined;
    return row?.familiar_type ?? null;
  }

  getTaskStatus(taskId: string): string | null {
    const row = this.db.prepare(
      'SELECT status FROM tasks WHERE id = ?',
    ).get(taskId) as { status: string | null } | undefined;
    return row?.status ?? null;
  }

  getContainerId(taskId: string): string | null {
    const row = this.db.prepare(
      'SELECT container_id FROM tasks WHERE id = ?',
    ).get(taskId) as { container_id: string | null } | undefined;
    const val = row?.container_id ?? null;
    return val === 'none' ? null : val;
  }

  // ── Conversations ───────────────────────────────────────

  saveConversation(conversation: Conversation): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO conversations (thread_ts, channel_id, user_id, extracted_plan, plan_submitted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversation.threadTs,
      conversation.channelId,
      conversation.userId,
      conversation.extractedPlan,
      conversation.planSubmitted ? 1 : 0,
      conversation.createdAt,
      conversation.updatedAt,
    );
  }

  loadConversation(threadTs: string): Conversation | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE thread_ts = ?').get(threadTs) as any;
    if (!row) return undefined;
    return {
      threadTs: row.thread_ts,
      channelId: row.channel_id,
      userId: row.user_id,
      extractedPlan: row.extracted_plan ?? null,
      planSubmitted: row.plan_submitted === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
    this.db.prepare(`UPDATE conversations SET ${setClauses.join(', ')} WHERE thread_ts = ?`).run(...values);
  }

  deleteConversation(threadTs: string): void {
    this.db.prepare('DELETE FROM conversation_messages WHERE thread_ts = ?').run(threadTs);
    this.db.prepare('DELETE FROM conversations WHERE thread_ts = ?').run(threadTs);
  }

  listActiveConversations(): Conversation[] {
    const rows = this.db.prepare(
      'SELECT * FROM conversations WHERE plan_submitted = 0 ORDER BY updated_at DESC',
    ).all() as any[];
    return rows.map((row) => ({
      threadTs: row.thread_ts,
      channelId: row.channel_id,
      userId: row.user_id,
      extractedPlan: row.extracted_plan ?? null,
      planSubmitted: row.plan_submitted === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  deleteConversationsOlderThan(cutoffIso: string): number {
    // Delete messages first (FK constraint)
    this.db.prepare(`
      DELETE FROM conversation_messages WHERE thread_ts IN (
        SELECT thread_ts FROM conversations WHERE updated_at < ?
      )
    `).run(cutoffIso);
    const result = this.db.prepare(
      'DELETE FROM conversations WHERE updated_at < ?',
    ).run(cutoffIso);
    return result.changes;
  }

  // ── Conversation Messages ──────────────────────────────

  appendMessage(threadTs: string, role: 'user' | 'assistant', content: string): void {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM conversation_messages WHERE thread_ts = ?',
    ).get(threadTs) as { max_seq: number };
    const nextSeq = row.max_seq + 1;

    this.db.prepare(`
      INSERT INTO conversation_messages (thread_ts, seq, role, content)
      VALUES (?, ?, ?, ?)
    `).run(threadTs, nextSeq, role, content);
  }

  loadMessages(threadTs: string): ConversationMessage[] {
    const rows = this.db.prepare(
      'SELECT * FROM conversation_messages WHERE thread_ts = ? ORDER BY seq ASC',
    ).all(threadTs) as any[];
    return rows.map((row) => ({
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
    this.db.prepare(
      'INSERT INTO task_output (task_id, data) VALUES (?, ?)',
    ).run(taskId, data);
  }

  getTaskOutput(taskId: string): string {
    const rows = this.db.prepare(
      'SELECT data FROM task_output WHERE task_id = ? ORDER BY id ASC',
    ).all(taskId) as Array<{ data: string }>;
    return rows.map((r) => r.data).join('');
  }

  // ── Activity Log ─────────────────────────────────────

  writeActivityLog(source: string, level: string, message: string): void {
    this.db.prepare(
      'INSERT INTO activity_log (source, level, message) VALUES (?, ?, ?)',
    ).run(source, level, message);
  }

  getActivityLogs(sinceId = 0, limit = 200): ActivityLogEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM activity_log WHERE id > ? ORDER BY id ASC LIMIT ?',
    ).all(sinceId, limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      source: row.source,
      level: row.level,
      message: row.message,
    }));
  }

  // ── Lifecycle ─────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  // ── Helpers ───────────────────────────────────────────

  private rowToWorkflow(row: any): Workflow {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      planFile: row.plan_file ?? undefined,
      repoUrl: row.repo_url ?? undefined,
      branch: row.branch ?? undefined,
      onFinish: row.on_finish ?? undefined,
      baseBranch: row.base_branch ?? undefined,
      featureBranch: row.feature_branch ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToTask(row: any): TaskState {
    return {
      id: row.id,
      workflowId: row.workflow_id ?? undefined,
      description: row.description,
      status: row.status,
      blockedBy: row.blocked_by ?? undefined,
      dependencies: JSON.parse(row.dependencies || '[]'),
      command: row.command ?? undefined,
      prompt: row.prompt ?? undefined,
      exitCode: row.exit_code ?? undefined,
      error: row.error ?? undefined,
      inputPrompt: row.input_prompt ?? undefined,
      summary: row.summary ?? undefined,
      problem: row.problem ?? undefined,
      approach: row.approach ?? undefined,
      testPlan: row.test_plan ?? undefined,
      reproCommand: row.repro_command ?? undefined,
      branch: row.branch ?? undefined,
      commit: row.commit_hash ?? undefined,
      parentTask: row.parent_task ?? undefined,
      pivot: row.pivot === 1 ? true : undefined,
      experimentVariants: row.experiment_variants ? JSON.parse(row.experiment_variants) : undefined,
      isReconciliation: row.is_reconciliation === 1 ? true : undefined,
      selectedExperiment: row.selected_experiment ?? undefined,
      experimentResults: row.experiment_results ? JSON.parse(row.experiment_results) : undefined,
      requiresManualApproval: row.requires_manual_approval === 1 ? true : undefined,
      repoUrl: row.repo_url ?? undefined,
      featureBranch: row.feature_branch ?? undefined,
      isMergeNode: row.is_merge_node === 1 ? true : undefined,
      familiarType: row.familiar_type ?? undefined,
      claudeSessionId: row.claude_session_id ?? undefined,
      workspacePath: row.workspace_path ?? undefined,
      containerId: row.container_id ?? undefined,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    };
  }
}
