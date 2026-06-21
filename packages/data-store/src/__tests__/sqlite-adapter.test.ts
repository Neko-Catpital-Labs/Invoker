import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow, Conversation } from '../adapter.js';
import { createAttempt } from '@invoker/workflow-core';
import type { Attempt, TaskState, TaskStateChanges } from '@invoker/workflow-core';

describe('SQLiteAdapter', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  const testWorkflow: Workflow = {
    id: 'wf-1',
    name: 'Test Workflow',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  function makeTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status: 'pending',
      dependencies: [],
      createdAt: new Date(),
      config: {},
      execution: {},
      taskStateVersion: 1,
      ...overrides,
    };
  }

  function workflowColumns(db: SQLiteAdapter): string[] {
    const result = (db as any).db.exec('PRAGMA table_info(workflows)') as Array<{ values: unknown[][] }>;
    return (result[0]?.values ?? []).map((row) => String(row[1]));
  }

  function sqliteScalar(db: SQLiteAdapter, sql: string): number {
    const result = (db as any).db.exec(sql) as Array<{ values: unknown[][] }>;
    return Number(result[0]?.values?.[0]?.[0] ?? 0);
  }

  describe('workflow schema', () => {
    it('does not persist a workflow status column on fresh databases', () => {
      expect(workflowColumns(adapter)).not.toContain('status');
    });

    it('migrates existing workflow tables by removing status and preserving metadata', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-workflow-status-migration-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        const oldDb = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        (oldDb as any).db.run(`ALTER TABLE workflows ADD COLUMN status TEXT DEFAULT 'running'`);
        (oldDb as any).db.run(
          `INSERT INTO workflows (
            id, name, description, visual_proof, status, plan_file, repo_url,
            intermediate_repo_url, branch, on_finish, base_branch, parent_remote,
            feature_branch, merge_mode, review_provider, generation, created_at, updated_at
          ) VALUES (
            'wf-old', 'Old Workflow', 'kept', 1, 'failed', 'plan.yml', 'repo',
            'intermediate', 'branch-a', 'none', 'main', 'origin',
            'feature/a', 'manual', 'github', 7, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
          )`,
        );
        (oldDb as any).dirty = true;
        oldDb.close();

        const migrated = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        expect(workflowColumns(migrated)).not.toContain('status');
        const workflow = migrated.loadWorkflow('wf-old')!;
        expect(workflow).toMatchObject({
          id: 'wf-old',
          name: 'Old Workflow',
          description: 'kept',
          visualProof: true,
          status: 'pending',
          planFile: 'plan.yml',
          repoUrl: 'repo',
          intermediateRepoUrl: 'intermediate',
          branch: 'branch-a',
          baseBranch: 'main',
          featureBranch: 'feature/a',
          mergeMode: 'manual',
          reviewProvider: 'github',
          generation: 7,
        });
        migrated.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('saveTask + loadTasks', () => {
    it('round-trips a task through save and load', () => {
      adapter.saveWorkflow(testWorkflow);
      const task = makeTask('t1', { dependencies: ['dep1'], config: { command: 'echo hello' } });
      adapter.saveTask('wf-1', task);

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('t1');
      expect(loaded[0].config.command).toBe('echo hello');
      expect(loaded[0].dependencies).toEqual(['dep1']);
      expect(loaded[0].status).toBe('pending');
    });

    it('persists poolMemberId through updateTask and getPoolMemberId', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('ssh-task', {
        config: { runnerKind: 'ssh' },
      }));

      adapter.updateTask('ssh-task', {
        config: { poolMemberId: 'remote-1' },
      });

      expect(adapter.getPoolMemberId('ssh-task')).toBe('remote-1');
      expect(adapter.loadTask('ssh-task')?.config).toMatchObject({
        runnerKind: 'ssh',
        poolMemberId: 'remote-1',
      });
    });

    it('loads all workflows and tasks in one startup snapshot', () => {
      const wf2: Workflow = {
        ...testWorkflow,
        id: 'wf-2',
        name: 'Second Workflow',
      };
      adapter.saveWorkflow(testWorkflow);
      adapter.saveWorkflow(wf2);
      adapter.saveTask('wf-1', makeTask('wf-1/task-1', { status: 'completed', config: { workflowId: 'wf-1' } }));
      adapter.saveTask('wf-2', makeTask('wf-2/task-1', { status: 'failed', config: { workflowId: 'wf-2' } }));

      const snapshot = adapter.loadWorkflowTaskSnapshot();

      expect(snapshot.workflows.map((workflow) => workflow.id).sort()).toEqual(['wf-1', 'wf-2']);
      expect(snapshot.tasks.map((task) => task.id).sort()).toEqual(['wf-1/task-1', 'wf-2/task-1']);
      expect(snapshot.tasksByWorkflowId.get('wf-1')?.map((task) => task.id)).toEqual(['wf-1/task-1']);
      expect(snapshot.tasksByWorkflowId.get('wf-2')?.map((task) => task.id)).toEqual(['wf-2/task-1']);
    });

    it('computes snapshot workflow rollups from the snapshot task rows', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('wf-1/task-1', { status: 'completed', config: { workflowId: 'wf-1' } }));
      adapter.saveTask('wf-1', makeTask('wf-1/task-2', { status: 'failed', config: { workflowId: 'wf-1' } }));

      const [snapshotWorkflow] = adapter.loadWorkflowTaskSnapshot().workflows;
      const [listedWorkflow] = adapter.listWorkflows();

      expect(snapshotWorkflow.rollup).toEqual(listedWorkflow.rollup);
      expect(snapshotWorkflow.status).toBe(listedWorkflow.status);
      expect(snapshotWorkflow.rollup?.countsByStatus.failed).toBe(1);
      expect(snapshotWorkflow.rollup?.countsByStatus.completed).toBe(1);
    });

    it('creates an index for workflow task lookups', () => {
      const result = (adapter as any).db.exec('PRAGMA index_list(tasks)') as Array<{ values: unknown[][] }>;
      const indexNames = (result[0]?.values ?? []).map((row) => String(row[1]));
      expect(indexNames).toContain('idx_tasks_workflow_id');
    });

    it('creates an index for task event lookups', () => {
      const result = (adapter as any).db.exec('PRAGMA index_list(events)') as Array<{ values: unknown[][] }>;
      const indexNames = (result[0]?.values ?? []).map((row) => String(row[1]));
      expect(indexNames).toContain('idx_events_task_id_id');
    });
  });

  describe('execution resource leases', () => {
    it('allows only one live holder per resource key', () => {
      const acquired = adapter.claimExecutionResourceLease({
        resourceKey: 'ssh:invoker@example.com:22',
        resourceType: 'ssh',
        holderId: 'holder-1',
        taskId: 'task-1',
        poolId: 'ssh-pool',
        poolMemberId: 'remote-a',
      });
      const blocked = adapter.claimExecutionResourceLease({
        resourceKey: 'ssh:invoker@example.com:22',
        resourceType: 'ssh',
        holderId: 'holder-2',
        taskId: 'task-2',
        poolId: 'ssh-pool',
        poolMemberId: 'remote-a',
      });

      expect(acquired).toBe(true);
      expect(blocked).toBe(false);
      expect(adapter.listExecutionResourceLeases()).toHaveLength(1);
    });

    it('reclaims expired resource leases', () => {
      expect(adapter.claimExecutionResourceLease({
        resourceKey: 'ssh:invoker@example.com:22',
        resourceType: 'ssh',
        holderId: 'holder-1',
        leaseMs: -1,
      })).toBe(true);

      expect(adapter.claimExecutionResourceLease({
        resourceKey: 'ssh:invoker@example.com:22',
        resourceType: 'ssh',
        holderId: 'holder-2',
      })).toBe(true);

      const leases = adapter.listExecutionResourceLeases();
      expect(leases).toHaveLength(1);
      expect(leases[0].holderId).toBe('holder-2');
    });

    it('renews and releases resource leases by holder', () => {
      adapter.claimExecutionResourceLease({
        resourceKey: 'ssh:invoker@example.com:22',
        resourceType: 'ssh',
        holderId: 'holder-1',
      });

      expect(adapter.renewExecutionResourceLease('ssh:invoker@example.com:22', 'holder-1')).toBe(true);
      adapter.releaseExecutionResourceLease('ssh:invoker@example.com:22', 'holder-1');

      expect(adapter.listExecutionResourceLeases()).toHaveLength(0);
    });
  });

  describe('task_launch_dispatch outbox', () => {
    function setupWorkflowAndTask(
      workflowId = 'wf-launch',
      taskId = 'wf-launch/t1',
      opts: {
        selectedAttemptId?: string;
        generation?: number;
        status?: TaskState['status'];
      } = {},
    ): void {
      adapter.saveWorkflow({ ...testWorkflow, id: workflowId });
      adapter.saveTask(workflowId, makeTask(taskId, {
        status: opts.status ?? 'pending',
        config: { workflowId },
        execution: {
          generation: opts.generation ?? 0,
        },
      }));
      if (opts.selectedAttemptId) {
        adapter.updateTask(taskId, {
          execution: { selectedAttemptId: opts.selectedAttemptId },
        });
      }
    }

    function saveLaunchTask(
      workflowId: string,
      taskId: string,
      attemptId: string,
      opts: { generation?: number; status?: TaskState['status'] } = {},
    ): void {
      adapter.saveTask(workflowId, makeTask(taskId, {
        status: opts.status ?? 'pending',
        config: { workflowId },
        execution: {
          generation: opts.generation ?? 0,
        },
      }));
      adapter.updateTask(taskId, {
        execution: { selectedAttemptId: attemptId },
      });
    }

    it('round-trips enqueueLaunchDispatch + load by id and attempt', () => {
      setupWorkflowAndTask();
      const inserted = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-1',
        workflowId: 'wf-launch',
        generation: 0,
      });

      expect(inserted.id).toBeGreaterThan(0);
      expect(inserted.state).toBe('enqueued');
      expect(inserted.priority).toBe('normal');
      expect(inserted.attemptsCount).toBe(0);

      const byId = adapter.loadLaunchDispatchById(inserted.id);
      expect(byId).toMatchObject({
        id: inserted.id,
        attemptId: 'attempt-1',
        taskId: 'wf-launch/t1',
        workflowId: 'wf-launch',
        state: 'enqueued',
      });

      const byAttempt = adapter.loadLaunchDispatchByAttempt('attempt-1');
      expect(byAttempt?.id).toBe(inserted.id);

      const events = adapter.getEvents('wf-launch/t1');
      const enqueuedEvent = events.find((event) => event.eventType === 'task.launch_dispatch_enqueued');
      expect(enqueuedEvent).toBeDefined();
      expect(JSON.parse(enqueuedEvent!.payload!)).toMatchObject({
        dispatchId: inserted.id,
        attemptId: 'attempt-1',
        workflowId: 'wf-launch',
        generation: 0,
        priority: 'normal',
      });
    });

    it('returns existing row instead of creating a duplicate active dispatch for the same attempt', () => {
      setupWorkflowAndTask();
      const first = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-dup',
        workflowId: 'wf-launch',
        priority: 'high',
        generation: 0,
      });
      const second = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-dup',
        workflowId: 'wf-launch',
        priority: 'low',
        generation: 0,
      });

      expect(second.id).toBe(first.id);
      expect(second.priority).toBe('high');
      expect(
        adapter.listLaunchDispatchesByState(['enqueued', 'leased']),
      ).toHaveLength(1);
    });

    it('filters listLaunchDispatchesByState by the requested states', () => {
      setupWorkflowAndTask();
      const a = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-a',
        workflowId: 'wf-launch',
        generation: 0,
      });
      const b = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-b',
        workflowId: 'wf-launch',
        generation: 0,
      });
      adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-c',
        workflowId: 'wf-launch',
        generation: 0,
      });
      adapter.markLaunchDispatchCompleted(a.id);
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch SET state = 'leased', fenced_until = datetime('now', '+30 seconds') WHERE id = ?`,
        [b.id],
      );

      const enqueuedOnly = adapter
        .listLaunchDispatchesByState(['enqueued'])
        .map((row) => row.attemptId);
      expect(enqueuedOnly).toEqual(['attempt-c']);
      const leasedOnly = adapter
        .listLaunchDispatchesByState(['leased'])
        .map((row) => row.attemptId);
      expect(leasedOnly).toEqual(['attempt-b']);
      const completedOnly = adapter
        .listLaunchDispatchesByState(['completed'])
        .map((row) => row.attemptId);
      expect(completedOnly).toEqual(['attempt-a']);
    });

    it('runCompatibilityMigration normalizes legacy acknowledged rows', () => {
      adapter.saveWorkflow({ ...testWorkflow, id: 'wf-launch' });
      saveLaunchTask('wf-launch', 'wf-launch/t-future', 'attempt-future');
      saveLaunchTask('wf-launch', 'wf-launch/t-expired', 'attempt-expired');
      saveLaunchTask('wf-launch', 'wf-launch/t-stale', 'attempt-current');
      const future = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t-future',
        attemptId: 'attempt-future',
        workflowId: 'wf-launch',
        generation: 0,
      });
      const expired = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t-expired',
        attemptId: 'attempt-expired',
        workflowId: 'wf-launch',
        generation: 0,
      });
      const stale = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t-stale',
        attemptId: 'attempt-stale',
        workflowId: 'wf-launch',
        generation: 0,
      });
      const now = Date.now();
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch SET state = 'acknowledged', dispatch_owner = 'owner-future',
            leased_at = ?, acknowledged_at = ?, fenced_until = ?
         WHERE id = ?`,
        [
          new Date(now - 1_000).toISOString(),
          new Date(now - 1_000).toISOString(),
          new Date(now + 60_000).toISOString(),
          future.id,
        ],
      );
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch SET state = 'acknowledged', dispatch_owner = 'owner-expired',
            leased_at = ?, acknowledged_at = ?, fenced_until = ?
         WHERE id = ?`,
        [
          new Date(now - 120_000).toISOString(),
          new Date(now - 120_000).toISOString(),
          new Date(now - 60_000).toISOString(),
          expired.id,
        ],
      );
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch SET state = 'acknowledged', dispatch_owner = 'owner-stale',
            leased_at = ?, acknowledged_at = ?, fenced_until = ?
         WHERE id = ?`,
        [
          new Date(now - 120_000).toISOString(),
          new Date(now - 120_000).toISOString(),
          new Date(now + 60_000).toISOString(),
          stale.id,
        ],
      );

      const report = adapter.runCompatibilityMigration();

      expect(report.normalizedLegacyAcknowledgedLaunchDispatches).toBe(3);
      expect(adapter.loadLaunchDispatchById(future.id)?.state).toBe('leased');
      expect(adapter.loadLaunchDispatchById(expired.id)?.state).toBe('enqueued');
      const staleAfter = adapter.loadLaunchDispatchById(stale.id);
      expect(staleAfter?.state).toBe('abandoned');
      expect(staleAfter?.lastError).toMatch(/Legacy acknowledged launch dispatch is stale/);
      const legacyCount = sqliteScalar(
        adapter,
        `SELECT COUNT(*) AS count FROM task_launch_dispatch WHERE state = 'acknowledged'`,
      );
      expect(legacyCount).toBe(0);
    });

    it('markLaunchDispatchCompleted transitions to completed and rejects already-terminal rows', () => {
      setupWorkflowAndTask();
      const row = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-complete',
        workflowId: 'wf-launch',
        generation: 0,
      });

      expect(adapter.markLaunchDispatchCompleted(row.id)).toBe(true);
      const after = adapter.loadLaunchDispatchById(row.id);
      expect(after?.state).toBe('completed');
      expect(after?.completedAt).toBeDefined();

      expect(adapter.markLaunchDispatchCompleted(row.id)).toBe(false);
    });

    it('markLaunchDispatchFailed re-enqueues the row and clears the owner / fence', () => {
      setupWorkflowAndTask();
      const row = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-failed',
        workflowId: 'wf-launch',
        generation: 0,
      });
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch SET state = 'leased', dispatch_owner = 'runner-x', fenced_until = datetime('now', '+30 seconds') WHERE id = ?`,
        [row.id],
      );

      expect(adapter.markLaunchDispatchFailed(row.id, 'boom')).toBe(true);
      const after = adapter.loadLaunchDispatchById(row.id);
      expect(after?.state).toBe('enqueued');
      expect(after?.lastError).toBe('boom');
      expect(after?.dispatchOwner).toBeUndefined();
      expect(after?.fencedUntil).toBeUndefined();

      adapter.markLaunchDispatchCompleted(row.id);
      expect(adapter.markLaunchDispatchFailed(row.id, 'too late')).toBe(false);
    });

    it('reapExpiredLaunchDispatchLeases resets leased rows whose fence has passed', () => {
      setupWorkflowAndTask();
      const expired = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-expired',
        workflowId: 'wf-launch',
        generation: 0,
      });
      const live = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-live',
        workflowId: 'wf-launch',
        generation: 0,
      });
      const now = new Date();
      const pastIso = new Date(now.getTime() - 60_000).toISOString();
      const futureIso = new Date(now.getTime() + 60_000).toISOString();
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch SET state = 'leased', dispatch_owner = 'runner-x', fenced_until = ? WHERE id = ?`,
        [pastIso, expired.id],
      );
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch SET state = 'leased', dispatch_owner = 'runner-y', fenced_until = ? WHERE id = ?`,
        [futureIso, live.id],
      );

      const reaped = adapter.reapExpiredLaunchDispatchLeases({ nowIso: now.toISOString() });
      expect(reaped.map((row) => row.attemptId)).toEqual(['attempt-expired']);
      const expiredAfter = adapter.loadLaunchDispatchById(expired.id);
      expect(expiredAfter?.state).toBe('enqueued');
      expect(expiredAfter?.dispatchOwner).toBeUndefined();
      const liveAfter = adapter.loadLaunchDispatchById(live.id);
      expect(liveAfter?.state).toBe('leased');
    });

    describe('claimLaunchDispatchAtomic', () => {
      it('leases the only enqueued row when capacity allows', () => {
        setupWorkflowAndTask('wf-launch', 'wf-launch/t1', {
          selectedAttemptId: 'attempt-claim-1',
        });
        const enqueued = adapter.enqueueLaunchDispatch({
          taskId: 'wf-launch/t1',
          attemptId: 'attempt-claim-1',
          workflowId: 'wf-launch',
          generation: 0,
        });

        const claimed = adapter.claimLaunchDispatchAtomic({
          ownerId: 'runner-1',
        });

        expect(claimed?.id).toBe(enqueued.id);
        expect(claimed?.state).toBe('leased');
        expect(claimed?.dispatchOwner).toBe('runner-1');
        expect(claimed?.attemptsCount).toBe(1);
        expect(claimed?.fencedUntil).toBeDefined();
        expect(claimed?.leasedAt).toBeDefined();
        const events = adapter.getEvents('wf-launch/t1');
        const claimedEvent = events.find((event) => event.eventType === 'task.launch_dispatch_claimed');
        expect(claimedEvent).toBeDefined();
        expect(JSON.parse(claimedEvent!.payload!)).toMatchObject({
          dispatchId: enqueued.id,
          ownerId: 'runner-1',
          attemptId: 'attempt-claim-1',
          workflowId: 'wf-launch',
          generation: 0,
          fencedUntil: claimed?.fencedUntil,
        });
      });

      it('returns undefined when no enqueued rows exist', () => {
        setupWorkflowAndTask();
        const claimed = adapter.claimLaunchDispatchAtomic({
          ownerId: 'runner-1',
        });
        expect(claimed).toBeUndefined();
      });

      it('does not double-lease an already-leased row', () => {
        setupWorkflowAndTask('wf-launch', 'wf-launch/t1', {
          selectedAttemptId: 'attempt-conflict',
        });
        adapter.enqueueLaunchDispatch({
          taskId: 'wf-launch/t1',
          attemptId: 'attempt-conflict',
          workflowId: 'wf-launch',
          generation: 0,
        });

        const first = adapter.claimLaunchDispatchAtomic({
          ownerId: 'runner-a',
        });
        const second = adapter.claimLaunchDispatchAtomic({
          ownerId: 'runner-b',
        });

        expect(first?.dispatchOwner).toBe('runner-a');
        expect(second).toBeUndefined();
      });

      it('orders by priority (high, normal, low) then by insertion order', () => {
        adapter.saveWorkflow({ ...testWorkflow, id: 'wf-launch' });
        saveLaunchTask('wf-launch', 'wf-launch/t-normal', 'attempt-normal-1');
        saveLaunchTask('wf-launch', 'wf-launch/t-low', 'attempt-low');
        saveLaunchTask('wf-launch', 'wf-launch/t-high', 'attempt-high');
        const normal1 = adapter.enqueueLaunchDispatch({
          taskId: 'wf-launch/t-normal',
          attemptId: 'attempt-normal-1',
          workflowId: 'wf-launch',
          generation: 0,
        });
        adapter.enqueueLaunchDispatch({
          taskId: 'wf-launch/t-low',
          attemptId: 'attempt-low',
          workflowId: 'wf-launch',
          priority: 'low',
          generation: 0,
        });
        const high = adapter.enqueueLaunchDispatch({
          taskId: 'wf-launch/t-high',
          attemptId: 'attempt-high',
          workflowId: 'wf-launch',
          priority: 'high',
          generation: 0,
        });

        const firstClaim = adapter.claimLaunchDispatchAtomic({
          ownerId: 'runner-pri',
        });
        const secondClaim = adapter.claimLaunchDispatchAtomic({
          ownerId: 'runner-pri',
        });
        const thirdClaim = adapter.claimLaunchDispatchAtomic({
          ownerId: 'runner-pri',
        });

        expect(firstClaim?.id).toBe(high.id);
        expect(secondClaim?.id).toBe(normal1.id);
        expect(thirdClaim?.attemptId).toBe('attempt-low');
      });

      it('leases queued work even when legacy acknowledged rows exist', () => {
        adapter.saveWorkflow({ ...testWorkflow, id: 'wf-launch' });
        for (let i = 0; i < 12; i += 1) {
          const taskId = `wf-launch/t-legacy-${i}`;
          const attemptId = `attempt-legacy-${i}`;
          saveLaunchTask('wf-launch', taskId, attemptId);
          const legacy = adapter.enqueueLaunchDispatch({
            taskId,
            attemptId,
            workflowId: 'wf-launch',
            generation: 0,
          });
          (adapter as any).db.run(
            `UPDATE task_launch_dispatch
               SET state = 'acknowledged', dispatch_owner = 'old-owner',
                   fenced_until = ?, attempts_count = 1
             WHERE id = ?`,
            [new Date(Date.now() - 60_000).toISOString(), legacy.id],
          );
        }
        saveLaunchTask('wf-launch', 'wf-launch/t-target', 'attempt-target');
        const target = adapter.enqueueLaunchDispatch({
          taskId: 'wf-launch/t-target',
          attemptId: 'attempt-target',
          workflowId: 'wf-launch',
          generation: 0,
        });

        const claimed = adapter.claimLaunchDispatchAtomic({
          ownerId: 'runner-c',
        });

        expect(claimed?.id).toBe(target.id);
        expect(claimed?.state).toBe('leased');
      });

      it('abandons a stale selected-attempt candidate and scans to the next valid row', () => {
        adapter.saveWorkflow({ ...testWorkflow, id: 'wf-launch' });
        saveLaunchTask('wf-launch', 'wf-launch/t-stale', 'attempt-current');
        saveLaunchTask('wf-launch', 'wf-launch/t-valid', 'attempt-valid');
        const stale = adapter.enqueueLaunchDispatch({
          taskId: 'wf-launch/t-stale',
          attemptId: 'attempt-stale',
          workflowId: 'wf-launch',
          priority: 'high',
          generation: 0,
        });
        const valid = adapter.enqueueLaunchDispatch({
          taskId: 'wf-launch/t-valid',
          attemptId: 'attempt-valid',
          workflowId: 'wf-launch',
          priority: 'normal',
          generation: 0,
        });

        const claimed = adapter.claimLaunchDispatchAtomic({
          ownerId: 'runner-scan',
          nowIso: '2026-06-03T00:00:00.000Z',
        });

        expect(claimed?.id).toBe(valid.id);
        const staleAfter = adapter.loadLaunchDispatchById(stale.id);
        expect(staleAfter?.state).toBe('abandoned');
        expect(staleAfter?.lastError).toMatch(/not the selected attempt/);
      });

      it('abandons stale generation candidates', () => {
        setupWorkflowAndTask('wf-launch', 'wf-launch/t1', {
          selectedAttemptId: 'attempt-generation',
          generation: 2,
        });
        const row = adapter.enqueueLaunchDispatch({
          taskId: 'wf-launch/t1',
          attemptId: 'attempt-generation',
          workflowId: 'wf-launch',
          generation: 1,
        });

        const claimed = adapter.claimLaunchDispatchAtomic({
          ownerId: 'runner-generation',
          nowIso: '2026-06-03T00:01:00.000Z',
        });

        expect(claimed).toBeUndefined();
        const after = adapter.loadLaunchDispatchById(row.id);
        expect(after?.state).toBe('abandoned');
        expect(after?.lastError).toMatch(/does not match task generation/);
      });

      it('abandons non-pending task candidates', () => {
        setupWorkflowAndTask('wf-launch', 'wf-launch/t1', {
          selectedAttemptId: 'attempt-failed-task',
          status: 'failed',
        });
        const row = adapter.enqueueLaunchDispatch({
          taskId: 'wf-launch/t1',
          attemptId: 'attempt-failed-task',
          workflowId: 'wf-launch',
          generation: 0,
        });

        const claimed = adapter.claimLaunchDispatchAtomic({
          ownerId: 'runner-status',
          nowIso: '2026-06-03T00:02:00.000Z',
        });

        expect(claimed).toBeUndefined();
        const after = adapter.loadLaunchDispatchById(row.id);
        expect(after?.state).toBe('abandoned');
        expect(after?.lastError).toMatch(/status is failed/);
      });

      it('abandons missing-task candidates', () => {
        adapter.saveWorkflow({ ...testWorkflow, id: 'wf-launch' });
        (adapter as any).db.run('PRAGMA foreign_keys = OFF');
        (adapter as any).db.run(
          `INSERT INTO task_launch_dispatch (
            task_id, attempt_id, workflow_id, state, priority, generation
          ) VALUES ('wf-launch/missing', 'attempt-missing-task', 'wf-launch', 'enqueued', 'normal', 0)`,
        );
        (adapter as any).db.run('PRAGMA foreign_keys = ON');
        const row = adapter.loadLaunchDispatchByAttempt('attempt-missing-task')!;

        const claimed = adapter.claimLaunchDispatchAtomic({
          ownerId: 'runner-missing',
          nowIso: '2026-06-03T00:03:00.000Z',
        });

        expect(claimed).toBeUndefined();
        const after = adapter.loadLaunchDispatchById(row.id);
        expect(after?.state).toBe('abandoned');
        expect(after?.lastError).toMatch(/no longer exists/);
      });
    });

    it('abandonLaunchDispatchesForTasks abandons active rows for the selected task set', () => {
      adapter.saveWorkflow({ ...testWorkflow, id: 'wf-launch' });
      saveLaunchTask('wf-launch', 'wf-launch/t1', 'attempt-live-1');
      saveLaunchTask('wf-launch', 'wf-launch/t2', 'attempt-live-2');
      const enqueued = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-live-1',
        workflowId: 'wf-launch',
        generation: 0,
      });
      const leased = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-live-1b',
        workflowId: 'wf-launch',
        generation: 0,
      });
      const completed = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-completed',
        workflowId: 'wf-launch',
        generation: 0,
      });
      const unrelated = adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t2',
        attemptId: 'attempt-live-2',
        workflowId: 'wf-launch',
        generation: 0,
      });
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch SET state = 'leased', dispatch_owner = 'owner-1', fenced_until = '2026-06-03T00:05:00.000Z' WHERE id = ?`,
        [leased.id],
      );
      adapter.markLaunchDispatchCompleted(completed.id, '2026-06-03T00:04:00.000Z');

      const invalidated = adapter.abandonLaunchDispatchesForTasks(
        ['wf-launch/t1'],
        'reset invalidated launch dispatch',
        '2026-06-03T00:06:00.000Z',
      );

      expect(invalidated.map((row) => ({ id: row.id, state: row.state }))).toEqual([
        { id: enqueued.id, state: 'enqueued' },
        { id: leased.id, state: 'leased' },
      ]);
      for (const row of [enqueued, leased]) {
        const after = adapter.loadLaunchDispatchById(row.id);
        expect(after?.state).toBe('abandoned');
        expect(after?.completedAt).toBe('2026-06-03T00:06:00.000Z');
        expect(after?.lastError).toBe('reset invalidated launch dispatch');
        expect(after?.dispatchOwner).toBeUndefined();
        expect(after?.fencedUntil).toBeUndefined();
      }
      expect(adapter.loadLaunchDispatchById(completed.id)?.state).toBe('completed');
      expect(adapter.loadLaunchDispatchById(unrelated.id)?.state).toBe('enqueued');
    });

    it('releaseExecutionResourceLeasesForTasks releases only leases held by the selected task set', () => {
      adapter.saveWorkflow({ ...testWorkflow, id: 'wf-launch' });
      saveLaunchTask('wf-launch', 'wf-launch/t1', 'attempt-lease-1');
      saveLaunchTask('wf-launch', 'wf-launch/t2', 'attempt-lease-2');
      expect(adapter.claimExecutionResourceLease({
        resourceKey: 'ssh:lifecycle-1',
        resourceType: 'ssh',
        holderId: 'holder-lifecycle-1',
        taskId: 'wf-launch/t1',
      })).toBe(true);
      expect(adapter.claimExecutionResourceLease({
        resourceKey: 'ssh:lifecycle-2',
        resourceType: 'ssh',
        holderId: 'holder-lifecycle-2',
        taskId: 'wf-launch/t2',
      })).toBe(true);

      const released = adapter.releaseExecutionResourceLeasesForTasks(
        ['wf-launch/t1'],
        'reset invalidated resource lease',
        '2026-06-03T00:07:00.000Z',
      );

      expect(released).toEqual([
        {
          resourceKey: 'ssh:lifecycle-1',
          resourceType: 'ssh',
          holderId: 'holder-lifecycle-1',
          taskId: 'wf-launch/t1',
        },
      ]);
      expect(adapter.listExecutionResourceLeasesByTask('wf-launch/t1')).toEqual([]);
      expect(adapter.listExecutionResourceLeasesByTask('wf-launch/t2')).toHaveLength(1);
    });

    it('deleteWorkflow removes launch dispatches and execution resource leases for deleted tasks', () => {
      setupWorkflowAndTask('wf-launch', 'wf-launch/t1', {
        selectedAttemptId: 'attempt-delete-cleanup',
      });
      adapter.enqueueLaunchDispatch({
        taskId: 'wf-launch/t1',
        attemptId: 'attempt-delete-cleanup',
        workflowId: 'wf-launch',
        generation: 0,
      });
      expect(adapter.claimExecutionResourceLease({
        resourceKey: 'ssh:delete-cleanup',
        resourceType: 'ssh',
        holderId: 'holder-delete-cleanup',
        taskId: 'wf-launch/t1',
      })).toBe(true);

      adapter.deleteWorkflow('wf-launch');

      expect(adapter.listLaunchDispatchesByState(['enqueued', 'leased'])).toEqual([]);
      expect(adapter.listExecutionResourceLeases()).toEqual([]);
    });
  });

  describe('updateTask', () => {
    it('persists partial changes', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.updateTask('t1', { status: 'running', execution: { startedAt: new Date() } });

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].status).toBe('running');
      expect(loaded[0].execution.startedAt).toBeInstanceOf(Date);
    });

    it('persists execution generation on save and update', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { generation: 2 } }));

      let loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.generation).toBe(2);

      adapter.updateTask('t1', { execution: { generation: 5 } });

      loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.generation).toBe(5);
    });

    it('round-trips reviewGate through save and load', () => {
      adapter.saveWorkflow(testWorkflow);
      const reviewGate = {
        activeGeneration: 2,
        completion: { required: 'all', status: 'approved' },
        artifacts: [
          {
            id: 'contracts',
            title: 'Contracts',
            providerId: '101',
            required: true,
            status: 'approved',
            generation: 2,
          },
          {
            id: 'runtime',
            title: 'Runtime',
            providerId: '102',
            required: true,
            status: 'open',
            dependsOn: ['contracts'],
            generation: 2,
          },
        ],
      } as const;

      adapter.saveTask('wf-1', makeTask('t-review-gate', { execution: { reviewGate } }));

      const loaded = adapter.loadTask('t-review-gate');
      expect(loaded?.execution.reviewGate).toEqual(reviewGate);
    });

    it('clears reviewGate when updateTask receives undefined', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-review-gate-clear', {
        execution: {
          reviewGate: {
            activeGeneration: 1,
            completion: { required: 'all', status: 'approved' },
            artifacts: [
              { id: 'contracts', required: true, status: 'open', generation: 1 },
            ],
          },
        },
      }));

      adapter.updateTask('t-review-gate-clear', { execution: { reviewGate: undefined } });

      const loaded = adapter.loadTask('t-review-gate-clear');
      const stored = (adapter as any).db.exec(
        "SELECT review_gate FROM tasks WHERE id = 't-review-gate-clear'",
      ) as Array<{ values: unknown[][] }>;
      expect(loaded?.execution.reviewGate).toBeUndefined();
      expect(stored[0]?.values[0]?.[0]).toBeNull();
    });

    it('keeps reviewGate unchanged when updating another execution field', () => {
      adapter.saveWorkflow(testWorkflow);
      const reviewGate = {
        activeGeneration: 3,
        completion: { required: 'all', status: 'approved' },
        artifacts: [
          { id: 'contracts', required: true, status: 'approved', generation: 3 },
          {
            id: 'runtime',
            required: true,
            status: 'open',
            dependsOn: ['contracts'],
            generation: 3,
          },
        ],
      } as const;
      adapter.saveTask('wf-1', makeTask('t-review-gate-keep', { execution: { reviewGate } }));

      adapter.updateTask('t-review-gate-keep', { execution: { reviewStatus: 'approved' } });

      const loaded = adapter.loadTask('t-review-gate-keep');
      expect(loaded?.execution.reviewStatus).toBe('approved');
      expect(loaded?.execution.reviewGate).toEqual(reviewGate);
    });
  });

  describe('task-state version persistence', () => {
    it('saves task-state version 1 for new tasks and round-trips it', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].taskStateVersion).toBe(1);
    });

    it('preserves a custom task-state version value on save', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { taskStateVersion: 5 }));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].taskStateVersion).toBe(5);
    });

    it('increments task-state version atomically on every updateTask call', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.updateTask('t1', { status: 'running' });
      let loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].taskStateVersion).toBe(2);

      adapter.updateTask('t1', { status: 'completed' });
      loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].taskStateVersion).toBe(3);
    });

    it('increments task-state version even for execution-only updates', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.updateTask('t1', { execution: { startedAt: new Date() } });
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].taskStateVersion).toBe(2);
    });

    it('defaults to task-state version 1 for existing rows without the column', async () => {
      // The migration adds task_state_version with DEFAULT 1, so any
      // pre-existing rows that lack the column will get taskStateVersion = 1 on
      // load.
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].taskStateVersion).toBeGreaterThanOrEqual(1);
    });

    it('loadTask returns authoritative single task by id', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));

      const task = adapter.loadTask('t1');
      expect(task).toBeDefined();
      expect(task!.id).toBe('t1');
      expect(task!.taskStateVersion).toBe(1);
    });

    it('loadTask returns undefined for missing task', () => {
      expect(adapter.loadTask('nonexistent')).toBeUndefined();
    });

    it('loadTask reflects task-state version after updates', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.updateTask('t1', { status: 'running' });
      adapter.updateTask('t1', { status: 'completed' });

      const task = adapter.loadTask('t1');
      expect(task!.taskStateVersion).toBe(3);
    });
  });

  describe('failTaskAndAttempt', () => {
    it('atomically persists failed task and attempt on file-backed databases', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-fail-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);

        const attempt = createAttempt('t1', {
          status: 'running',
          startedAt: new Date(),
        });
        db.saveTask('wf-1', makeTask('t1', {
          status: 'running',
          execution: {
            selectedAttemptId: attempt.id,
            startedAt: new Date(),
          },
        }));
        db.saveAttempt(attempt);

        expect(() => {
          db.failTaskAndAttempt(
            't1',
            {
              status: 'failed',
              execution: {
                exitCode: 1,
                error: 'boom',
                completedAt: new Date(),
              },
            },
            {
              status: 'failed',
              exitCode: 1,
              error: 'boom',
              completedAt: new Date(),
            },
          );
        }).not.toThrow();

        const [task] = db.loadTasks('wf-1');
        expect(task.status).toBe('failed');
        expect(task.execution.exitCode).toBe(1);
        expect(task.execution.error).toBe('boom');

        const [savedAttempt] = db.loadAttempts('t1');
        expect(savedAttempt.status).toBe('failed');
        expect(savedAttempt.exitCode).toBe(1);
        expect(savedAttempt.error).toBe('boom');

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('selected-attempt reconciliation', () => {
    it('does not override fixing_with_ai with a failed selected attempt', () => {
      adapter.saveWorkflow(testWorkflow);
      const attempt = createAttempt('t1', {
        status: 'failed',
        exitCode: 1,
        error: 'boom',
        completedAt: new Date(),
      });
      adapter.saveTask('wf-1', makeTask('t1', {
        status: 'fixing_with_ai',
        execution: {
          selectedAttemptId: attempt.id,
          startedAt: new Date(),
        },
      }));
      adapter.saveAttempt(attempt);

      const [task] = adapter.loadTasks('wf-1');
      expect(task.status).toBe('fixing_with_ai');
    });
  });

  describe('loadActionGraphAttempts', () => {
    function attemptAt(id: string, status: Attempt['status'], createdAt: string, nodeId = 't1'): Attempt {
      return {
        ...createAttempt(nodeId, { status }),
        id,
        createdAt: new Date(createdAt),
      };
    }

    it('returns active attempts plus the selected terminal attempt', () => {
      adapter.saveWorkflow(testWorkflow);
      const selected = attemptAt('selected-superseded', 'superseded', '2026-01-01T00:05:00.000Z');
      adapter.saveTask('wf-1', makeTask('t1', {
        execution: { selectedAttemptId: selected.id },
      }));
      adapter.saveTask('wf-1', makeTask('t2'));
      const attempts = [
        attemptAt('old-superseded', 'superseded', '2026-01-01T00:00:00.000Z'),
        attemptAt('completed', 'completed', '2026-01-01T00:01:00.000Z'),
        attemptAt('failed', 'failed', '2026-01-01T00:02:00.000Z'),
        attemptAt('pending', 'pending', '2026-01-01T00:03:00.000Z'),
        attemptAt('claimed', 'claimed', '2026-01-01T00:04:00.000Z'),
        selected,
        attemptAt('running', 'running', '2026-01-01T00:06:00.000Z'),
        attemptAt('needs-input', 'needs_input', '2026-01-01T00:07:00.000Z'),
        attemptAt('unrelated-running', 'running', '2026-01-01T00:08:00.000Z', 't2'),
      ];
      for (const attempt of attempts) adapter.saveAttempt(attempt);

      expect(adapter.loadActionGraphAttempts('t1', selected.id).map((attempt) => attempt.id)).toEqual([
        'pending',
        'claimed',
        'selected-superseded',
        'running',
        'needs-input',
      ]);
    });

    it('returns active attempts plus the newest attempt when no selected attempt is present', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      const attempts = [
        attemptAt('completed-old', 'completed', '2026-01-01T00:00:00.000Z'),
        attemptAt('pending-current', 'pending', '2026-01-01T00:01:00.000Z'),
        attemptAt('running-current', 'running', '2026-01-01T00:02:00.000Z'),
        attemptAt('failed-newest', 'failed', '2026-01-01T00:03:00.000Z'),
      ];
      for (const attempt of attempts) adapter.saveAttempt(attempt);

      expect(adapter.loadActionGraphAttempts('t1').map((attempt) => attempt.id)).toEqual([
        'pending-current',
        'running-current',
        'failed-newest',
      ]);
    });

    it('keeps a recent cancelled attempt next to the active replacement', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      const attempts = [
        attemptAt('old-cancelled', 'superseded', '2026-01-01T00:00:00.000Z'),
        attemptAt('pending-current', 'pending', '2026-01-01T00:01:00.000Z'),
      ];
      for (const attempt of attempts) adapter.saveAttempt(attempt);

      expect(adapter.loadActionGraphAttempts('t1').map((attempt) => attempt.id)).toEqual([
        'old-cancelled',
        'pending-current',
      ]);
    });
  });

  describe('saveWorkflow + loadWorkflow', () => {
    it('round-trips a workflow', () => {
      adapter.saveWorkflow(testWorkflow);
      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded).toBeDefined();
      expect(loaded!.name).toBe('Test Workflow');
      expect(loaded!.status).toBe('pending');
      expect(loaded!.rollup?.countsByStatus.pending).toBe(0);
    });

    it('derives workflow status and rollup details from task rows', () => {
      adapter.saveWorkflow({ ...testWorkflow, status: 'completed' });
      adapter.saveTask('wf-1', makeTask('t1', {
        status: 'failed',
        execution: { error: 'first failure', exitCode: 10 },
      }));
      adapter.saveTask('wf-1', makeTask('t2', {
        status: 'failed',
        execution: { error: 'second failure', exitCode: 20 },
      }));

      const loaded = adapter.loadWorkflow('wf-1');

      expect(loaded!.status).toBe('failed');
      expect(loaded!.rollup?.countsByStatus.failed).toBe(2);
      expect(loaded!.rollup?.failedTasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskId: 't1', error: 'first failure', exitCode: 10 }),
          expect.objectContaining({ taskId: 't2', error: 'second failure', exitCode: 20 }),
        ]),
      );
    });

    it('derives stale workflow states from task rows', () => {
      adapter.saveWorkflow({ ...testWorkflow, status: 'running' });
      adapter.saveTask('wf-1', makeTask('t1', { status: 'stale' }));
      adapter.saveTask('wf-1', makeTask('t2', { status: 'stale' }));

      let loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.status).toBe('stale');
      expect(loaded!.rollup?.countsByStatus.stale).toBe(2);

      adapter.updateTask('t1', { status: 'completed' });

      loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.status).toBe('completed');
      expect(loaded!.rollup?.countsByStatus.completed).toBe(1);
      expect(loaded!.rollup?.countsByStatus.stale).toBe(1);
    });

    it('recomputes workflow status on every read after task state changes', () => {
      adapter.saveWorkflow({ ...testWorkflow, status: 'completed' });
      adapter.saveTask('wf-1', makeTask('t1', { status: 'pending' }));
      expect(adapter.loadWorkflow('wf-1')!.status).toBe('pending');

      adapter.updateTask('t1', { status: 'running' });
      expect(adapter.loadWorkflow('wf-1')!.status).toBe('running');

      adapter.updateTask('t1', { status: 'failed', execution: { error: 'live failure' } });
      const loaded = adapter.loadWorkflow('wf-1')!;
      expect(loaded.status).toBe('failed');
      expect(loaded.rollup?.failedTasks).toEqual([
        expect.objectContaining({ taskId: 't1', error: 'live failure' }),
      ]);
    });

    it('derives failed when pending work is blocked by failed dependencies', () => {
      adapter.saveWorkflow({ ...testWorkflow, status: 'running' });
      adapter.saveTask('wf-1', makeTask('alpha', { status: 'failed' }));
      adapter.saveTask('wf-1', makeTask('beta', { status: 'pending', dependencies: ['alpha'] }));
      adapter.saveTask('wf-1', makeTask('merge', { status: 'pending', dependencies: ['beta'] }));

      const loaded = adapter.loadWorkflow('wf-1')!;

      expect(loaded.status).toBe('failed');
      expect(loaded.rollup?.failedTasks).toEqual([
        expect.objectContaining({ taskId: 'alpha' }),
      ]);
    });

    it('derives failed when failed tasks do not block all pending work', () => {
      adapter.saveWorkflow({ ...testWorkflow, status: 'running' });
      adapter.saveTask('wf-1', makeTask('alpha', { status: 'failed' }));
      adapter.saveTask('wf-1', makeTask('independent', { status: 'pending' }));

      expect(adapter.loadWorkflow('wf-1')!.status).toBe('failed');
    });

    it('derives listWorkflows with one aggregate rollup per workflow', () => {
      adapter.saveWorkflow({ ...testWorkflow, status: 'running' });
      adapter.saveWorkflow({
        ...testWorkflow,
        id: 'wf-2',
        name: 'Second Workflow',
        status: 'running',
      });
      adapter.saveTask('wf-1', makeTask('wf1-a', { status: 'pending' }));
      adapter.saveTask('wf-1', makeTask('wf1-b', { status: 'pending' }));
      adapter.saveTask('wf-2', makeTask('wf2-a', { status: 'completed' }));
      adapter.saveTask('wf-2', makeTask('wf2-b', { status: 'fixing_with_ai', execution: { isFixingWithAI: true, agentName: 'codex' } }));

      const workflows = adapter.listWorkflows();
      const first = workflows.find((workflow) => workflow.id === 'wf-1')!;
      const second = workflows.find((workflow) => workflow.id === 'wf-2')!;

      expect(first.status).toBe('pending');
      expect(first.rollup?.countsByStatus.pending).toBe(2);
      expect(second.status).toBe('fixing_with_ai');
      expect(second.rollup?.fixingTasks).toEqual([
        expect.objectContaining({ taskId: 'wf2-b', agentName: 'codex' }),
      ]);
    });
  });

  describe('updateWorkflow', () => {
    it('ignores workflow status mutations because status is derived from tasks', () => {
      adapter.saveWorkflow(testWorkflow);
      // @ts-expect-error workflow status is derived output, not a persistence input.
      adapter.updateWorkflow('wf-1', { status: 'completed' });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.status).toBe('pending');
    });

    it('updates workflow updatedAt', () => {
      adapter.saveWorkflow(testWorkflow);
      const newTime = '2099-01-01T00:00:00.000Z';
      adapter.updateWorkflow('wf-1', { updatedAt: newTime });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.status).toBe('pending');
      expect(loaded!.updatedAt).toBe(newTime);
    });

    it('updates workflow metadata fields including repoUrl', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.updateWorkflow('wf-1', {
        name: 'Renamed',
        description: 'new description',
        visualProof: true,
        planFile: '/tmp/plan.yaml',
        repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
        intermediateRepoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker-Intermediate.git',
        branch: 'main',
        onFinish: 'pull_request',
        baseBranch: 'master',
        featureBranch: 'feature/generic-setters',
        mergeMode: 'external_review',
        reviewProvider: 'github',
      });

      expect(adapter.loadWorkflow('wf-1')).toMatchObject({
        name: 'Renamed',
        description: 'new description',
        visualProof: true,
        planFile: '/tmp/plan.yaml',
        repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
        intermediateRepoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker-Intermediate.git',
        branch: 'main',
        onFinish: 'pull_request',
        baseBranch: 'master',
        featureBranch: 'feature/generic-setters',
        mergeMode: 'external_review',
        reviewProvider: 'github',
      });
    });

    it('updates task description and representative config metadata', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('task-1'));
      adapter.updateTask('task-1', {
        description: 'Updated task',
        config: {
          poolId: 'some-pool',
          fixPrompt: 'fix this',
        },
      });

      expect(adapter.loadTask('task-1')).toMatchObject({
        description: 'Updated task',
        config: {
          poolId: 'some-pool',
          fixPrompt: 'fix this',
        },
      });
    });

    it('auto-sets updatedAt when not provided', () => {
      adapter.saveWorkflow(testWorkflow);
      const before = new Date().toISOString();
      adapter.updateWorkflow('wf-1', { generation: 1 });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.updatedAt >= before).toBe(true);
    });

    it('clears externalDependencies when the key is present with undefined', () => {
      adapter.saveWorkflow({
        ...testWorkflow,
        externalDependencies: [
          { workflowId: 'wf-upstream', taskId: '__merge__', requiredStatus: 'completed' },
        ],
      });

      adapter.updateWorkflow('wf-1', { externalDependencies: undefined });

      expect(adapter.loadWorkflow('wf-1')!.externalDependencies).toBeUndefined();
    });

    it('leaves externalDependencies untouched when the key is absent', () => {
      const deps = [
        { workflowId: 'wf-upstream', taskId: '__merge__', requiredStatus: 'completed' as const },
      ];
      adapter.saveWorkflow({ ...testWorkflow, externalDependencies: deps });

      adapter.updateWorkflow('wf-1', { generation: 2 });

      expect(adapter.loadWorkflow('wf-1')!.externalDependencies).toEqual(deps);
    });

    it('clears externalDependencyChanges when the key is present with undefined', () => {
      adapter.saveWorkflow({
        ...testWorkflow,
        externalDependencyChanges: [
          {
            before: { workflowId: 'wf-upstream', taskId: '__merge__', requiredStatus: 'completed' },
            changedAt: '2026-06-11T00:00:00.000Z',
          },
        ],
      });

      adapter.updateWorkflow('wf-1', { externalDependencyChanges: undefined });

      expect(adapter.loadWorkflow('wf-1')!.externalDependencyChanges).toBeUndefined();
    });

    it('leaves externalDependencyChanges untouched when the key is absent', () => {
      const changes = [
        {
          before: { workflowId: 'wf-upstream', taskId: '__merge__', requiredStatus: 'completed' as const },
          changedAt: '2026-06-11T00:00:00.000Z',
        },
      ];
      adapter.saveWorkflow({ ...testWorkflow, externalDependencyChanges: changes });

      adapter.updateWorkflow('wf-1', { generation: 2 });

      expect(adapter.loadWorkflow('wf-1')!.externalDependencyChanges).toEqual(changes);
    });

    it('round-trips detachedExternalDependencies provenance through save and load', () => {
      const provenance = [
        {
          workflowId: 'wf-upstream',
          taskId: '__merge__',
          requiredStatus: 'completed' as const,
          gatePolicy: 'review_ready' as const,
          detachedAt: '2026-06-12T00:00:00.000Z',
        },
      ];
      adapter.saveWorkflow({ ...testWorkflow, detachedExternalDependencies: provenance });

      expect(adapter.loadWorkflow('wf-1')!.detachedExternalDependencies).toEqual(provenance);
    });

    it('persists detachedExternalDependencies set via updateWorkflow', () => {
      adapter.saveWorkflow(testWorkflow);
      const provenance = [
        {
          workflowId: 'wf-upstream',
          requiredStatus: 'completed' as const,
          detachedAt: '2026-06-13T00:00:00.000Z',
        },
      ];

      adapter.updateWorkflow('wf-1', { detachedExternalDependencies: provenance });

      expect(adapter.loadWorkflow('wf-1')!.detachedExternalDependencies).toEqual(provenance);
    });

    it('clears detachedExternalDependencies when the key is present with undefined', () => {
      adapter.saveWorkflow({
        ...testWorkflow,
        detachedExternalDependencies: [
          {
            workflowId: 'wf-upstream',
            requiredStatus: 'completed',
            detachedAt: '2026-06-13T00:00:00.000Z',
          },
        ],
      });

      adapter.updateWorkflow('wf-1', { detachedExternalDependencies: undefined });

      expect(adapter.loadWorkflow('wf-1')!.detachedExternalDependencies).toBeUndefined();
    });

    it('leaves detachedExternalDependencies untouched when the key is absent', () => {
      const provenance = [
        {
          workflowId: 'wf-upstream',
          requiredStatus: 'completed' as const,
          detachedAt: '2026-06-13T00:00:00.000Z',
        },
      ];
      adapter.saveWorkflow({ ...testWorkflow, detachedExternalDependencies: provenance });

      adapter.updateWorkflow('wf-1', { generation: 2 });

      expect(adapter.loadWorkflow('wf-1')!.detachedExternalDependencies).toEqual(provenance);
    });
  });

  describe('logEvent + getEvents', () => {
    it('logs and retrieves events', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.logEvent('t1', 'started', { attempt: 1 });
      adapter.logEvent('t1', 'completed', { exitCode: 0 });

      const events = adapter.getEvents('t1');
      expect(events).toHaveLength(2);
      expect(events[0].eventType).toBe('started');
      expect(events[1].eventType).toBe('completed');
      expect(JSON.parse(events[0].payload!)).toEqual({ attempt: 1 });
    });

    it('uses the task event lookup index for ordered event reads', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const planRows = (adapter as any).db
        .prepare('EXPLAIN QUERY PLAN SELECT * FROM events WHERE task_id = ? ORDER BY id ASC')
        .all('t1') as Array<{ detail: string }>;
      const detail = planRows.map((row) => row.detail).join('\n');

      expect(detail).toContain('SEARCH events');
      expect(detail).toContain('idx_events_task_id_id');
      expect(detail).not.toContain('SCAN events');
      expect(detail).not.toContain('USE TEMP B-TREE');
    });

    it('returns limited task events in the requested order', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      for (let index = 0; index < 30; index += 1) {
        adapter.logEvent('t1', `event-${index}`, { index });
      }

      const events = adapter.getEvents('t1', 'desc', 20);

      expect(events).toHaveLength(20);
      expect(events.map((event) => event.eventType)).toEqual(
        Array.from({ length: 20 }, (_value, index) => `event-${29 - index}`),
      );
      expect(adapter.getEvents('t1', 'desc', 0)).toEqual([]);
    });
  });

  describe('JSON fields', () => {
    it('handles dependencies and experimentVariants correctly', () => {
      adapter.saveWorkflow(testWorkflow);

      const task = makeTask('t1', {
        dependencies: ['a', 'b'],
        config: {
          experimentVariants: [{ id: 'v1', description: 'V1', prompt: 'Try 1' }],
        },
        execution: {
          experimentResults: [{ id: 'exp1', status: 'completed', exitCode: 0 }],
        },
      });
      adapter.saveTask('wf-1', task);

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].dependencies).toEqual(['a', 'b']);
      expect(loaded[0].config.experimentVariants).toEqual([{ id: 'v1', description: 'V1', prompt: 'Try 1' }]);
      expect(loaded[0].execution.experimentResults).toEqual([{ id: 'exp1', status: 'completed', exitCode: 0 }]);
    });
  });

  describe('docker executor config', () => {
    it('round-trips task-level dockerImage on save and update', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', {
        config: {
          runnerKind: 'docker',
          dockerImage: 'node:20',
        },
      }));

      let [loaded] = adapter.loadTasks('wf-1');
      expect(loaded.config.runnerKind).toBe('docker');
      expect(loaded.config.dockerImage).toBe('node:20');

      adapter.updateTask('t1', {
        config: {
          dockerImage: 'invoker-agent:latest',
        },
      });

      [loaded] = adapter.loadTasks('wf-1');
      expect(loaded.config.dockerImage).toBe('invoker-agent:latest');
    });
  });

  describe('listWorkflows', () => {
    it('returns saved workflows ordered by creation time descending', () => {
      adapter.saveWorkflow({
        ...testWorkflow,
        id: 'wf-1',
        name: 'First',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      adapter.saveWorkflow({
        ...testWorkflow,
        id: 'wf-2',
        name: 'Second',
        createdAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      });

      const workflows = adapter.listWorkflows();
      expect(workflows).toHaveLength(2);
      expect(workflows[0].id).toBe('wf-2');
      expect(workflows[0].name).toBe('Second');
      expect(workflows[1].id).toBe('wf-1');
      expect(workflows[1].name).toBe('First');
    });

    it('returns empty array when no workflows exist', () => {
      const workflows = adapter.listWorkflows();
      expect(workflows).toHaveLength(0);
    });
  });

  describe('loadTasks returns tasks for a workflow', () => {
    it('returns only tasks belonging to the specified workflow', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveWorkflow({
        ...testWorkflow,
        id: 'wf-2',
        name: 'Other Workflow',
      });

      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));
      adapter.saveTask('wf-2', makeTask('t3'));

      const tasksWf1 = adapter.loadTasks('wf-1');
      expect(tasksWf1).toHaveLength(2);
      expect(tasksWf1.map((t) => t.id).sort()).toEqual(['t1', 't2']);

      const tasksWf2 = adapter.loadTasks('wf-2');
      expect(tasksWf2).toHaveLength(1);
      expect(tasksWf2[0].id).toBe('t3');
    });
  });

  describe('getSelectedExperiment', () => {
    it('returns selected experiment ID after update', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('recon-1', { config: { isReconciliation: true } }));
      adapter.updateTask('recon-1', { execution: { selectedExperiment: 'exp-winner' } });

      const result = adapter.getSelectedExperiment('recon-1');
      expect(result).toBe('exp-winner');
    });

    it('returns null when no experiment selected', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('recon-2'));

      const result = adapter.getSelectedExperiment('recon-2');
      expect(result).toBeNull();
    });

    it('returns null for non-existent task', () => {
      const result = adapter.getSelectedExperiment('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('deleteAllTasks', () => {
    it('clears all tasks for a workflow', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));

      adapter.deleteAllTasks('wf-1');
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded).toHaveLength(0);
    });

    it('removes output spool rows and tail cache for deleted workflow tasks', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-spool-1'));

      adapter.appendOutputChunk('t-spool-1', 'stale output\n');
      expect(adapter.getOutputTail('t-spool-1')).toHaveLength(1);

      adapter.deleteAllTasks('wf-1');

      expect(adapter.replayOutputFrom('t-spool-1', 0)).toEqual([]);
      expect(adapter.getOutputTail('t-spool-1')).toEqual([]);
    });

    it('removes durable workflow coordinator rows before deleting tasks', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const attempt = createAttempt('t1', { status: 'running' });
      adapter.saveAttempt(attempt);

      const intentId = adapter.enqueueWorkflowMutationIntent(
        'wf-1', 'test-channel', [{ action: 'delete' }], 'normal',
      );
      adapter.claimWorkflowMutationLease('wf-1', 'owner-1', {
        activeIntentId: intentId,
        activeMutationKind: 'delete',
      });
      adapter.enqueueLaunchDispatch({
        taskId: 't1',
        attemptId: attempt.id,
        workflowId: 'wf-1',
        generation: 1,
      });

      expect(() => adapter.deleteAllTasks('wf-1')).not.toThrow();

      expect(adapter.loadWorkflow('wf-1')).toBeDefined();
      expect(adapter.loadTasks('wf-1')).toEqual([]);
      expect(sqliteScalar(adapter, "SELECT COUNT(*) FROM workflow_mutation_intents WHERE workflow_id = 'wf-1'")).toBe(0);
      expect(sqliteScalar(adapter, "SELECT COUNT(*) FROM workflow_mutation_leases WHERE workflow_id = 'wf-1'")).toBe(0);
      expect(sqliteScalar(adapter, "SELECT COUNT(*) FROM task_launch_dispatch WHERE workflow_id = 'wf-1'")).toBe(0);
    });
  });

  describe('agentSessionId persistence', () => {
    it('round-trips agentSessionId through save and load', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { agentSessionId: 'sess-abc' } }));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.agentSessionId).toBe('sess-abc');
    });

    it('persists agentSessionId via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.updateTask('t1', { execution: { agentSessionId: 'sess-xyz' } });

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.agentSessionId).toBe('sess-xyz');
    });

    it('returns undefined when agentSessionId is not set', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.agentSessionId).toBeUndefined();
    });

    it('round-trips lastAgentSessionId and lastAgentName through save/load', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask(
        'wf-1',
        makeTask('t1', { execution: { lastAgentSessionId: 'sess-last-1', lastAgentName: 'codex' } }),
      );

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.lastAgentSessionId).toBe('sess-last-1');
      expect(loaded[0].execution.lastAgentName).toBe('codex');
    });

    it('persists lastAgentSessionId and lastAgentName via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.updateTask('t1', { execution: { lastAgentSessionId: 'sess-last-2', lastAgentName: 'claude' } });

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.lastAgentSessionId).toBe('sess-last-2');
      expect(loaded[0].execution.lastAgentName).toBe('claude');
    });
  });

  describe('agentName persistence', () => {
    it('round-trips agentName through save and load', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { agentName: 'codex' } }));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.agentName).toBe('codex');
    });

    it('persists agentName via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.updateTask('t1', { execution: { agentName: 'codex' } });

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.agentName).toBe('codex');
    });

    it('returns undefined when agentName is not set', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.agentName).toBeUndefined();
    });
  });

  describe('saveTask null defaults', () => {
    it('stores SQL NULL (not string literals) for missing optional fields', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const loaded = adapter.loadTasks('wf-1');
      const task = loaded[0];

      expect(task.config.runnerKind).toBeUndefined();
      expect(task.execution.agentSessionId).toBeUndefined();
      expect(task.execution.workspacePath).toBeUndefined();
      expect(task.execution.containerId).toBeUndefined();
    });

    it('does not store string "pending" as default for runnerKind', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].config.runnerKind).not.toBe('pending');
    });

  });

  describe('pendingFixError persistence', () => {
    it('round-trips pendingFixError through save and load', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { pendingFixError: 'build failed' } }));
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.pendingFixError).toBe('build failed');
    });

    it('persists pendingFixError via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.updateTask('t1', { execution: { pendingFixError: 'test error' } });
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.pendingFixError).toBe('test error');
    });

    it('clears pendingFixError via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { pendingFixError: 'error' } }));
      adapter.updateTask('t1', { execution: { pendingFixError: undefined } });
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.pendingFixError).toBeUndefined();
    });

    it('returns undefined when pendingFixError is not set', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.pendingFixError).toBeUndefined();
    });

    it('does not expose transient isFixingWithAI flags through task hydration', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.updateTask('t1', { execution: { isFixingWithAI: true } } as any);
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.isFixingWithAI).toBeUndefined();
    });

    it('clears isFixingWithAI via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { isFixingWithAI: true } }));
      adapter.updateTask('t1', { execution: { isFixingWithAI: undefined } } as any);
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.isFixingWithAI).toBeFalsy();
    });

    it('preserves persisted running status until compatibility migration is run', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.updateTask('t1', { status: 'running', execution: { isFixingWithAI: true } } as any);
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].status).toBe('running');
      expect(loaded[0].execution.isFixingWithAI).toBeUndefined();
    });
  });

  describe('getAgentSessionId', () => {
    it('returns session ID for a task with one', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { agentSessionId: 'sess-lookup' } }));

      expect(adapter.getAgentSessionId('t1')).toBe('sess-lookup');
    });

    it('returns null when no session ID set', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      expect(adapter.getAgentSessionId('t1')).toBeNull();
    });

    it('falls back to lastAgentSessionId when agentSessionId is absent', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { lastAgentSessionId: 'sess-last-lookup' } }));

      expect(adapter.getAgentSessionId('t1')).toBe('sess-last-lookup');
    });

    it('returns null for non-existent task', () => {
      expect(adapter.getAgentSessionId('nonexistent')).toBeNull();
    });
  });

  describe('getTaskStatus', () => {
    it('returns status for an existing task', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      expect(adapter.getTaskStatus('t1')).toBe('pending');
    });

    it('returns null for non-existent task', () => {
      expect(adapter.getTaskStatus('nonexistent')).toBeNull();
    });

    it('returns updated status after updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.updateTask('t1', { status: 'running' });

      expect(adapter.getTaskStatus('t1')).toBe('running');
    });

    it('returns raw running for persisted running + isFixingWithAI rows', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.updateTask('t1', { status: 'running', execution: { isFixingWithAI: true } } as any);
      expect(adapter.getTaskStatus('t1')).toBe('running');
    });
  });

  describe('deleteAllWorkflows', () => {
    it('deletes all workflows, tasks, and events', () => {
      adapter.saveWorkflow({
        id: 'wf-1',
        name: 'First',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      adapter.saveWorkflow({
        id: 'wf-2',
        name: 'Second',
        status: 'running',
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      });

      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-2', makeTask('t2'));
      adapter.logEvent('t1', 'started');

      adapter.deleteAllWorkflows();

      expect(adapter.listWorkflows()).toEqual([]);
      expect(adapter.loadTasks('wf-1')).toEqual([]);
      expect(adapter.loadTasks('wf-2')).toEqual([]);
      expect(adapter.getEvents('t1')).toEqual([]);
    });

    it('works on empty database', () => {
      adapter.deleteAllWorkflows();
      expect(adapter.listWorkflows()).toEqual([]);
    });

    it('clears output spool rows and in-memory tails for all tasks', () => {
      adapter.saveWorkflow({
        id: 'wf-del-all-1',
        name: 'First',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      adapter.saveWorkflow({
        id: 'wf-del-all-2',
        name: 'Second',
        status: 'running',
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      });
      adapter.saveTask('wf-del-all-1', makeTask('t-del-all-1'));
      adapter.saveTask('wf-del-all-2', makeTask('t-del-all-2'));

      adapter.appendOutputChunk('t-del-all-1', 'wf1 chunk\n');
      adapter.appendOutputChunk('t-del-all-2', 'wf2 chunk\n');
      expect(adapter.getOutputTail('t-del-all-1')).toHaveLength(1);
      expect(adapter.getOutputTail('t-del-all-2')).toHaveLength(1);

      adapter.deleteAllWorkflows();

      expect(adapter.replayOutputFrom('t-del-all-1', 0)).toEqual([]);
      expect(adapter.replayOutputFrom('t-del-all-2', 0)).toEqual([]);
      expect(adapter.getOutputTail('t-del-all-1')).toEqual([]);
      expect(adapter.getOutputTail('t-del-all-2')).toEqual([]);
    });
  });

  describe('deleteWorkflow', () => {
    it('deletes a single workflow and its tasks/events but keeps other workflows', () => {
      // Create two workflows with tasks and events
      adapter.saveWorkflow({
        id: 'wf-1',
        name: 'First',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      adapter.saveWorkflow({
        id: 'wf-2',
        name: 'Second',
        status: 'running',
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      });

      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));
      adapter.saveTask('wf-2', makeTask('t3'));

      adapter.logEvent('t1', 'started');
      adapter.logEvent('t2', 'started');
      adapter.logEvent('t3', 'started');

      adapter.appendTaskOutput('t1', 'output from t1\n');
      adapter.appendTaskOutput('t3', 'output from t3\n');

      // Delete wf-1
      adapter.deleteWorkflow('wf-1');

      // Assert wf-1 is gone
      const workflows = adapter.listWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].id).toBe('wf-2');
      expect(adapter.loadWorkflow('wf-1')).toBeUndefined();
      expect(adapter.loadTasks('wf-1')).toEqual([]);
      expect(adapter.getEvents('t1')).toEqual([]);
      expect(adapter.getEvents('t2')).toEqual([]);
      expect(adapter.getTaskOutput('t1')).toBe('');

      // Assert wf-2 is intact
      expect(adapter.loadWorkflow('wf-2')).toBeDefined();
      expect(adapter.loadWorkflow('wf-2')!.name).toBe('Second');
      const wf2Tasks = adapter.loadTasks('wf-2');
      expect(wf2Tasks).toHaveLength(1);
      expect(wf2Tasks[0].id).toBe('t3');
      expect(adapter.getEvents('t3')).toHaveLength(1);
      expect(adapter.getTaskOutput('t3')).toBe('output from t3\n');
    });

    it('works when workflow has no tasks', () => {
      adapter.saveWorkflow({
        id: 'wf-empty',
        name: 'Empty Workflow',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      adapter.deleteWorkflow('wf-empty');

      expect(adapter.loadWorkflow('wf-empty')).toBeUndefined();
      expect(adapter.listWorkflows()).toEqual([]);
    });

    it('deletes workflow that has attempts on its tasks', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const attempt = createAttempt('t1', { status: 'running' });
      adapter.saveAttempt(attempt);

      // Should not throw SQLITE_CONSTRAINT_FOREIGNKEY
      adapter.deleteWorkflow('wf-1');

      expect(adapter.loadWorkflow('wf-1')).toBeUndefined();
      expect(adapter.loadTasks('wf-1')).toEqual([]);
      expect(adapter.loadAttempts('t1')).toEqual([]);
    });

    it('is a no-op for non-existent workflow', () => {
      adapter.saveWorkflow({
        id: 'wf-exists',
        name: 'Existing',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      adapter.saveTask('wf-exists', makeTask('t1'));

      // Call deleteWorkflow on a non-existent workflow
      adapter.deleteWorkflow('nonexistent');

      // Verify no error and existing data is untouched
      expect(adapter.loadWorkflow('wf-exists')).toBeDefined();
      expect(adapter.loadTasks('wf-exists')).toHaveLength(1);
      expect(adapter.listWorkflows()).toHaveLength(1);
    });

    it('deletes workflow with mutation intents, leases, and launch dispatch rows', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const attempt = createAttempt('t1', { status: 'running' });
      adapter.saveAttempt(attempt);

      const intentId = adapter.enqueueWorkflowMutationIntent(
        'wf-1', 'test-channel', [{ action: 'delete' }], 'normal',
      );
      adapter.claimWorkflowMutationLease('wf-1', 'owner-1', {
        activeIntentId: intentId,
        activeMutationKind: 'delete',
      });
      adapter.enqueueLaunchDispatch({
        taskId: 't1',
        attemptId: attempt.id,
        workflowId: 'wf-1',
        generation: 1,
      });

      expect(() => adapter.deleteWorkflow('wf-1')).not.toThrow();

      expect(adapter.loadWorkflow('wf-1')).toBeUndefined();
      expect(adapter.loadTasks('wf-1')).toEqual([]);
      expect(sqliteScalar(adapter, "SELECT COUNT(*) FROM workflow_mutation_intents WHERE workflow_id = 'wf-1'")).toBe(0);
      expect(sqliteScalar(adapter, "SELECT COUNT(*) FROM workflow_mutation_leases WHERE workflow_id = 'wf-1'")).toBe(0);
      expect(sqliteScalar(adapter, "SELECT COUNT(*) FROM task_launch_dispatch WHERE workflow_id = 'wf-1'")).toBe(0);
    });

    it('removes output spool rows and tail cache only for deleted workflow tasks', () => {
      adapter.saveWorkflow({
        id: 'wf-delete-target',
        name: 'Delete Target',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      adapter.saveWorkflow({
        id: 'wf-keep',
        name: 'Keep',
        status: 'running',
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      });

      adapter.saveTask('wf-delete-target', makeTask('t-delete-spool'));
      adapter.saveTask('wf-keep', makeTask('t-keep-spool'));

      adapter.appendOutputChunk('t-delete-spool', 'delete me\n');
      adapter.appendOutputChunk('t-keep-spool', 'keep me\n');
      expect(adapter.getOutputTail('t-delete-spool')).toHaveLength(1);
      expect(adapter.getOutputTail('t-keep-spool')).toHaveLength(1);

      adapter.deleteWorkflow('wf-delete-target');

      expect(adapter.replayOutputFrom('t-delete-spool', 0)).toEqual([]);
      expect(adapter.getOutputTail('t-delete-spool')).toEqual([]);
      expect(adapter.replayOutputFrom('t-keep-spool', 0)).toHaveLength(1);
      expect(adapter.getOutputTail('t-keep-spool')).toHaveLength(1);
    });
  });

  // ── Task Output ──────────────────────────────────────

  describe('task output', () => {
    it('round-trips output chunks through append and get', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.appendTaskOutput('t1', 'line 1\n');
      adapter.appendTaskOutput('t1', 'line 2\n');
      adapter.appendTaskOutput('t1', '[worktree] Process exited: exitCode=0\n');

      const output = adapter.getTaskOutput('t1');
      expect(output).toContain('line 1');
      expect(output).toContain('line 2');
      expect(output).toContain('[worktree] Process exited');
    });

    it('returns empty string for task with no output', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const output = adapter.getTaskOutput('t1');
      expect(output).toBe('');
    });

    it('isolates output by task ID', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));

      adapter.appendTaskOutput('t1', 'task 1 output\n');
      adapter.appendTaskOutput('t2', 'task 2 output\n');

      expect(adapter.getTaskOutput('t1')).toContain('task 1');
      expect(adapter.getTaskOutput('t1')).not.toContain('task 2');
      expect(adapter.getTaskOutput('t2')).toContain('task 2');
    });

    it('preserves ordering of appended chunks', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.appendTaskOutput('t1', 'first\n');
      adapter.appendTaskOutput('t1', 'second\n');
      adapter.appendTaskOutput('t1', 'third\n');

      const output = adapter.getTaskOutput('t1');
      const firstIdx = output.indexOf('first');
      const secondIdx = output.indexOf('second');
      const thirdIdx = output.indexOf('third');
      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(thirdIdx);
    });

    it('keeps new task output out of SQLite while preserving readback', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-output-file-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-file-output'));

        const payload = 'x'.repeat(1024 * 1024);
        db.appendTaskOutput('t-file-output', payload);

        expect(sqliteScalar(db, 'SELECT COUNT(*) FROM task_output')).toBe(0);
        expect(db.getTaskOutput('t-file-output')).toBe(payload);

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns legacy SQLite task output before new file-backed output', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-output-legacy-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-legacy-output'));
        (db as any).db.run(
          'INSERT INTO task_output (task_id, data) VALUES (?, ?)',
          ['t-legacy-output', 'legacy\n'],
        );

        db.appendTaskOutput('t-legacy-output', 'file\n');

        expect(db.getTaskOutput('t-legacy-output')).toBe('legacy\nfile\n');

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('prefers output_spool chunks over task_output rows when both exist', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-output-prefer-spool-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-both'));

        // Legacy duplicated history in task_output (this would have been written
        // by the old flush path that double-wrote runner output).
        (db as any).db.run(
          'INSERT INTO task_output (task_id, data) VALUES (?, ?)',
          ['t-both', 'duplicate stream\n'],
        );

        // Canonical spool data is what should be returned.
        db.appendOutputChunk('t-both', 'spool line 1\n');
        db.appendOutputChunk('t-both', 'spool line 2\n');

        expect(db.getTaskOutput('t-both')).toBe('spool line 1\nspool line 2\n');

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('falls back to task_output when no output_spool chunks exist', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-output-fallback-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-fallback'));

        (db as any).db.run(
          'INSERT INTO task_output (task_id, data) VALUES (?, ?)',
          ['t-fallback', 'diagnostic-only\n'],
        );
        // No appendOutputChunk calls — only a diagnostic write to task_output.

        expect(db.getTaskOutput('t-fallback')).toBe('diagnostic-only\n');

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('surfaces appendTaskOutput diagnostic content alongside spool stream', async () => {
      // Regression: forced stops / executor startup failures append a
      // diagnostic block via appendTaskOutput. Without this, getTaskOutput
      // would discard the diagnostic when any spool chunks exist and post-
      // mortem inspection would see only the coarse forced-stop reason.
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-output-diag-tail-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-diag-tail'));

        db.appendOutputChunk('t-diag-tail', 'FAIL src/foo.test.ts\n');
        db.appendOutputChunk('t-diag-tail', 'Error: assertion failed\n');
        db.appendTaskOutput(
          't-diag-tail',
          '\n[Shutdown Diagnostic]\nstatus=running\nforcedStopReason=Application quit\n--- end shutdown diagnostic ---\n',
        );

        const output = db.getTaskOutput('t-diag-tail');
        expect(output).toContain('FAIL src/foo.test.ts');
        expect(output).toContain('Error: assertion failed');
        expect(output).toContain('[Shutdown Diagnostic]');
        expect(output).toContain('forcedStopReason=Application quit');
        // Diagnostic block must come after the streaming output, not before.
        expect(output.indexOf('FAIL src/foo.test.ts'))
          .toBeLessThan(output.indexOf('[Shutdown Diagnostic]'));

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('pruneDuplicateTaskOutputRows', () => {
    it('deletes task_output rows only for tasks that have output_spool rows', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-prune-dup-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-dup'));
        db.saveTask('wf-1', makeTask('t-diag-only'));

        // Duplicated stream: both tables contain rows for t-dup.
        (db as any).db.run(
          'INSERT INTO task_output (task_id, data) VALUES (?, ?)',
          ['t-dup', 'duplicate row 1\n'],
        );
        (db as any).db.run(
          'INSERT INTO task_output (task_id, data) VALUES (?, ?)',
          ['t-dup', 'duplicate row 2\n'],
        );
        (db as any).db.run(
          'INSERT INTO output_spool (task_id, offset, data) VALUES (?, ?, ?)',
          ['t-dup', 0, 'spool stream\n'],
        );

        // Diagnostic-only task with no spool row — must be preserved.
        (db as any).db.run(
          'INSERT INTO task_output (task_id, data) VALUES (?, ?)',
          ['t-diag-only', 'shutdown diagnostic\n'],
        );

        const result = db.pruneDuplicateTaskOutputRows();

        expect(result.deletedTaskOutputRows).toBe(2);
        expect(result.backupPath).toBeTruthy();
        expect(existsSync(result.backupPath!)).toBe(true);

        expect(sqliteScalar(db, "SELECT COUNT(*) FROM task_output WHERE task_id = 't-dup'"))
          .toBe(0);
        expect(sqliteScalar(db, "SELECT COUNT(*) FROM task_output WHERE task_id = 't-diag-only'"))
          .toBe(1);

        // t-dup now reads from spool; t-diag-only still reads from task_output.
        expect(db.getTaskOutput('t-dup')).toBe('spool stream\n');
        expect(db.getTaskOutput('t-diag-only')).toBe('shutdown diagnostic\n');

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('skips backup file when backup option is false', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-prune-nobackup-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-x'));
        (db as any).db.run(
          'INSERT INTO task_output (task_id, data) VALUES (?, ?)',
          ['t-x', 'dup\n'],
        );
        (db as any).db.run(
          'INSERT INTO output_spool (task_id, offset, data) VALUES (?, ?, ?)',
          ['t-x', 0, 'spool\n'],
        );

        const result = db.pruneDuplicateTaskOutputRows({ backup: false });
        expect(result.backupPath).toBeNull();
        expect(result.deletedTaskOutputRows).toBe(1);

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Conversations ──────────────────────────────────────

  function makeConversation(threadTs: string, overrides: Partial<Conversation> = {}): Conversation {
    return {
      threadTs,
      channelId: 'C123',
      userId: 'U456',
      extractedPlan: null,
      planSubmitted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('saveConversation + loadConversation', () => {
    it('round-trips a conversation through save and load', () => {
      adapter.saveConversation(makeConversation('1234567890.123456'));

      const loaded = adapter.loadConversation('1234567890.123456');
      expect(loaded).toBeDefined();
      expect(loaded!.threadTs).toBe('1234567890.123456');
      expect(loaded!.channelId).toBe('C123');
      expect(loaded!.userId).toBe('U456');
      expect(loaded!.extractedPlan).toBeNull();
      expect(loaded!.planSubmitted).toBe(false);
    });

    it('returns undefined for non-existent thread', () => {
      expect(adapter.loadConversation('nonexistent')).toBeUndefined();
    });

    it('persists extracted plan as JSON string', () => {
      const plan = JSON.stringify({ name: 'test-plan', tasks: [{ id: 't1', description: 'Do something' }] });
      adapter.saveConversation(makeConversation('ts-1', { extractedPlan: plan, planSubmitted: true }));

      const loaded = adapter.loadConversation('ts-1');
      expect(loaded!.extractedPlan).toBe(plan);
      expect(loaded!.planSubmitted).toBe(true);
      expect(JSON.parse(loaded!.extractedPlan!)).toEqual({
        name: 'test-plan',
        tasks: [{ id: 't1', description: 'Do something' }],
      });
    });

    it('upserts on duplicate thread_ts', () => {
      adapter.saveConversation(makeConversation('ts-1', { userId: 'U111' }));
      adapter.saveConversation(makeConversation('ts-1', { userId: 'U222' }));

      const loaded = adapter.loadConversation('ts-1');
      expect(loaded!.userId).toBe('U222');
    });
  });

  describe('updateConversation', () => {
    it('updates extractedPlan and planSubmitted', () => {
      adapter.saveConversation(makeConversation('ts-1'));

      const plan = JSON.stringify({ name: 'updated', tasks: [] });
      adapter.updateConversation('ts-1', { extractedPlan: plan, planSubmitted: true });

      const loaded = adapter.loadConversation('ts-1');
      expect(loaded!.extractedPlan).toBe(plan);
      expect(loaded!.planSubmitted).toBe(true);
    });

    it('bumps updated_at on every update', () => {
      adapter.saveConversation(makeConversation('ts-1', { updatedAt: '2024-01-01T00:00:00Z' }));

      adapter.updateConversation('ts-1', { planSubmitted: true, updatedAt: '2024-06-15T12:00:00Z' });

      const loaded = adapter.loadConversation('ts-1');
      expect(loaded!.updatedAt).toBe('2024-06-15T12:00:00Z');
    });
  });

  describe('deleteConversation', () => {
    it('removes conversation and its messages', () => {
      adapter.saveConversation(makeConversation('ts-1'));
      adapter.appendMessage('ts-1', 'user', '"hello"');
      adapter.appendMessage('ts-1', 'assistant', '"hi there"');

      adapter.deleteConversation('ts-1');

      expect(adapter.loadConversation('ts-1')).toBeUndefined();
      expect(adapter.loadMessages('ts-1')).toEqual([]);
    });
  });

  // ── Conversation Messages ──────────────────────────────

  describe('appendMessage + loadMessages', () => {
    it('appends messages with auto-incrementing seq', () => {
      adapter.saveConversation(makeConversation('ts-1'));

      adapter.appendMessage('ts-1', 'user', '"What should I build?"');
      adapter.appendMessage('ts-1', 'assistant', '"Let me explore the codebase."');
      adapter.appendMessage('ts-1', 'user', '"Sounds good"');

      const messages = adapter.loadMessages('ts-1');
      expect(messages).toHaveLength(3);
      expect(messages[0].seq).toBe(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('"What should I build?"');
      expect(messages[1].seq).toBe(2);
      expect(messages[1].role).toBe('assistant');
      expect(messages[2].seq).toBe(3);
      expect(messages[2].role).toBe('user');
    });

    it('returns empty array for thread with no messages', () => {
      adapter.saveConversation(makeConversation('ts-1'));
      expect(adapter.loadMessages('ts-1')).toEqual([]);
    });

    it('isolates messages by thread_ts', () => {
      adapter.saveConversation(makeConversation('ts-1'));
      adapter.saveConversation(makeConversation('ts-2'));

      adapter.appendMessage('ts-1', 'user', '"thread 1 msg"');
      adapter.appendMessage('ts-2', 'user', '"thread 2 msg"');
      adapter.appendMessage('ts-1', 'assistant', '"reply to thread 1"');

      const msgs1 = adapter.loadMessages('ts-1');
      const msgs2 = adapter.loadMessages('ts-2');

      expect(msgs1).toHaveLength(2);
      expect(msgs2).toHaveLength(1);
      expect(msgs1[0].content).toBe('"thread 1 msg"');
      expect(msgs2[0].content).toBe('"thread 2 msg"');
    });

    it('handles JSON-serialized complex content', () => {
      adapter.saveConversation(makeConversation('ts-1'));

      const complexContent = JSON.stringify([
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'src/index.ts' } },
      ]);
      adapter.appendMessage('ts-1', 'assistant', complexContent);

      const messages = adapter.loadMessages('ts-1');
      expect(messages).toHaveLength(1);
      const parsed = JSON.parse(messages[0].content);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].type).toBe('text');
      expect(parsed[1].type).toBe('tool_use');
    });
  });

  describe('loadAllCompletedTasks', () => {
    it('returns completed tasks across multiple workflows with workflowName', () => {
      adapter.saveWorkflow({ id: 'wf-1', name: 'First Plan', status: 'completed', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' });
      adapter.saveWorkflow({ id: 'wf-2', name: 'Second Plan', status: 'completed', createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' });

      adapter.saveTask('wf-1', makeTask('t1', { status: 'completed', execution: { completedAt: new Date('2024-01-02') } }));
      adapter.saveTask('wf-2', makeTask('t2', { status: 'completed', execution: { completedAt: new Date('2024-01-03') } }));
      adapter.saveTask('wf-1', makeTask('t3', { status: 'pending' }));

      const results = adapter.loadAllCompletedTasks();
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('t2');
      expect(results[1].id).toBe('t1');
      expect(results[0].workflowName).toBe('Second Plan');
      expect(results[1].workflowName).toBe('First Plan');
    });

    it('excludes non-completed tasks', () => {
      adapter.saveWorkflow({ id: 'wf-1', name: 'Test', status: 'running', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' });
      adapter.saveTask('wf-1', makeTask('t1', { status: 'pending' }));
      adapter.saveTask('wf-1', makeTask('t2', { status: 'running' }));
      adapter.saveTask('wf-1', makeTask('t3', { status: 'failed' }));

      const results = adapter.loadAllCompletedTasks();
      expect(results).toHaveLength(0);
    });

    it('returns empty array on empty database', () => {
      const results = adapter.loadAllCompletedTasks();
      expect(results).toHaveLength(0);
    });
  });

  describe('workflowId on tasks', () => {
    it('loadTasks returns workflowId on each task', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));

      const tasks = adapter.loadTasks('wf-1');
      expect(tasks).toHaveLength(2);
      expect(tasks[0].config.workflowId).toBe('wf-1');
      expect(tasks[1].config.workflowId).toBe('wf-1');
    });

    it('tasks from different workflows have correct workflowId', () => {
      adapter.saveWorkflow({ ...testWorkflow, id: 'wf-a', name: 'Workflow A' });
      adapter.saveWorkflow({ ...testWorkflow, id: 'wf-b', name: 'Workflow B' });
      adapter.saveTask('wf-a', makeTask('t1'));
      adapter.saveTask('wf-b', makeTask('t2'));

      const tasksA = adapter.loadTasks('wf-a');
      const tasksB = adapter.loadTasks('wf-b');
      expect(tasksA[0].config.workflowId).toBe('wf-a');
      expect(tasksB[0].config.workflowId).toBe('wf-b');
    });
  });

  describe('workflow merge config', () => {
    it('saveWorkflow persists onFinish, baseBranch, featureBranch, and intermediateRepoUrl', () => {
      const wf: Workflow = {
        ...testWorkflow,
        onFinish: 'merge',
        baseBranch: 'main',
        featureBranch: 'feat/test',
        intermediateRepoUrl: 'https://github.com/fork/repo.git',
      };
      adapter.saveWorkflow(wf);

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded).toBeDefined();
      expect(loaded!.onFinish).toBe('merge');
      expect(loaded!.baseBranch).toBe('main');
      expect(loaded!.featureBranch).toBe('feat/test');
      expect(loaded!.intermediateRepoUrl).toBe('https://github.com/fork/repo.git');
    });

    it('listWorkflows returns merge config fields', () => {
      adapter.saveWorkflow({
        ...testWorkflow,
        onFinish: 'pull_request',
        baseBranch: 'develop',
        featureBranch: 'feat/pr',
      });

      const workflows = adapter.listWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].onFinish).toBe('pull_request');
      expect(workflows[0].baseBranch).toBe('develop');
      expect(workflows[0].featureBranch).toBe('feat/pr');
    });

    it('merge config fields are undefined when not set', () => {
      adapter.saveWorkflow(testWorkflow);

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.onFinish).toBeUndefined();
      expect(loaded!.baseBranch).toBeUndefined();
      expect(loaded!.featureBranch).toBeUndefined();
    });

    it('listWorkflows returns full Workflow objects', () => {
      adapter.saveWorkflow({
        ...testWorkflow,
        planFile: 'plan.yaml',
        repoUrl: 'https://github.com/test',
        onFinish: 'merge',
      });

      const workflows = adapter.listWorkflows();
      expect(workflows[0].id).toBe('wf-1');
      expect(workflows[0].name).toBe('Test Workflow');
      expect(workflows[0].status).toBe('pending');
      expect(workflows[0].planFile).toBe('plan.yaml');
      expect(workflows[0].repoUrl).toBe('https://github.com/test');
      expect(workflows[0].onFinish).toBe('merge');
    });
  });

  describe('updateWorkflow with baseBranch', () => {
    it('updates baseBranch on an existing workflow', () => {
      adapter.saveWorkflow({ ...testWorkflow, baseBranch: 'main' });

      adapter.updateWorkflow('wf-1', { baseBranch: 'master' });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.baseBranch).toBe('master');
    });

    it('sets baseBranch when it was previously undefined', () => {
      adapter.saveWorkflow(testWorkflow);

      const before = adapter.loadWorkflow('wf-1');
      expect(before!.baseBranch).toBeUndefined();

      adapter.updateWorkflow('wf-1', { baseBranch: 'develop' });

      const after = adapter.loadWorkflow('wf-1');
      expect(after!.baseBranch).toBe('develop');
    });

    it('updates baseBranch without affecting status', () => {
      adapter.saveWorkflow(testWorkflow);

      adapter.updateWorkflow('wf-1', { baseBranch: 'release' });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.status).toBe('pending');
      expect(loaded!.baseBranch).toBe('release');
    });
  });

  describe('updateWorkflow with generation', () => {
    it('saves and loads generation field', () => {
      adapter.saveWorkflow({ ...testWorkflow, generation: 0 });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.generation).toBe(0);
    });

    it('defaults generation to 0 when not provided', () => {
      adapter.saveWorkflow(testWorkflow);

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.generation).toBe(0);
    });

    it('updates generation via updateWorkflow', () => {
      adapter.saveWorkflow(testWorkflow);

      adapter.updateWorkflow('wf-1', { generation: 3 });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.generation).toBe(3);
    });

    it('updates generation without affecting status or baseBranch', () => {
      adapter.saveWorkflow({ ...testWorkflow, baseBranch: 'master' });

      adapter.updateWorkflow('wf-1', { generation: 5 });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.status).toBe('pending');
      expect(loaded!.baseBranch).toBe('master');
      expect(loaded!.generation).toBe(5);
    });

    it('includes generation in listWorkflows', () => {
      adapter.saveWorkflow({ ...testWorkflow, generation: 2 });

      const workflows = adapter.listWorkflows();
      expect(workflows[0].generation).toBe(2);
    });
  });

  describe('getAllTaskIds', () => {
    it('returns empty array when no tasks', () => {
      expect(adapter.getAllTaskIds()).toEqual([]);
    });

    it('returns all task IDs across workflows', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveWorkflow({ ...testWorkflow, id: 'wf-2', name: 'Second' });
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));
      adapter.saveTask('wf-2', makeTask('t3'));

      const ids = adapter.getAllTaskIds();
      expect(ids.sort()).toEqual(['t1', 't2', 't3']);
    });
  });

  describe('getAllTaskBranches', () => {
    it('returns empty array when no tasks', () => {
      expect(adapter.getAllTaskBranches()).toEqual([]);
    });

    it('returns distinct non-null branches across workflows', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveWorkflow({ ...testWorkflow, id: 'wf-2', name: 'Second' });
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));
      adapter.saveTask('wf-2', makeTask('t3'));

      adapter.updateTask('t1', { execution: { branch: 'experiment/t1-abc12345' } } as any);
      adapter.updateTask('t2', { execution: { branch: 'experiment/t2-def67890' } } as any);

      const branches = adapter.getAllTaskBranches();
      expect(branches.sort()).toEqual([
        'experiment/t1-abc12345',
        'experiment/t2-def67890',
      ]);
    });

    it('deduplicates branches', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));

      adapter.updateTask('t1', { execution: { branch: 'experiment/shared-branch' } } as any);
      adapter.updateTask('t2', { execution: { branch: 'experiment/shared-branch' } } as any);

      const branches = adapter.getAllTaskBranches();
      expect(branches).toEqual(['experiment/shared-branch']);
    });
  });

  describe('logEvent FK constraint', () => {
    it('logEvent with a real task_id succeeds', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      expect(() => adapter.logEvent('t1', 'task.running')).not.toThrow();
    });

    it('logEvent with __workflow__ (non-existent task) throws FK error', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      expect(() => adapter.logEvent('__workflow__', 'workflow.completed')).toThrow(/FOREIGN KEY/);
    });
  });

  describe('orchestrator + SQLiteAdapter integration: checkWorkflowCompletion FK bug', () => {
    it('handleWorkerResponse does NOT throw FK error when workflow completes (FIX VERIFIED)', async () => {
      const { Orchestrator } = await import('@invoker/workflow-core');

      const bus = { publish() {} };
      const orchestrator = new Orchestrator({ persistence: adapter, messageBus: bus });

      orchestrator.loadPlan({
        name: 'FK Repro',
        tasks: [{ id: 'fk-t1', description: 'Will fail', command: 'false' }],
      });
      orchestrator.startExecution();

      expect(() => {
        orchestrator.handleWorkerResponse({
          requestId: 'req-1',
          actionId: 'fk-t1',
          executionGeneration: orchestrator.getTask('fk-t1')?.execution.generation ?? 0,
          status: 'failed',
          outputs: { exitCode: 1, error: 'boom' },
        });
      }).not.toThrow();
    });
  });

  describe('migrateTestCommands', () => {
    it('rewrites bad pnpm test commands when DB is re-opened', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'invoker-test-'));
      const dbPath = join(tmpDir, 'migrate.db');

      const db1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      db1.saveWorkflow(testWorkflow);
      db1.saveTask('wf-1', makeTask('t-bad1', {
        config: { command: 'pnpm test packages/protocol/src/__tests__/validation.test.ts' },
      }));
      db1.saveTask('wf-1', makeTask('t-bad2', {
        config: { command: 'pnpm test -- packages/surfaces/src/__tests__/slack.test.ts' },
      }));
      db1.saveTask('wf-1', makeTask('t-good', {
        config: { command: 'cd packages/protocol && pnpm test' },
      }));
      db1.close();

      const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      const tasks = db2.loadTasks('wf-1');
      const bad1 = tasks.find(t => t.id === 't-bad1')!;
      const bad2 = tasks.find(t => t.id === 't-bad2')!;
      const good = tasks.find(t => t.id === 't-good')!;

      expect(bad1.config.command).toBe('cd packages/protocol && pnpm test -- src/__tests__/validation.test.ts');
      expect(bad2.config.command).toBe('cd packages/surfaces && pnpm test -- src/__tests__/slack.test.ts');
      expect(good.config.command).toBe('cd packages/protocol && pnpm test');
      db2.close();

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('runCompatibilityMigration', () => {
    it('normalizes compatibility persisted shapes and reports migration counts', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('root', { status: 'failed' }));
      adapter.saveTask('wf-1', makeTask('root-exp-fix-child', {
        status: 'pending',
        dependencies: ['root'],
        config: { parentTask: 'root' },
      }));
      adapter.saveTask('wf-1', makeTask('recon-child', {
        status: 'pending',
        dependencies: ['root-exp-fix-child'],
        config: { parentTask: 'root-exp-fix-child', isReconciliation: true },
      }));
      adapter.saveTask('wf-1', makeTask('fixing-row', {
        status: 'running',
        execution: { isFixingWithAI: true },
      }));
      (adapter as any).db.run(`UPDATE workflows SET merge_mode = 'github' WHERE id = 'wf-1'`);

      const report = adapter.runCompatibilityMigration();

      expect(report).toEqual({
        migratedFixingWithAiStatuses: 1,
        normalizedMergeModes: 1,
        staleAutoFixExperimentTasks: 2,
        normalizedStaleLaunchMetadata: 0,
        normalizedLegacyAcknowledgedLaunchDispatches: 0,
        backfilledMissingSshPoolMemberIds: 0,
      });
      const taskById = new Map(adapter.loadTasks('wf-1').map((task) => [task.id, task]));
      expect(adapter.loadWorkflow('wf-1')?.mergeMode).toBe('external_review');
      expect(taskById.get('fixing-row')?.status).toBe('fixing_with_ai');
      expect(adapter.getTaskStatus('fixing-row')).toBe('fixing_with_ai');
      expect(taskById.get('root-exp-fix-child')?.status).toBe('stale');
      expect(taskById.get('recon-child')?.status).toBe('stale');
      expect(taskById.get('root-exp-fix-child')?.execution.error).toContain('Stale auto-fix experiment branch');

      const secondRun = adapter.runCompatibilityMigration();
      expect(secondRun).toEqual({
        migratedFixingWithAiStatuses: 0,
        normalizedMergeModes: 0,
        staleAutoFixExperimentTasks: 0,
        normalizedStaleLaunchMetadata: 0,
        normalizedLegacyAcknowledgedLaunchDispatches: 0,
        backfilledMissingSshPoolMemberIds: 0,
      });
    });

    it('repairs missing SSH pool member ids from the latest executor-selected event', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('ssh-old', {
        status: 'completed',
        config: { runnerKind: 'ssh' },
        execution: { workspacePath: '~/.invoker/worktrees/ssh-old', branch: 'experiment/ssh-old' },
      }));
      adapter.logEvent('ssh-old', 'task.executor.selected', { runnerKind: 'ssh', poolMemberId: 'remote-old' });
      adapter.logEvent('ssh-old', 'task.executor.selected', { runnerKind: 'ssh', poolMemberId: 'remote-new' });

      const report = adapter.runCompatibilityMigration();

      expect(report.backfilledMissingSshPoolMemberIds).toBe(1);
      expect(adapter.getPoolMemberId('ssh-old')).toBe('remote-new');
      expect(adapter.loadTask('ssh-old')?.config).toMatchObject({ runnerKind: 'ssh', poolMemberId: 'remote-new' });
      expect(adapter.runCompatibilityMigration().backfilledMissingSshPoolMemberIds).toBe(0);
    });

    it('does not repair missing SSH pool member ids from malformed or empty event payloads', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('ssh-empty', { config: { runnerKind: 'ssh' } }));
      adapter.logEvent('ssh-empty', 'task.executor.selected', { runnerKind: 'ssh', poolMemberId: '  ' });
      adapter.saveTask('wf-1', makeTask('ssh-bad', { config: { runnerKind: 'ssh' } }));
      (adapter as any).db.run(
        `INSERT INTO events (task_id, event_type, payload) VALUES ('ssh-bad', 'task.executor.selected', '{')`,
      );

      const report = adapter.runCompatibilityMigration();

      expect(report.backfilledMissingSshPoolMemberIds).toBe(0);
      expect(adapter.getPoolMemberId('ssh-empty')).toBeNull();
      expect(adapter.getPoolMemberId('ssh-bad')).toBeNull();
    });

    it('normalizes stale terminal launch metadata without touching legitimate long executions', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('stale-launch', {
        status: 'failed',
        execution: {
          phase: 'launching',
          launchStartedAt: new Date('2026-05-13T18:11:40.000Z'),
          launchCompletedAt: undefined,
          startedAt: new Date('2026-05-15T07:29:37.000Z'),
          completedAt: new Date('2026-05-15T07:29:37.000Z'),
          error: 'fixWithAgent: task has no valid workspace (workspacePath=undefined)',
        },
      }));
      adapter.saveTask('wf-1', makeTask('long-running', {
        status: 'completed',
        execution: {
          phase: 'executing',
          launchStartedAt: new Date('2026-05-15T07:25:54.000Z'),
          launchCompletedAt: new Date('2026-05-15T07:26:18.000Z'),
          startedAt: new Date('2026-05-15T07:26:18.000Z'),
          completedAt: new Date('2026-05-15T09:46:52.000Z'),
        },
      }));

      const report = adapter.runCompatibilityMigration();

      expect(report.normalizedStaleLaunchMetadata).toBe(1);
      const taskById = new Map(adapter.loadTasks('wf-1').map((task) => [task.id, task]));
      expect(taskById.get('stale-launch')?.execution.phase).toBeUndefined();
      expect(taskById.get('stale-launch')?.execution.launchStartedAt).toBeUndefined();
      expect(taskById.get('stale-launch')?.execution.launchCompletedAt).toBeUndefined();
      expect(taskById.get('long-running')?.execution.launchStartedAt?.toISOString()).toBe('2026-05-15T07:25:54.000Z');
      expect(taskById.get('long-running')?.execution.launchCompletedAt?.toISOString()).toBe('2026-05-15T07:26:18.000Z');

      const secondRun = adapter.runCompatibilityMigration();
      expect(secondRun.normalizedStaleLaunchMetadata).toBe(0);
    });

    it('normalizes stale pending launch claims when their dispatch is no longer active', () => {
      adapter.saveWorkflow(testWorkflow);
      const expiredAt = new Date(Date.now() - 60_000);
      const claimedAt = new Date(expiredAt.getTime() - 60_000);
      const liveClaimedAt = new Date();
      const liveExpiresAt = new Date(Date.now() + 60_000);
      const expiredAttempt = createAttempt('stale-pending-launch', {
        status: 'claimed',
        claimedAt,
        lastHeartbeatAt: claimedAt,
        leaseExpiresAt: expiredAt,
      });
      const liveAttempt = createAttempt('live-pending-launch', {
        status: 'claimed',
        claimedAt: liveClaimedAt,
        lastHeartbeatAt: liveClaimedAt,
        leaseExpiresAt: liveExpiresAt,
      });
      adapter.saveTask('wf-1', makeTask('stale-pending-launch', {
        status: 'pending',
        execution: {
          phase: 'launching',
          selectedAttemptId: expiredAttempt.id,
          launchStartedAt: claimedAt,
          lastHeartbeatAt: claimedAt,
        },
      }));
      adapter.saveTask('wf-1', makeTask('live-pending-launch', {
        status: 'pending',
        execution: {
          phase: 'launching',
          selectedAttemptId: liveAttempt.id,
          launchStartedAt: new Date(),
          lastHeartbeatAt: new Date(),
        },
      }));
      adapter.updateTask('stale-pending-launch', {
        execution: { selectedAttemptId: expiredAttempt.id },
      });
      adapter.updateTask('live-pending-launch', {
        execution: { selectedAttemptId: liveAttempt.id },
      });
      adapter.saveAttempt(expiredAttempt);
      adapter.saveAttempt(liveAttempt);
      const staleDispatch = adapter.enqueueLaunchDispatch({
        taskId: 'stale-pending-launch',
        attemptId: expiredAttempt.id,
        workflowId: 'wf-1',
        generation: 0,
      });
      adapter.markLaunchDispatchAbandoned(
        staleDispatch.id,
        'task is no longer launch-ready',
        '2026-06-04T01:57:45.435Z',
      );
      const liveDispatch = adapter.enqueueLaunchDispatch({
        taskId: 'live-pending-launch',
        attemptId: liveAttempt.id,
        workflowId: 'wf-1',
        generation: 0,
      });

      const report = adapter.runCompatibilityMigration();

      expect(report.normalizedStaleLaunchMetadata).toBe(1);
      const staleTask = adapter.loadTask('stale-pending-launch');
      expect(staleTask?.status).toBe('pending');
      expect(staleTask?.execution.phase).toBeUndefined();
      expect(staleTask?.execution.launchStartedAt).toBeUndefined();
      expect(staleTask?.execution.lastHeartbeatAt).toBeUndefined();
      expect(adapter.loadAttempt(expiredAttempt.id)?.status).toBe('pending');
      expect(adapter.loadAttempt(expiredAttempt.id)?.claimedAt).toBeUndefined();
      expect(adapter.loadAttempt(expiredAttempt.id)?.leaseExpiresAt).toBeUndefined();

      const liveTask = adapter.loadTask('live-pending-launch');
      expect(liveTask?.execution.phase).toBe('launching');
      expect(adapter.loadAttempt(liveAttempt.id)?.status).toBe('claimed');
      expect(adapter.loadLaunchDispatchById(liveDispatch.id)?.state).toBe('enqueued');
      expect(adapter.runCompatibilityMigration().normalizedStaleLaunchMetadata).toBe(0);
    });
  });

  describe('getExecutionAgent — agent_name vs execution_agent', () => {
    it('returns execution_agent when agent_name is not set', () => {
      adapter.saveWorkflow(testWorkflow);
      const task = makeTask('t-agent-1', {
        config: { workflowId: 'wf-1', executionAgent: 'codex' },
      });
      adapter.saveTask('wf-1', task);

      expect(adapter.getExecutionAgent('t-agent-1')).toBe('codex');
    });

    it('returns agent_name (from fix flow) over execution_agent (from config)', () => {
      adapter.saveWorkflow(testWorkflow);
      // Task created with executionAgent: 'claude' in config
      const task = makeTask('t-agent-2', {
        config: { workflowId: 'wf-1', command: 'pnpm test', executionAgent: 'claude' },
      });
      adapter.saveTask('wf-1', task);

      // Fix with codex sets execution.agentName
      adapter.updateTask('t-agent-2', {
        execution: { agentName: 'codex' },
      });

      // getExecutionAgent should return 'codex' (agent_name) not 'claude' (execution_agent)
      expect(adapter.getExecutionAgent('t-agent-2')).toBe('codex');
    });

    it('returns execution_agent for prompt tasks when stale agent_name disagrees', () => {
      adapter.saveWorkflow(testWorkflow);
      const task = makeTask('t-agent-prompt-stale', {
        status: 'completed',
        config: {
          workflowId: 'wf-1',
          prompt: 'Design experiment and alternative proof task for INV-130.',
          executionAgent: 'codex',
        },
        execution: {
          agentName: 'claude',
          lastAgentName: 'claude',
          agentSessionId: '019e386c-87c7-71e1-80bb-eb649ae99b82',
        },
      });
      adapter.saveTask('wf-1', task);

      expect(adapter.getExecutionAgent('t-agent-prompt-stale')).toBe('codex');
    });

    it('returns agent_name when execution_agent is null', () => {
      adapter.saveWorkflow(testWorkflow);
      // Task created without executionAgent in config
      const task = makeTask('t-agent-3', {
        config: { workflowId: 'wf-1' },
      });
      adapter.saveTask('wf-1', task);

      // Fix with codex
      adapter.updateTask('t-agent-3', {
        execution: { agentName: 'codex', agentSessionId: 'sess-123' },
      });

      expect(adapter.getExecutionAgent('t-agent-3')).toBe('codex');
    });

    it('falls back to lastAgentName when a completed command task keeps only the last session', () => {
      adapter.saveWorkflow(testWorkflow);
      const task = makeTask('t-agent-last-only', {
        status: 'completed',
        config: { workflowId: 'wf-1', command: 'pnpm test' },
        execution: {
          lastAgentSessionId: 'sess-codex-last',
          lastAgentName: 'codex',
          workspacePath: '/tmp/worktree-last',
        },
      });
      adapter.saveTask('wf-1', task);

      expect(adapter.getAgentSessionId('t-agent-last-only')).toBe('sess-codex-last');
      expect(adapter.getExecutionAgent('t-agent-last-only')).toBe('codex');
    });

    it('returns null when neither agent_name nor execution_agent is set', () => {
      adapter.saveWorkflow(testWorkflow);
      const task = makeTask('t-agent-4', {
        config: { workflowId: 'wf-1' },
      });
      adapter.saveTask('wf-1', task);

      expect(adapter.getExecutionAgent('t-agent-4')).toBeNull();
    });
  });

  describe('end-to-end: fix-with-codex → open-terminal reads codex', () => {
    it('simulates headless fix codex flow and verifies getExecutionAgent returns codex', () => {
      adapter.saveWorkflow(testWorkflow);
      // 1. Task created with default config (no executionAgent set — like most plans)
      const task = makeTask('t-fix-e2e', {
        status: 'failed',
        config: { workflowId: 'wf-1', command: 'pnpm test' },
        execution: { error: 'test failed', workspacePath: '/tmp/worktree-abc', branch: 'experiment/abc' },
      });
      adapter.saveTask('wf-1', task);

      // 2. fixWithAgentImpl persists agentSessionId + agentName (codex)
      adapter.updateTask('t-fix-e2e', {
        execution: { agentSessionId: 'sess-codex-999', agentName: 'codex' },
      });

      // 3. open-terminal reads getExecutionAgent — must return 'codex'
      expect(adapter.getExecutionAgent('t-fix-e2e')).toBe('codex');

      // 4. Also verify agentSessionId survived the same updateTask call
      expect(adapter.getAgentSessionId('t-fix-e2e')).toBe('sess-codex-999');
    });

    it('setFixAwaitingApproval does not clobber agent_name', () => {
      adapter.saveWorkflow(testWorkflow);
      const task = makeTask('t-fix-approve', {
        status: 'fixing_with_ai',
        config: { workflowId: 'wf-1', command: 'pnpm test' },
        execution: { workspacePath: '/tmp/worktree-xyz' },
      });
      adapter.saveTask('wf-1', task);

      // fixWithAgentImpl writes agentName + agentSessionId
      adapter.updateTask('t-fix-approve', {
        execution: { agentSessionId: 'sess-codex-approve', agentName: 'codex' },
      });

      // setFixAwaitingApproval writes status + pendingFixError + isFixingWithAI + agentSessionId
      // (but NOT agentName — it must survive)
      adapter.updateTask('t-fix-approve', {
        status: 'awaiting_approval' as any,
        execution: { pendingFixError: 'original error', isFixingWithAI: false, agentSessionId: 'sess-codex-approve' },
      });

      // agent_name must still be 'codex' after the status transition
      expect(adapter.getExecutionAgent('t-fix-approve')).toBe('codex');
      expect(adapter.getAgentSessionId('t-fix-approve')).toBe('sess-codex-approve');
    });
  });

  describe('read-only / flush safety', () => {
    it('opens file-backed databases in WAL mode with durable pragmas', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-wal-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        expect((db as any).db.exec('PRAGMA journal_mode')[0].values[0][0]).toBe('wal');
        expect(sqliteScalar(db, 'PRAGMA synchronous')).toBe(2);
        expect(sqliteScalar(db, 'PRAGMA foreign_keys')).toBe(1);
        expect(sqliteScalar(db, 'PRAGMA busy_timeout')).toBe(5000);
        expect(sqliteScalar(db, 'PRAGMA wal_autocheckpoint')).toBe(1000);
        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('persists file-backed writes before close so restart recovery can read them', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-durable-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        const writer = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        writer.saveWorkflow(testWorkflow);
        writer.saveTask(testWorkflow.id, makeTask('t-durable-before-close'));

        const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
        const loaded = reader.loadTasks(testWorkflow.id);
        expect(loaded.map((task) => task.id)).toContain('t-durable-before-close');
        reader.close();
        writer.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not leave file-backed read cursors holding locks before later writes', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-read-cursor-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);

        expect(db.loadWorkflow(testWorkflow.id)).toBeDefined();

        db.enqueueWorkflowMutationIntent(testWorkflow.id, 'headless.exec', [{ args: ['rebase-recreate', testWorkflow.id] }], 'high');
        expect(db.listWorkflowMutationIntents(testWorkflow.id, ['queued'])).toHaveLength(1);
        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('commits successful transactions and rolls back failed transactions across reopen', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-transaction-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.runInTransaction(() => {
          db.saveWorkflow({ ...testWorkflow, id: 'wf-commit' });
        });
        expect(() =>
          db.runInTransaction(() => {
            db.saveWorkflow({ ...testWorkflow, id: 'wf-rollback' });
            throw new Error('rollback sentinel');
          }),
        ).toThrow(/rollback sentinel/);
        db.close();

        const reopened = await SQLiteAdapter.create(dbPath, { readOnly: true });
        expect(reopened.loadWorkflow('wf-commit')).toBeDefined();
        expect(reopened.loadWorkflow('wf-rollback')).toBeUndefined();
        reopened.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not rewrite db file when closed without writes', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-readonly-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        const writer = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        writer.saveWorkflow(testWorkflow);
        writer.saveTask(testWorkflow.id, makeTask('t-read-only'));
        writer.close();

        const before = statSync(dbPath).mtimeMs;
        await new Promise((resolve) => setTimeout(resolve, 20));

        const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
        const loaded = reader.loadTasks(testWorkflow.id);
        expect(loaded).toHaveLength(1);
        reader.close();

        const after = statSync(dbPath).mtimeMs;
        expect(after).toBe(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws if a read-only adapter attempts to write', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-readonly-write-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        const writer = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        writer.saveWorkflow(testWorkflow);
        writer.saveTask(testWorkflow.id, makeTask('t-read-only-write'));
        writer.close();

        const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
        expect(() =>
          reader.updateTask('t-read-only-write', { status: 'failed' }),
        ).toThrow(/read-only/i);
        reader.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('owner-only writable initialization', () => {
    it('allows writable init with ownerCapability=true for file-backed DB', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-owner-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);
        db.saveTask(testWorkflow.id, makeTask('t-owner-write'));
        db.close();

        // Verify write succeeded
        const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const tasks = db2.loadTasks(testWorkflow.id);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].id).toBe('t-owner-write');
        db2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects writable init without ownerCapability for file-backed DB', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-non-owner-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        await expect(
          SQLiteAdapter.create(dbPath),
        ).rejects.toThrow(/owner capability/i);

        await expect(
          SQLiteAdapter.create(dbPath, { readOnly: false }),
        ).rejects.toThrow(/owner capability/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('allows read-only init without ownerCapability', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-readonly-no-cap-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        // Create DB with owner capability
        const writer = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        writer.saveWorkflow(testWorkflow);
        writer.close();

        // Open read-only without owner capability — should succeed
        const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
        const workflows = reader.listWorkflows();
        expect(workflows).toHaveLength(1);
        reader.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('allows writable init for in-memory DB without ownerCapability', async () => {
      // In-memory DBs bypass owner check (no persistent state to guard)
      const db = await SQLiteAdapter.create(':memory:');
      db.saveWorkflow(testWorkflow);
      const workflows = db.listWorkflows();
      expect(workflows).toHaveLength(1);
      db.close();
    });
  });

  // ── Output Spool Regression Tests ──────────────────────

  describe('output spool: monotonic offsets', () => {
    it('appends chunks with strictly increasing offset values', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-offset'));

      // Append multiple chunks
      adapter.appendOutputChunk('t-offset', 'chunk 1\n');
      adapter.appendOutputChunk('t-offset', 'chunk 2\n');
      adapter.appendOutputChunk('t-offset', 'chunk 3\n');

      // Retrieve chunks with their offsets
      const chunks = adapter.getOutputChunks('t-offset');
      expect(chunks).toHaveLength(3);
      expect(chunks[0].offset).toBe(0);
      expect(chunks[1].offset).toBe(8);  // 'chunk 1\n'.length
      expect(chunks[2].offset).toBe(16); // cumulative: 8 + 'chunk 2\n'.length
      expect(chunks[0].data).toBe('chunk 1\n');
      expect(chunks[1].data).toBe('chunk 2\n');
      expect(chunks[2].data).toBe('chunk 3\n');
    });

    it('maintains monotonic offsets across multiple append calls', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-monotonic'));

      const chunks = ['a', 'bb', 'ccc', 'dddd'];
      for (const chunk of chunks) {
        adapter.appendOutputChunk('t-monotonic', chunk);
      }

      const stored = adapter.getOutputChunks('t-monotonic');
      expect(stored).toHaveLength(4);

      // Verify offsets are strictly increasing and match cumulative byte length
      let expectedOffset = 0;
      for (let i = 0; i < stored.length; i++) {
        expect(stored[i].offset).toBe(expectedOffset);
        expectedOffset += Buffer.byteLength(chunks[i], 'utf8');
      }
    });

    it('handles concurrent chunk appends without offset collision', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-concurrent'));

      // Simulate rapid concurrent appends
      const appendCount = 50;
      for (let i = 0; i < appendCount; i++) {
        adapter.appendOutputChunk('t-concurrent', `line ${i}\n`);
      }

      const chunks = adapter.getOutputChunks('t-concurrent');
      expect(chunks).toHaveLength(appendCount);

      // Verify all offsets are unique and monotonically increasing
      const offsets = chunks.map(c => c.offset);
      const uniqueOffsets = new Set(offsets);
      expect(uniqueOffsets.size).toBe(appendCount);

      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
      }
    });
  });

  describe('output spool: replay from offset', () => {
    it('allows late subscriber to replay all output from offset 0', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-replay'));

      adapter.appendOutputChunk('t-replay', 'early output\n');
      adapter.appendOutputChunk('t-replay', 'middle output\n');
      adapter.appendOutputChunk('t-replay', 'late output\n');

      // Late subscriber starts from beginning
      const chunks = adapter.replayOutputFrom('t-replay', 0);
      expect(chunks).toHaveLength(3);
      expect(chunks[0].data).toBe('early output\n');
      expect(chunks[1].data).toBe('middle output\n');
      expect(chunks[2].data).toBe('late output\n');
    });

    it('replays only chunks after specified offset', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-partial-replay'));

      adapter.appendOutputChunk('t-partial-replay', 'chunk 1\n'); // offset 0
      adapter.appendOutputChunk('t-partial-replay', 'chunk 2\n'); // offset 8
      adapter.appendOutputChunk('t-partial-replay', 'chunk 3\n'); // offset 16

      // Subscriber already has offset 0-7, wants chunks from offset 8 onward
      const chunks = adapter.replayOutputFrom('t-partial-replay', 8);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].offset).toBe(8);
      expect(chunks[0].data).toBe('chunk 2\n');
      expect(chunks[1].offset).toBe(16);
      expect(chunks[1].data).toBe('chunk 3\n');
    });

    it('returns empty array when offset is beyond all chunks', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-future-offset'));

      adapter.appendOutputChunk('t-future-offset', 'only chunk\n'); // offset 0, length 11

      const chunks = adapter.replayOutputFrom('t-future-offset', 999);
      expect(chunks).toEqual([]);
    });

    it('prevents duplicate chunk delivery across offset boundaries', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-no-dup'));

      adapter.appendOutputChunk('t-no-dup', 'A');
      adapter.appendOutputChunk('t-no-dup', 'B');
      adapter.appendOutputChunk('t-no-dup', 'C');

      // First subscriber reads from 0
      const batch1 = adapter.replayOutputFrom('t-no-dup', 0);
      expect(batch1.map(c => c.data)).toEqual(['A', 'B', 'C']);

      // Second subscriber reads from offset after 'A' (offset 1)
      const batch2 = adapter.replayOutputFrom('t-no-dup', 1);
      expect(batch2.map(c => c.data)).toEqual(['B', 'C']);

      // Verify no overlap at the boundary where subscriber resumes (after first chunk)
      const firstOffset2 = batch2[0].offset;
      const resumeOffset = batch1[0].offset + batch1[0].data.length;
      expect(firstOffset2).toBeGreaterThanOrEqual(resumeOffset);
    });

    it('continues offsets from legacy SQLite spool rows into file-backed chunks', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-spool-legacy-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-legacy-spool'));
        (db as any).db.run(
          'INSERT INTO output_spool (task_id, offset, data) VALUES (?, ?, ?)',
          ['t-legacy-spool', 0, 'old'],
        );

        db.appendOutputChunk('t-legacy-spool', 'new');

        expect(sqliteScalar(db, "SELECT COUNT(*) FROM output_spool WHERE task_id = 't-legacy-spool'")).toBe(1);
        expect(db.replayOutputFrom('t-legacy-spool', 0)).toEqual([
          { offset: 0, data: 'old' },
          { offset: 3, data: 'new' },
        ]);
        expect(db.replayOutputFrom('t-legacy-spool', 3)).toEqual([
          { offset: 3, data: 'new' },
        ]);

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('output spool: in-memory cache with tail limit', () => {
    it('retains only recent tail in memory after exceeding limit', async () => {
      const tailLimit = 3;
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-tail-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true, outputTailLimit: tailLimit });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-tail'));

        // Append more chunks than the tail limit
        for (let i = 0; i < 10; i++) {
          db.appendOutputChunk('t-tail', `line ${i}\n`);
        }

        // In-memory tail should contain only last 3 chunks
        const tail = db.getOutputTail('t-tail');
        expect(tail).toHaveLength(tailLimit);
        expect(tail[0].data).toBe('line 7\n');
        expect(tail[1].data).toBe('line 8\n');
        expect(tail[2].data).toBe('line 9\n');

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('retrieves full history from spool storage beyond in-memory tail', async () => {
      const tailLimit = 2;
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-full-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true, outputTailLimit: tailLimit });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-full'));

        // Append 5 chunks
        for (let i = 0; i < 5; i++) {
          db.appendOutputChunk('t-full', `chunk ${i}\n`);
        }

        // Tail has only last 2
        const tail = db.getOutputTail('t-full');
        expect(tail).toHaveLength(tailLimit);

        // But full replay retrieves all 5 from storage
        const allChunks = db.replayOutputFrom('t-full', 0);
        expect(allChunks).toHaveLength(5);
        expect(allChunks[0].data).toBe('chunk 0\n');
        expect(allChunks[4].data).toBe('chunk 4\n');

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('serves tail from memory without disk access when within limit', async () => {
      const tailLimit = 5;
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-mem-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true, outputTailLimit: tailLimit });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-mem'));

        // Append 3 chunks (within tail limit)
        db.appendOutputChunk('t-mem', 'A\n');
        db.appendOutputChunk('t-mem', 'B\n');
        db.appendOutputChunk('t-mem', 'C\n');

        const tail = db.getOutputTail('t-mem');
        expect(tail).toHaveLength(3);
        expect(tail.map(c => c.data)).toEqual(['A\n', 'B\n', 'C\n']);

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('configures tail limit at adapter creation time', async () => {
      const customLimit = 10;
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-config-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true, outputTailLimit: customLimit });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-config'));

        // Append 15 chunks
        for (let i = 0; i < 15; i++) {
          db.appendOutputChunk('t-config', `x${i}\n`);
        }

        const tail = db.getOutputTail('t-config');
        expect(tail).toHaveLength(customLimit);
        expect(tail[0].data).toBe('x5\n'); // Last 10: x5 through x14

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('defaults tail limit to reasonable value when not specified', async () => {
      const db = await SQLiteAdapter.create(':memory:');
      db.saveWorkflow(testWorkflow);
      db.saveTask('wf-1', makeTask('t-default'));

      // Append many chunks to trigger tail eviction
      for (let i = 0; i < 200; i++) {
        db.appendOutputChunk('t-default', `line ${i}\n`);
      }

      const tail = db.getOutputTail('t-default');
      // Default tail limit should be reasonable (e.g., 100)
      expect(tail.length).toBeLessThanOrEqual(100);
      expect(tail.length).toBeGreaterThan(0);

      db.close();
    });

    it('reads only the configured tail from file-backed spool storage after restart', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-file-tail-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true, outputTailLimit: 4 });
        db1.saveWorkflow(testWorkflow);
        db1.saveTask('wf-1', makeTask('t-file-tail'));
        for (let i = 0; i < 12; i++) {
          db1.appendOutputChunk('t-file-tail', `tail ${i}\n`);
        }
        expect(sqliteScalar(db1, 'SELECT COUNT(*) FROM output_spool')).toBe(0);
        db1.close();

        const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true, outputTailLimit: 4 });
        const tail = db2.getOutputTail('t-file-tail');

        expect(tail.map((chunk) => chunk.data)).toEqual([
          'tail 8\n',
          'tail 9\n',
          'tail 10\n',
          'tail 11\n',
        ]);
        expect(db2.replayOutputFrom('t-file-tail', 0)).toHaveLength(12);

        db2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('output spool: durability and persistence', () => {
    it('persists chunks to disk and survives adapter restart', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-persist-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db1.saveWorkflow(testWorkflow);
        db1.saveTask('wf-1', makeTask('t-persist'));

        db1.appendOutputChunk('t-persist', 'persistent chunk 1\n');
        db1.appendOutputChunk('t-persist', 'persistent chunk 2\n');
        db1.close();

        // Reopen DB
        const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const chunks = db2.replayOutputFrom('t-persist', 0);
        expect(chunks).toHaveLength(2);
        expect(chunks[0].data).toBe('persistent chunk 1\n');
        expect(chunks[1].data).toBe('persistent chunk 2\n');

        db2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('maintains offset consistency across restarts', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-offset-persist-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db1.saveWorkflow(testWorkflow);
        db1.saveTask('wf-1', makeTask('t-offset-persist'));

        db1.appendOutputChunk('t-offset-persist', 'AAA');
        const chunks1 = db1.getOutputChunks('t-offset-persist');
        const lastOffset = chunks1[chunks1.length - 1].offset + Buffer.byteLength(chunks1[chunks1.length - 1].data, 'utf8');
        db1.close();

        // Reopen and append more
        const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db2.appendOutputChunk('t-offset-persist', 'BBB');
        const chunks2 = db2.getOutputChunks('t-offset-persist');

        expect(chunks2).toHaveLength(2);
        expect(chunks2[1].offset).toBe(lastOffset);
        expect(chunks2[1].data).toBe('BBB');

        db2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('keeps workflow metadata queries functional after large output writes', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-output-oom-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true, outputTailLimit: 5 });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-large-output'));

        const payload = 'z'.repeat(256 * 1024);
        for (let i = 0; i < 24; i++) {
          db.appendTaskOutput('t-large-output', payload);
          db.appendOutputChunk('t-large-output', `${i}:${payload}`);
        }

        expect(sqliteScalar(db, 'SELECT COUNT(*) FROM task_output')).toBe(0);
        expect(sqliteScalar(db, 'SELECT COUNT(*) FROM output_spool')).toBe(0);
        expect(db.listWorkflows()).toHaveLength(1);
        expect(db.getOutputTail('t-large-output')).toHaveLength(5);

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Data Integrity Hardening Tests ──────────────────────

  describe('native WAL durability', () => {
    it('does not create legacy .tmp flush files', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-atomic-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);
        db.close();

        expect(existsSync(`${dbPath}.tmp`)).toBe(false);
        expect(existsSync(dbPath)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('persists data correctly through native WAL commits', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-atomic-roundtrip-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db1.saveWorkflow(testWorkflow);
        db1.saveTask('wf-1', makeTask('t-atomic'));
        db1.close();

        const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const tasks = db2.loadTasks('wf-1');
        expect(tasks).toHaveLength(1);
        expect(tasks[0].id).toBe('t-atomic');
        db2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('leaves no stale .tmp files after multiple writes', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-atomic-multi-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t1'));
        db.saveTask('wf-1', makeTask('t2'));
        db.close();

        const files = readdirSync(dir);
        const tmpFiles = files.filter(f => f.endsWith('.tmp'));
        expect(tmpFiles).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('migration error handling', () => {
    it('swallows "duplicate column name" errors (idempotent migration)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-migrate-dup-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        // First open creates schema + runs migrations
        const db1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db1.saveWorkflow(testWorkflow);
        db1.close();

        // Second open re-runs migrations — "duplicate column" errors should be swallowed
        const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const wf = db2.loadWorkflow('wf-1');
        expect(wf).toBeDefined();
        expect(wf!.name).toBe('Test Workflow');
        db2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rethrows unexpected migration errors', async () => {
      // Create an in-memory adapter and spy on db.run to inject a non-duplicate-column error
      const db = await SQLiteAdapter.create(':memory:');

      // The migrations already ran during create(). To test the error path,
      // we access the private db and migrate method via prototype manipulation.
      // Instead, we verify the behavior by checking that the adapter correctly
      // distinguishes error types.
      const origRun = (db as any).db.run.bind((db as any).db);
      let callCount = 0;

      // Spy on db.run: on the first ALTER TABLE call after re-patching, throw a non-duplicate error
      (db as any).db.run = function(sql: string, ...args: any[]) {
        callCount++;
        if (typeof sql === 'string' && sql.includes('ALTER TABLE') && sql.includes('ADD COLUMN')) {
          throw new Error('disk I/O error');
        }
        return origRun(sql, ...args);
      };

      // Calling migrate() should now rethrow the unexpected error
      expect(() => (db as any).migrate()).toThrow('disk I/O error');

      // Restore and clean up
      (db as any).db.run = origRun;
      db.close();
    });

    it('does not rethrow duplicate column name errors during migration', async () => {
      const db = await SQLiteAdapter.create(':memory:');

      const origRun = (db as any).db.run.bind((db as any).db);

      (db as any).db.run = function(sql: string, ...args: any[]) {
        if (typeof sql === 'string' && sql.includes('ALTER TABLE') && sql.includes('ADD COLUMN')) {
          throw new Error('duplicate column name: some_col');
        }
        return origRun(sql, ...args);
      };

      // Should NOT throw — duplicate column errors are expected and swallowed
      expect(() => (db as any).migrate()).not.toThrow();

      (db as any).db.run = origRun;
      db.close();
    });
  });

  describe('deleteAllWorkflows transactional atomicity', () => {
    it('rolls back all deletes if one fails mid-transaction', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.logEvent('t1', 'started');

      // Spy on db.run to fail on the 'DELETE FROM tasks' step
      const origRun = (adapter as any).db.run.bind((adapter as any).db);
      let deleteCount = 0;

      (adapter as any).db.run = function(sql: string, ...args: any[]) {
        if (sql === 'DELETE FROM tasks') {
          deleteCount++;
          throw new Error('simulated disk failure');
        }
        return origRun(sql, ...args);
      };

      // deleteAllWorkflows should throw due to the simulated failure
      expect(() => adapter.deleteAllWorkflows()).toThrow('simulated disk failure');

      // Restore db.run
      (adapter as any).db.run = origRun;

      // Because of ROLLBACK, the data that was deleted before the failure
      // (events, task_output, attempts) should still be present
      expect(adapter.listWorkflows()).toHaveLength(1);
      expect(adapter.loadTasks('wf-1')).toHaveLength(1);
      expect(adapter.getEvents('t1')).toHaveLength(1);
    });

    it('commits all deletes atomically on success', () => {
      adapter.saveWorkflow({
        ...testWorkflow, id: 'wf-1', name: 'First',
        createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
      });
      adapter.saveWorkflow({
        ...testWorkflow, id: 'wf-2', name: 'Second',
        createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z',
      });
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-2', makeTask('t2'));
      adapter.logEvent('t1', 'started');
      adapter.appendTaskOutput('t1', 'output');

      adapter.deleteAllWorkflows();

      // All tables should be empty
      expect(adapter.listWorkflows()).toEqual([]);
      expect(adapter.loadTasks('wf-1')).toEqual([]);
      expect(adapter.loadTasks('wf-2')).toEqual([]);
      expect(adapter.getEvents('t1')).toEqual([]);
      expect(adapter.getTaskOutput('t1')).toBe('');
    });
  });

  describe('deleteConversationsOlderThan dirty flag and persistence', () => {
    it('persists conversation deletes to disk after close', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-conv-dirty-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        // Create DB with an old conversation
        const db1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const old = new Date();
        old.setDate(old.getDate() - 10);

        db1.saveConversation({
          threadTs: 'ts-old',
          channelId: 'C1',
          userId: 'U1',
          extractedPlan: null,
          planSubmitted: false,
          createdAt: old.toISOString(),
          updatedAt: old.toISOString(),
        });
        db1.appendMessage('ts-old', 'user', '"old message"');

        // Also save a recent conversation to verify it survives
        db1.saveConversation({
          threadTs: 'ts-new',
          channelId: 'C2',
          userId: 'U2',
          extractedPlan: null,
          planSubmitted: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        db1.close();

        // Reopen, delete old conversations, close
        const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7);
        const deleted = db2.deleteConversationsOlderThan(cutoff.toISOString());
        expect(deleted).toBe(1);
        db2.close();

        // Reopen and verify the delete was persisted to disk
        const db3 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        expect(db3.loadConversation('ts-old')).toBeUndefined();
        expect(db3.loadMessages('ts-old')).toEqual([]);
        // Recent conversation should survive
        expect(db3.loadConversation('ts-new')).toBeDefined();
        db3.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects deleteConversationsOlderThan on read-only adapter', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-conv-readonly-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const writer = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const old = new Date();
        old.setDate(old.getDate() - 10);
        writer.saveConversation({
          threadTs: 'ts-old',
          channelId: 'C1',
          userId: 'U1',
          extractedPlan: null,
          planSubmitted: false,
          createdAt: old.toISOString(),
          updatedAt: old.toISOString(),
        });
        writer.close();

        const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7);
        expect(() => reader.deleteConversationsOlderThan(cutoff.toISOString())).toThrow(/read-only/i);
        reader.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('marks deletion mutations as dirty for diagnostics', async () => {
      // Use in-memory adapter to verify the dirty flag is set
      // by checking the internal state after deleteConversationsOlderThan
      const old = new Date();
      old.setDate(old.getDate() - 10);

      adapter.saveConversation({
        threadTs: 'ts-old',
        channelId: 'C1',
        userId: 'U1',
        extractedPlan: null,
        planSubmitted: false,
        createdAt: old.toISOString(),
        updatedAt: old.toISOString(),
      });

      // Reset dirty flag to false to verify the mutation path marks it.
      (adapter as any).dirty = false;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      adapter.deleteConversationsOlderThan(cutoff.toISOString());

      expect((adapter as any).dirty).toBe(true);
    });
  });

  describe('workflow mutation intent eviction', () => {
    it('fails queued intents for a workflow before a fence intent id', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveWorkflow({
        ...testWorkflow,
        id: 'wf-2',
        name: 'Second Workflow',
      });

      const olderNormal = adapter.enqueueWorkflowMutationIntent('wf-1', 'headless.exec', [{ args: ['set', 'agent', 'wf-1/task-1', 'codex'] }], 'normal');
      const olderHigh = adapter.enqueueWorkflowMutationIntent('wf-1', 'headless.exec', [{ args: ['approve', 'wf-1/task-1'] }], 'high');
      const fence = adapter.enqueueWorkflowMutationIntent('wf-1', 'headless.exec', [{ args: ['recreate', 'wf-1'] }], 'high');
      const newer = adapter.enqueueWorkflowMutationIntent('wf-1', 'headless.exec', [{ args: ['reject', 'wf-1/task-2'] }], 'normal');
      const otherWorkflow = adapter.enqueueWorkflowMutationIntent('wf-2', 'headless.exec', [{ args: ['retry', 'wf-2'] }], 'normal');

      const evicted = adapter.evictQueuedWorkflowMutationIntentsBefore('wf-1', fence, 'evicted by recreate');
      expect(evicted).toHaveLength(2);
      expect(evicted).toEqual(expect.arrayContaining([olderNormal, olderHigh]));

      const intentsWf1 = adapter.listWorkflowMutationIntents('wf-1');
      const byIdWf1 = new Map(intentsWf1.map((intent) => [intent.id, intent]));
      expect(byIdWf1.get(olderNormal)?.status).toBe('failed');
      expect(byIdWf1.get(olderHigh)?.status).toBe('failed');
      expect(byIdWf1.get(olderNormal)?.error).toContain('evicted by recreate');
      expect(byIdWf1.get(fence)?.status).toBe('queued');
      expect(byIdWf1.get(newer)?.status).toBe('queued');

      const intentsWf2 = adapter.listWorkflowMutationIntents('wf-2');
      expect(intentsWf2.find((intent) => intent.id === otherWorkflow)?.status).toBe('queued');
    });

    it('returns zero when there are no queued intents to evict', () => {
      adapter.saveWorkflow(testWorkflow);
      const fence = adapter.enqueueWorkflowMutationIntent('wf-1', 'headless.exec', [{ args: ['recreate', 'wf-1'] }], 'high');
      expect(adapter.evictQueuedWorkflowMutationIntentsBefore('wf-1', fence)).toEqual([]);
    });
  });

  describe('queryOne / queryAll statement cleanup', () => {
    type PreparedHook = (stmt: any) => void;

    function instrumentPrepare(adapter: SQLiteAdapter, hook: PreparedHook = () => {}): {
      restore: () => void;
      freeCallsFor: (stmt: any) => number;
    } {
      const db = (adapter as any).db;
      const originalPrepare = db.prepare.bind(db);
      const freeCounts = new WeakMap<object, number>();
      db.prepare = (sql: string, ...rest: any[]) => {
        const stmt = originalPrepare(sql, ...rest);
        freeCounts.set(stmt, 0);
        const originalFree = stmt.free.bind(stmt);
        stmt.free = () => {
          freeCounts.set(stmt, (freeCounts.get(stmt) ?? 0) + 1);
          return originalFree();
        };
        hook(stmt);
        return stmt;
      };
      return {
        restore: () => {
          db.prepare = originalPrepare;
        },
        freeCallsFor: (stmt: any) => freeCounts.get(stmt) ?? 0,
      };
    }

    it('frees the prepared statement after a successful queryOne', () => {
      let captured: any;
      const handle = instrumentPrepare(adapter, (stmt) => {
        captured = stmt;
      });
      try {
        const row = (adapter as any).queryOne('SELECT 1 AS x') as Record<string, unknown> | undefined;
        expect(row).toEqual({ x: 1 });
        expect(handle.freeCallsFor(captured)).toBe(1);
      } finally {
        handle.restore();
      }
    });

    it('frees the prepared statement after a successful queryAll', () => {
      let captured: any;
      const handle = instrumentPrepare(adapter, (stmt) => {
        captured = stmt;
      });
      try {
        const rows = (adapter as any).queryAll(
          'SELECT value FROM (SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3) ORDER BY value',
        ) as Array<Record<string, unknown>>;
        expect(rows.map((r) => r.value)).toEqual([1, 2, 3]);
        expect(handle.freeCallsFor(captured)).toBe(1);
      } finally {
        handle.restore();
      }
    });

    it('frees the prepared statement when stmt.get throws inside queryOne', () => {
      let captured: any;
      const handle = instrumentPrepare(adapter, (stmt) => {
        captured = stmt;
        stmt.get = () => {
          throw new Error('simulated OOM during get');
        };
      });
      try {
        expect(() => (adapter as any).queryOne('SELECT 1 AS x')).toThrow('simulated OOM during get');
        expect(handle.freeCallsFor(captured)).toBe(1);
      } finally {
        handle.restore();
      }
    });

    it('frees the prepared statement when stmt.get throws with params inside queryOne', () => {
      let captured: any;
      const handle = instrumentPrepare(adapter, (stmt) => {
        captured = stmt;
        stmt.get = () => {
          throw new Error('simulated OOM during parameterized get');
        };
      });
      try {
        expect(() => (adapter as any).queryOne('SELECT ? AS x', ['v'])).toThrow(
          'simulated OOM during parameterized get',
        );
        expect(handle.freeCallsFor(captured)).toBe(1);
      } finally {
        handle.restore();
      }
    });

    it('frees the prepared statement when stmt.all throws inside queryAll', () => {
      let captured: any;
      const handle = instrumentPrepare(adapter, (stmt) => {
        captured = stmt;
        stmt.all = () => {
          throw new Error('simulated OOM during all');
        };
      });
      try {
        expect(() =>
          (adapter as any).queryAll(
            'SELECT value FROM (SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3) ORDER BY value',
          ),
        ).toThrow(
          'simulated OOM during all',
        );
        expect(handle.freeCallsFor(captured)).toBe(1);
      } finally {
        handle.restore();
      }
    });

    it('frees the prepared statement when stmt.all throws with params inside queryAll', () => {
      let captured: any;
      const handle = instrumentPrepare(adapter, (stmt) => {
        captured = stmt;
        stmt.all = () => {
          throw new Error('simulated OOM during parameterized all');
        };
      });
      try {
        expect(() => (adapter as any).queryAll('SELECT ? AS x', ['v'])).toThrow(
          'simulated OOM during parameterized all',
        );
        expect(handle.freeCallsFor(captured)).toBe(1);
      } finally {
        handle.restore();
      }
    });
  });
});
