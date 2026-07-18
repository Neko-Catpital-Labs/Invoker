/**
 * SqliteWorkflowRepository — workflow CRUD, snapshot/rollup reads, review-gate
 * lookup, and the workflow/task search, extracted from SQLiteAdapter as a class
 * over a {@link SqliteExecutor} context.
 *
 * Workflow reads JOIN the tasks table at the SQL level only; the one cross-repo
 * dependency — reconciling a task against its selected attempt when building the
 * workflow/task snapshot — is injected as a callback from the task-attempt
 * repository rather than reached through another repository. Row mapping keeps
 * coming from sqlite-row-mappers.ts; the module owns the
 * lastWorkflowTaskSnapshotStats cache; the adapter retains one-line delegates
 * for every method here.
 */
import type {
  TaskState,
  TaskStatus,
  WorkflowDerivedStatus,
  WorkflowRollup,
  WorkflowRollupTaskSummary,
} from '@invoker/workflow-core';
import {
  assertWorkflowConsistent,
  assertWorkflowPatchConsistent,
  computeWorkflowRollupFromSummaries,
} from '@invoker/workflow-core';
import type { SearchResultItem, SearchOptions } from '@invoker/contracts';
import type {
  ReviewGateLookup,
  Workflow,
  WorkflowSaveInput,
  WorkflowTaskSnapshot,
} from './adapter.js';
import { mapRowToWorkflow, mapRowToTask } from './sqlite-row-mappers.js';
import type { SqliteExecutor } from './sqlite-executor.js';

export type WorkflowMetadataChanges = Partial<
  Pick<
    Workflow,
    | 'name'
    | 'description'
    | 'visualProof'
    | 'planFile'
    | 'repoUrl'
    | 'intermediateRepoUrl'
    | 'branch'
    | 'onFinish'
    | 'baseBranch'
    | 'featureBranch'
    | 'mergeMode'
    | 'reviewProvider'
    | 'externalDependencies'
    | 'externalDependencyChanges'
    | 'detachedExternalDependencies'
    | 'generation'
    | 'updatedAt'
  >
>;

/** Row shape for the columns loaded by the workflow rollup query. */
interface WorkflowRollupTaskRow {
  id: string;
  workflow_id: string;
  description: string;
  status: TaskStatus;
  dependencies: string | null;
  error: string | null;
  protocol_error_code: string | null;
  protocol_error_message: string | null;
  pending_fix_error: string | null;
  exit_code: number | null;
  completed_at: string | null;
  agent_session_id: string | null;
  agent_name: string | null;
  review_url: string | null;
  input_prompt: string | null;
  is_fixing_with_ai: number | null;
}

export class SqliteWorkflowRepository {
  private lastWorkflowTaskSnapshotStats: Record<string, unknown> | null = null;

  constructor(
    private readonly exec: SqliteExecutor,
    private readonly reconcileTaskFromSelectedAttempt: (task: TaskState) => TaskState,
  ) {}

  // ── Workflows ─────────────────────────────────────────

  saveWorkflow(workflow: WorkflowSaveInput): void {
    assertWorkflowConsistent(workflow);
    this.exec.execRun(`
      INSERT OR REPLACE INTO workflows (id, name, description, visual_proof, plan_file, repo_url, intermediate_repo_url, branch, on_finish, base_branch, parent_remote, feature_branch, merge_mode, review_provider, external_dependencies, external_dependency_changes, detached_external_dependencies, generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      workflow.id, workflow.name,
      workflow.description ?? null,
      workflow.visualProof ? 1 : 0,
      workflow.planFile ?? null, workflow.repoUrl ?? null, workflow.intermediateRepoUrl ?? null, workflow.branch ?? null,
      workflow.onFinish ?? null, workflow.baseBranch ?? null, null, workflow.featureBranch ?? null,
      workflow.mergeMode ?? null,
      workflow.reviewProvider ?? null,
      workflow.externalDependencies ? JSON.stringify(workflow.externalDependencies) : null,
      workflow.externalDependencyChanges ? JSON.stringify(workflow.externalDependencyChanges) : null,
      workflow.detachedExternalDependencies ? JSON.stringify(workflow.detachedExternalDependencies) : null,
      workflow.generation ?? 0,
      workflow.createdAt, workflow.updatedAt,
    ]);
  }

  updateWorkflow(workflowId: string, changes: WorkflowMetadataChanges): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    const columnMap: Record<string, string> = {
      name: 'name',
      description: 'description',
      planFile: 'plan_file',
      repoUrl: 'repo_url',
      intermediateRepoUrl: 'intermediate_repo_url',
      branch: 'branch',
      onFinish: 'on_finish',
      baseBranch: 'base_branch',
      featureBranch: 'feature_branch',
      mergeMode: 'merge_mode',
      reviewProvider: 'review_provider',
    };
    for (const [key, column] of Object.entries(columnMap)) {
      if (key in changes) {
        setClauses.push(`${column} = ?`);
        values.push(changes[key as keyof WorkflowMetadataChanges] ?? null);
      }
    }
    if (changes.visualProof !== undefined) {
      setClauses.push('visual_proof = ?');
      values.push(changes.visualProof ? 1 : 0);
    }
    if (changes.baseBranch !== undefined) {
      // handled by columnMap; kept for backward-compatible patch shapes
    }
    if (changes.generation !== undefined) {
      setClauses.push('generation = ?');
      values.push(changes.generation);
    }
    if (changes.mergeMode !== undefined) {
      // handled by columnMap; kept for backward-compatible patch shapes
    }
    // Presence semantics (matching updateTask's config.externalDependencies):
    // key present with undefined ⇒ clear the column; key absent ⇒ unchanged.
    // detachWorkflowInternal clears a dependent's last dependency by passing
    // `externalDependencies: undefined` — a skip-if-undefined check here left
    // dangling dependencies behind after upstream workflow deletion.
    if ('externalDependencies' in changes) {
      setClauses.push('external_dependencies = ?');
      values.push(changes.externalDependencies ? JSON.stringify(changes.externalDependencies) : null);
    }
    if ('externalDependencyChanges' in changes) {
      setClauses.push('external_dependency_changes = ?');
      values.push(changes.externalDependencyChanges ? JSON.stringify(changes.externalDependencyChanges) : null);
    }
    if ('detachedExternalDependencies' in changes) {
      setClauses.push('detached_external_dependencies = ?');
      values.push(changes.detachedExternalDependencies ? JSON.stringify(changes.detachedExternalDependencies) : null);
    }
    const updatedAt = changes.updatedAt ?? new Date().toISOString();
    setClauses.push('updated_at = ?');
    values.push(updatedAt);
    if (setClauses.length === 0) return;

    const before = this.loadWorkflow(workflowId);
    if (!before) return;
    const after = this.buildWorkflowAfterChanges(before, changes, updatedAt);
    assertWorkflowPatchConsistent(before, after, changes);

    values.push(workflowId);
    this.exec.execRun(`UPDATE workflows SET ${setClauses.join(', ')} WHERE id = ?`, values);
  }

  loadWorkflow(workflowId: string): Workflow | undefined {
    const row = this.exec.queryOne('SELECT * FROM workflows WHERE id = ?', [workflowId]);
    if (!row) return undefined;
    const rollup = this.loadWorkflowRollups([workflowId]).get(workflowId);
    return this.rowToWorkflow(row, rollup);
  }

  listWorkflows(): Workflow[] {
    const rows = this.exec.queryAll(
      'SELECT * FROM workflows ORDER BY created_at DESC',
    );
    const workflowIds = rows.map((row) => String(row.id));
    const rollups = this.loadWorkflowRollups(workflowIds);
    return rows.map((row) => this.rowToWorkflow(row, rollups.get(String(row.id))));
  }

  findReviewGateByPr(pr: string): ReviewGateLookup | undefined {
    // The PR↔workflow link lives only on the merge node, as either the bare PR
    // number (review_id) or the full PR URL (review_url ending in /pull/<pr>).
    const rows = this.exec.queryAll(
      `SELECT t.id AS mergeTaskId,
              t.workflow_id AS workflowId,
              t.review_id AS reviewId,
              t.review_url AS reviewUrl,
              t.branch AS branch,
              t.selected_attempt_id AS selectedAttemptId,
              t.status AS mergeTaskStatus,
              w.generation AS workflowGeneration,
              w.base_branch AS baseBranch
         FROM tasks t
         JOIN workflows w ON w.id = t.workflow_id
        WHERE t.is_merge_node = 1 AND (t.review_id = ? OR t.review_url LIKE ?)`,
      [pr, `%/pull/${pr}`],
    );
    if (rows.length === 0) return undefined;

    // workflows has no status column — status is a derived rollup. Compute it
    // per candidate so re-published PRs (multiple merge nodes) can prefer the
    // live workflow, then the highest generation.
    const workflowIds = [...new Set(rows.map((row) => String(row.workflowId)))];
    const rollups = this.loadWorkflowRollups(workflowIds);
    const TERMINAL = new Set<WorkflowDerivedStatus>(['completed', 'failed', 'closed']);

    const candidates = rows.map((row) => {
      const workflowStatus = rollups.get(String(row.workflowId))?.status ?? 'pending';
      return { row, workflowStatus, terminal: TERMINAL.has(workflowStatus) };
    });
    candidates.sort((a, b) => {
      if (a.terminal !== b.terminal) return a.terminal ? 1 : -1; // non-terminal first
      return Number(b.row.workflowGeneration ?? 0) - Number(a.row.workflowGeneration ?? 0);
    });

    const { row, workflowStatus } = candidates[0];
    const str = (value: unknown): string | undefined =>
      value == null ? undefined : String(value);
    return {
      workflowId: String(row.workflowId),
      mergeTaskId: String(row.mergeTaskId),
      reviewId: str(row.reviewId),
      reviewUrl: str(row.reviewUrl),
      branch: str(row.branch),
      baseBranch: str(row.baseBranch),
      workflowStatus,
      workflowGeneration: Number(row.workflowGeneration ?? 0),
      mergeTaskStatus: str(row.mergeTaskStatus),
      selectedAttemptId: str(row.selectedAttemptId),
    };
  }

  searchWorkflowsAndTasks(query: string, opts?: SearchOptions): SearchResultItem[] {
    if (!query.trim()) {
      return [];
    }
    const safeQuery = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    const type = opts?.type ?? 'all';
    const limit = Math.min(opts?.limit ?? 20, 50);
    const offset = opts?.offset ?? 0;
    
    const results: SearchResultItem[] = [];
    
    if (type === 'workflows' || type === 'all') {
      const workflows = this.exec.queryAll(
        `SELECT id, name, description, plan_file, repo_url, branch, created_at FROM workflows 
         WHERE name LIKE ? OR description LIKE ? OR plan_file LIKE ? OR repo_url LIKE ? OR branch LIKE ? 
         LIMIT ? OFFSET ?`,
        [safeQuery, safeQuery, safeQuery, safeQuery, safeQuery, limit, offset]
      ) as Array<{ id: string; name?: string | null; created_at: string }>;
      // Batch load rollups for status
      const workflowIds = workflows.map((row) => row.id);
      const rollups = workflowIds.length > 0 ? this.loadWorkflowRollups(workflowIds) : new Map();
      for (const row of workflows) {
        const rollup = rollups.get(row.id);
        const status = rollup?.status ?? 'pending';
        results.push({
          kind: 'workflow',
          id: row.id,
          workflowId: undefined,
          title: row.name || 'Unnamed workflow',
          subtitle: `Workflow · ${status}`,
          status,
          createdAt: row.created_at,
        });
      }
    }
    
    if (type === 'tasks' || type === 'all') {
      const tasks = this.exec.queryAll(
        `SELECT id, workflow_id, description, command, prompt, summary, problem, approach, test_plan, repro_command, status, created_at FROM tasks 
         WHERE description LIKE ? OR command LIKE ? OR prompt LIKE ? OR summary LIKE ? OR problem LIKE ? OR approach LIKE ? OR test_plan LIKE ? OR repro_command LIKE ? 
         LIMIT ? OFFSET ?`,
        [safeQuery, safeQuery, safeQuery, safeQuery, safeQuery, safeQuery, safeQuery, safeQuery, limit, offset]
      ) as Array<{
        id: string;
        workflow_id?: string | null;
        description?: string | null;
        status?: string | null;
        created_at: string;
      }>;
      // Map workflow IDs to names for subtitle
      const workflowIds = [...new Set(tasks.map((task) => task.workflow_id).filter((id): id is string => typeof id === 'string' && id.length > 0))];
      const workflowNameMap = new Map<string, string>();
      if (workflowIds.length > 0) {
        const placeholders = workflowIds.map(() => '?').join(',');
        const workflowRows = this.exec.queryAll(
          `SELECT id, name FROM workflows WHERE id IN (${placeholders})`,
          workflowIds
        ) as Array<{ id: string; name?: string | null }>;
        for (const wf of workflowRows) {
          workflowNameMap.set(wf.id, wf.name || 'Unnamed workflow');
        }
      }
      for (const row of tasks) {
        const workflowName = row.workflow_id ? workflowNameMap.get(row.workflow_id) : undefined;
        results.push({
          kind: 'task',
          id: row.id,
          workflowId: row.workflow_id || undefined,
          title: row.description || 'Unnamed task',
          subtitle: workflowName ? `Task · ${workflowName}` : '',
          status: row.status || '',
          createdAt: row.created_at,
        });
      }
    }
    
    // Return workflows first, then tasks (preserving order within each category)
    return results;
  }

  loadWorkflowTaskSnapshot(): WorkflowTaskSnapshot {
    const totalStartedAt = Date.now();
    const workflowQueryStartedAt = Date.now();
    const workflowRows = this.exec.queryAll('SELECT * FROM workflows ORDER BY created_at DESC');
    const workflowMetadataQueryMs = Date.now() - workflowQueryStartedAt;
    const taskQueryStartedAt = Date.now();
    const taskRows = this.exec.queryAll('SELECT * FROM tasks ORDER BY workflow_id ASC, id ASC');
    const taskQueryMs = Date.now() - taskQueryStartedAt;
    const tasksByWorkflowId = new Map<string, TaskState[]>();
    const workflowIds = workflowRows.map((row) => String(row.id));
    const rollupStartedAt = Date.now();
    const rollups = this.computeWorkflowRollupsFromRows(workflowIds, taskRows);
    const rollupComputationMs = Date.now() - rollupStartedAt;
    const tasks: TaskState[] = [];

    const deserializeStartedAt = Date.now();
    for (const row of taskRows) {
      const task = this.reconcileTaskFromSelectedAttempt(mapRowToTask(row));
      tasks.push(task);
      const workflowId = task.config.workflowId ?? '';
      if (!workflowId) continue;
      const workflowTasks = tasksByWorkflowId.get(workflowId) ?? [];
      workflowTasks.push(task);
      tasksByWorkflowId.set(workflowId, workflowTasks);
    }
    const taskDeserializeReconcileMs = Date.now() - deserializeStartedAt;

    const snapshot = {
      workflows: workflowRows.map((row) => this.rowToWorkflow(row, rollups.get(String(row.id)))),
      tasks,
      tasksByWorkflowId,
    };
    this.lastWorkflowTaskSnapshotStats = {
      workflowMetadataQueryMs,
      taskQueryMs,
      rollupComputationMs,
      taskDeserializeReconcileMs,
      totalMs: Date.now() - totalStartedAt,
      workflowCount: snapshot.workflows.length,
      taskCount: tasks.length,
    };
    return snapshot;
  }

  getLastWorkflowTaskSnapshotStats(): Record<string, unknown> | null {
    return this.lastWorkflowTaskSnapshotStats ? { ...this.lastWorkflowTaskSnapshotStats } : null;
  }

  private buildWorkflowAfterChanges(
    before: Workflow,
    changes: WorkflowMetadataChanges,
    updatedAt: string,
  ): Workflow {
    const after: Workflow = { ...before, updatedAt };
    const applyPatchKeyToValidationCopy = <K extends keyof WorkflowMetadataChanges>(key: K): void => {
      if (Object.prototype.hasOwnProperty.call(changes, key)) {
        (after as WorkflowMetadataChanges)[key] = changes[key];
      }
    };

    // Mirror updateWorkflow patch semantics before writing: missing key means
    // unchanged; present key, even undefined, means apply the clear and validate it.
    applyPatchKeyToValidationCopy('name');
    applyPatchKeyToValidationCopy('description');
    applyPatchKeyToValidationCopy('visualProof');
    applyPatchKeyToValidationCopy('planFile');
    applyPatchKeyToValidationCopy('repoUrl');
    applyPatchKeyToValidationCopy('intermediateRepoUrl');
    applyPatchKeyToValidationCopy('branch');
    applyPatchKeyToValidationCopy('onFinish');
    applyPatchKeyToValidationCopy('baseBranch');
    applyPatchKeyToValidationCopy('featureBranch');
    applyPatchKeyToValidationCopy('mergeMode');
    applyPatchKeyToValidationCopy('reviewProvider');
    applyPatchKeyToValidationCopy('externalDependencies');
    applyPatchKeyToValidationCopy('externalDependencyChanges');
    applyPatchKeyToValidationCopy('detachedExternalDependencies');
    applyPatchKeyToValidationCopy('generation');

    return after;
  }

  private loadWorkflowRollups(workflowIds: string[]): Map<string, WorkflowRollup> {
    const rollups = new Map<string, WorkflowRollup>();
    if (workflowIds.length === 0) return rollups;

    const placeholders = workflowIds.map(() => '?').join(', ');
    const taskRows = this.exec.queryAll(
      `SELECT id, workflow_id, description, status, dependencies, error, protocol_error_code, protocol_error_message,
              pending_fix_error, exit_code, completed_at, agent_session_id, agent_name,
              review_url, input_prompt, is_fixing_with_ai
       FROM tasks
       WHERE workflow_id IN (${placeholders})
       ORDER BY id ASC`,
      workflowIds,
    );

    return this.computeWorkflowRollupsFromRows(workflowIds, taskRows);
  }

  private computeWorkflowRollupsFromRows(
    workflowIds: string[],
    taskRows: Record<string, unknown>[],
  ): Map<string, WorkflowRollup> {
    const rollups = new Map<string, WorkflowRollup>();
    const tasksByWorkflow = new Map<string, WorkflowRollupTaskSummary[]>();
    // DB-row boundary: the SELECT columns map onto WorkflowRollupTaskRow.
    for (const row of taskRows as unknown as WorkflowRollupTaskRow[]) {
      const workflowId = String(row.workflow_id);
      const tasks = tasksByWorkflow.get(workflowId) ?? [];
      tasks.push({
        id: String(row.id),
        description: String(row.description),
        status: row.status as TaskStatus,
        dependencies: JSON.parse(row.dependencies || '[]'),
        execution: {
          error: row.error ?? undefined,
          protocolErrorCode: row.protocol_error_code ?? undefined,
          protocolErrorMessage: row.protocol_error_message ?? undefined,
          pendingFixError: row.pending_fix_error ?? undefined,
          exitCode: row.exit_code ?? undefined,
          completedAt: row.completed_at ?? undefined,
          agentSessionId: row.agent_session_id ?? undefined,
          agentName: row.agent_name ?? undefined,
          reviewUrl: row.review_url ?? undefined,
          inputPrompt: row.input_prompt ?? undefined,
          isFixingWithAI: row.is_fixing_with_ai === 1,
        },
      });
      tasksByWorkflow.set(workflowId, tasks);
    }

    for (const workflowId of workflowIds) {
      const tasks = tasksByWorkflow.get(workflowId) ?? [];
      rollups.set(workflowId, computeWorkflowRollupFromSummaries(tasks));
    }

    return rollups;
  }

  private rowToWorkflow(row: Record<string, unknown>, rollup?: WorkflowRollup): Workflow {
    return mapRowToWorkflow(row, rollup);
  }
}
