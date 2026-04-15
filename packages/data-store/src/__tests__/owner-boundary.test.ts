import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';

/**
 * Regression tests for owner-boundary enforcement.
 *
 * These tests ensure that the owner boundary mechanism prevents
 * non-owner processes from mutating the database, replacing the
 * old lock-file and stale-write retry/CAS machinery.
 */
describe('owner boundary enforcement', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'owner-boundary-test-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const testWorkflow: Workflow = {
    id: 'wf-boundary-test',
    name: 'Boundary Test Workflow',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  describe('non-owner mutation attempt is rejected deterministically', () => {
    it('rejects writable initialization without ownerCapability flag', async () => {
      // Attempt to create writable adapter without ownerCapability
      await expect(
        SQLiteAdapter.create(dbPath)
      ).rejects.toThrow(/owner capability/i);
    });

    it('rejects explicit writable initialization without ownerCapability flag', async () => {
      await expect(
        SQLiteAdapter.create(dbPath, { readOnly: false })
      ).rejects.toThrow(/owner capability/i);
    });

    it('blocks mutation attempts when opened in read-only mode', async () => {
      // Create DB with owner capability
      const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      owner.saveWorkflow(testWorkflow);
      owner.close();

      // Open in read-only mode
      const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });

      // Verify mutations are blocked
      expect(() => reader.saveWorkflow({ ...testWorkflow, status: 'completed' }))
        .toThrow(/read-only/i);
      expect(() => reader.updateWorkflow('wf-boundary-test', { status: 'completed' }))
        .toThrow(/read-only/i);
      expect(() => reader.deleteWorkflow('wf-boundary-test'))
        .toThrow(/read-only/i);

      reader.close();
    });

    it('allows read operations in read-only mode', async () => {
      // Create DB with owner capability and add data
      const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      owner.saveWorkflow(testWorkflow);
      owner.close();

      // Open in read-only mode
      const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });

      // Verify read operations work
      const workflow = reader.loadWorkflow('wf-boundary-test');
      expect(workflow).toBeDefined();
      expect(workflow!.name).toBe('Boundary Test Workflow');

      const workflows = reader.listWorkflows();
      expect(workflows).toHaveLength(1);

      reader.close();
    });
  });

  describe('no direct writable adapter initialization in non-owner paths', () => {
    it('owner process can create writable adapter with ownerCapability=true', async () => {
      const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

      // Verify it's writable
      expect(() => adapter.saveWorkflow(testWorkflow)).not.toThrow();

      const loaded = adapter.loadWorkflow('wf-boundary-test');
      expect(loaded).toBeDefined();
      expect(loaded!.name).toBe('Boundary Test Workflow');

      adapter.close();
    });

    it('non-owner process can create read-only adapter', async () => {
      // Create DB with owner first
      const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      owner.saveWorkflow(testWorkflow);
      owner.close();

      // Non-owner opens read-only
      const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });

      // Verify it's readable
      const workflow = reader.loadWorkflow('wf-boundary-test');
      expect(workflow).toBeDefined();

      reader.close();
    });

    it('in-memory databases bypass owner check', async () => {
      // In-memory DBs bypass owner check (no persistent state to guard)
      const adapter = await SQLiteAdapter.create(':memory:');

      // Verify it's writable even without ownerCapability
      expect(() => adapter.saveWorkflow(testWorkflow)).not.toThrow();

      adapter.close();
    });
  });

  describe('read-only mode does not modify database file', () => {
    it('does not rewrite db file when closed without writes', async () => {
      const writer = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      writer.saveWorkflow(testWorkflow);
      writer.close();

      const { mtimeMs: beforeMtime } = await import('node:fs').then(fs =>
        fs.promises.stat(dbPath)
      );

      // Wait to ensure any write would change mtime
      await new Promise(resolve => setTimeout(resolve, 20));

      const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
      reader.loadWorkflow('wf-boundary-test');
      reader.close();

      const { mtimeMs: afterMtime } = await import('node:fs').then(fs =>
        fs.promises.stat(dbPath)
      );

      expect(afterMtime).toBe(beforeMtime);
    });
  });

  describe('mutation isolation', () => {
    it('owner can mutate while reader holds read-only connection', async () => {
      // Create initial state
      const owner1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      owner1.saveWorkflow(testWorkflow);
      owner1.close();

      // Reader opens read-only
      const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
      const before = reader.loadWorkflow('wf-boundary-test');
      expect(before!.status).toBe('running');

      // Owner process reopens and mutates
      const owner2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      owner2.updateWorkflow('wf-boundary-test', { status: 'completed' });
      owner2.close();

      // Reader sees stale data (expected - SQLite isolation)
      const stillStale = reader.loadWorkflow('wf-boundary-test');
      expect(stillStale!.status).toBe('running');

      reader.close();

      // New reader sees updated data
      const reader2 = await SQLiteAdapter.create(dbPath, { readOnly: true });
      const updated = reader2.loadWorkflow('wf-boundary-test');
      expect(updated!.status).toBe('completed');
      reader2.close();
    });

    it('reproduces last-write-wins when two writable adapters bypass owner boundary', async () => {
      // This is the historical failure mode that justified lock/CAS work:
      // two writable sql.js handles each hold independent in-memory state and
      // whichever write reaches disk last can overwrite the other process' state.
      const writerA = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      const writerB = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

      writerA.saveWorkflow({
        id: 'wf-a',
        name: 'Workflow A',
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      writerB.saveWorkflow({
        id: 'wf-b',
        name: 'Workflow B',
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Immediate file-backed flushes make the second write visible immediately.
      // The point of the regression is that bypassing the owner boundary still
      // produces non-serializable last-write-wins behavior.
      writerB.close();
      writerA.close();

      const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
      const workflows = reader.listWorkflows();
      reader.close();

      expect(workflows.map((w) => w.id).sort()).toEqual(['wf-b']);
    });
  });

  describe('existing workflow lifecycle mutations succeed under owner path', () => {
    it('owner can perform full workflow CRUD lifecycle', async () => {
      const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

      // Create
      owner.saveWorkflow(testWorkflow);
      let loaded = owner.loadWorkflow('wf-boundary-test');
      expect(loaded).toBeDefined();
      expect(loaded!.status).toBe('running');

      // Update
      owner.updateWorkflow('wf-boundary-test', { status: 'completed' });
      loaded = owner.loadWorkflow('wf-boundary-test');
      expect(loaded!.status).toBe('completed');

      // List
      const workflows = owner.listWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].id).toBe('wf-boundary-test');

      // Delete
      owner.deleteWorkflow('wf-boundary-test');
      loaded = owner.loadWorkflow('wf-boundary-test');
      expect(loaded).toBeUndefined();
      expect(owner.listWorkflows()).toHaveLength(0);

      owner.close();
    });

    it('owner can perform task mutations', async () => {
      const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

      // Save workflow first
      owner.saveWorkflow(testWorkflow);

      // Create task (using same structure as orchestrator tests)
      const testTask = {
        id: 'task-1',
        description: 'Test Task',
        status: 'pending' as const,
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: 'wf-boundary-test', command: 'echo test' },
        execution: {},
      };

      owner.saveTask('wf-boundary-test', testTask);
      let tasks = owner.loadTasks('wf-boundary-test');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('task-1');

      // Update task
      owner.updateTask('task-1', { status: 'running' });
      tasks = owner.loadTasks('wf-boundary-test');
      expect(tasks[0].status).toBe('running');

      // Delete all tasks
      owner.deleteAllTasks('wf-boundary-test');
      tasks = owner.loadTasks('wf-boundary-test');
      expect(tasks).toHaveLength(0);

      owner.close();
    });

    it('owner can write events and task output', async () => {
      const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

      // Create workflow and task first (events have FK to tasks)
      owner.saveWorkflow(testWorkflow);
      const testTask = {
        id: 'task-1',
        description: 'Test Task',
        status: 'pending' as const,
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: 'wf-boundary-test', command: 'echo test' },
        execution: {},
      };
      owner.saveTask('wf-boundary-test', testTask);

      // Log event
      owner.logEvent('task-1', 'started', { timestamp: Date.now() });
      const events = owner.getEvents('task-1');
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('started');

      // Append task output
      owner.appendTaskOutput('task-1', 'line 1\n');
      owner.appendTaskOutput('task-1', 'line 2\n');
      const output = owner.getTaskOutput('task-1');
      expect(output).toBe('line 1\nline 2\n');

      owner.close();
    });

    it('owner can manage generation increments', async () => {
      const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

      // Save workflow with initial generation
      owner.saveWorkflow({ ...testWorkflow, generation: 0 });

      // Increment generation
      owner.updateWorkflow('wf-boundary-test', { generation: 1 });
      const loaded = owner.loadWorkflow('wf-boundary-test');
      expect(loaded!.generation).toBe(1);

      owner.close();
    });
  });
});
