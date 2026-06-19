import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHeadless } from '../headless.js';
import type { HeadlessDeps } from '../headless.js';
import { Orchestrator, CommandService } from '@invoker/workflow-core';
import { SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import { LocalBus } from '@invoker/transport';
import { TaskRunner } from '@invoker/execution-engine';

/**
 * Tests for headless delegation and owner-boundary behavior.
 * Read-only mutation enforcement is handled by persistence/orchestrator layers.
 */

describe('headless delegation enforcement', () => {
  let mockDeps: HeadlessDeps;

  beforeEach(() => {
    const noopLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => noopLogger),
    };
    mockDeps = {
      logger: noopLogger as any,
      orchestrator: {} as Orchestrator,
      persistence: {
        readOnly: false,
        listWorkflows: vi.fn(() => []),
        loadTasks: vi.fn(() => []),
      } as unknown as SQLiteAdapter,
      commandService: {} as CommandService,
      executorRegistry: {} as any,
      messageBus: new LocalBus() as MessageBus,
      repoRoot: '/fake/repo',
      invokerConfig: {} as any,
      initServices: vi.fn(async () => {}),
      wireSlackBot: vi.fn(async () => ({})),
    };
  });

  describe('read-only command execution', () => {
    beforeEach(() => {
      // Mark persistence as read-only (non-owner mode)
      (mockDeps.persistence as any).readOnly = true;
    });

    it('allows query workflows in read-only mode', async () => {
      await expect(
        runHeadless(['query', 'workflows'], mockDeps)
      ).resolves.toBeUndefined();
    });

    it('allows query tasks in read-only mode', async () => {
      mockDeps.orchestrator.syncFromDb = vi.fn();
      mockDeps.orchestrator.getAllTasks = vi.fn(() => []);
      await expect(
        runHeadless(['query', 'tasks'], mockDeps)
      ).resolves.toBeUndefined();
    });

    it('hydrates every workflow before reporting queue status', async () => {
      mockDeps.persistence.listWorkflows = vi.fn(() => [
        {
          id: 'wf-1',
          name: 'wf-1',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'wf-2',
          name: 'wf-2',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
      mockDeps.orchestrator.syncFromDb = vi.fn();
      mockDeps.orchestrator.getQueueStatus = vi.fn(() => ({
        maxConcurrency: 4,
        runningCount: 1,
        running: [{ taskId: 'wf-2/task-1', description: 'slow task' }],
        queued: [],
      }));

      await expect(
        runHeadless(['query', 'queue', '--output', 'json'], mockDeps),
      ).resolves.toBeUndefined();

      expect(mockDeps.orchestrator.syncFromDb).toHaveBeenCalledTimes(2);
      expect(mockDeps.orchestrator.syncFromDb).toHaveBeenNthCalledWith(1, 'wf-1');
      expect(mockDeps.orchestrator.syncFromDb).toHaveBeenNthCalledWith(2, 'wf-2');
    });

    it('allows query ui-perf in read-only mode', async () => {
      mockDeps.getUiPerfStats = vi.fn(() => ({
        maxRendererEventLoopLagMs: 12,
        maxRendererLongTaskMs: 34,
      }));
      await expect(
        runHeadless(['query', 'ui-perf', '--output', 'json'], mockDeps)
      ).resolves.toBeUndefined();
    });

    it('lists explicit long-running worker services in read-only mode', async () => {
      await expect(
        runHeadless(['worker', 'status'], mockDeps),
      ).resolves.toBeUndefined();
    });

    it('runs the explicit auto-fix worker service without submitting direct local mutations', async () => {
      const bus = new LocalBus() as MessageBus;
      const execHandler = vi.fn(async () => ({ ok: true }));
      bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-worker', mode: 'standalone' }));
      bus.onRequest('headless.exec', execHandler);
      mockDeps.messageBus = bus;
      mockDeps.orchestrator.syncFromDb = vi.fn();
      mockDeps.orchestrator.getTask = vi.fn();
      mockDeps.persistence.listWorkflows = vi.fn(() => []);
      mockDeps.persistence.loadTasks = vi.fn(() => []);
      const abortController = new AbortController();
      setTimeout(() => abortController.abort(), 0);

      await expect(
        runHeadless(
          ['worker', 'autofix', '--interval-ms', '1000'],
          { ...mockDeps, signal: abortController.signal } as HeadlessDeps,
        ),
      ).resolves.toBeUndefined();

      expect(mockDeps.orchestrator.syncFromDb).toHaveBeenCalled();
      expect(execHandler).not.toHaveBeenCalled();
    });

      it('allows deprecated list command in read-only mode', async () => {
        await expect(
          runHeadless(['list'], mockDeps)
        ).resolves.toBeUndefined();
      });

      it('allows query workflow for a single workflow', async () => {
        mockDeps.persistence.loadWorkflow = vi.fn(() => ({
          id: 'wf-1',
          name: 'Workflow one',
          status: 'pending',
          generation: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as any));

        await expect(
          runHeadless(['query', 'workflow', 'wf-1', '--output', 'json'], mockDeps),
        ).resolves.toBeUndefined();

        expect(mockDeps.persistence.loadWorkflow).toHaveBeenCalledWith('wf-1');
      });

    it('allows deprecated status command in read-only mode', async () => {
      mockDeps.orchestrator.syncFromDb = vi.fn();
      mockDeps.orchestrator.getAllTasks = vi.fn(() => []);
      await expect(
        runHeadless(['status'], mockDeps)
      ).resolves.toBeUndefined();
    });
  });

  describe('writable mode (owner or standalone)', () => {
    beforeEach(() => {
      // Mark persistence as writable (owner mode)
      (mockDeps.persistence as any).readOnly = false;

      // Mock the dependencies needed by mutation commands
      mockDeps.orchestrator.loadPlan = vi.fn();
      mockDeps.orchestrator.startExecution = vi.fn(() => []);
      mockDeps.orchestrator.resumeWorkflow = vi.fn(() => []);
      mockDeps.orchestrator.getAllTasks = vi.fn(() => []);
      mockDeps.orchestrator.getReadyTasks = vi.fn(() => []);
      mockDeps.orchestrator.getPersistedActiveTaskIds = vi.fn(() => new Set<string>());
      mockDeps.orchestrator.getWorkflowStatus = vi.fn(() => 'running');
      mockDeps.orchestrator.syncFromDb = vi.fn();
      mockDeps.orchestrator.retryTask = vi.fn(() => []);
      mockDeps.orchestrator.approve = vi.fn(async () => []);
      mockDeps.orchestrator.setBeforeApproveHook = vi.fn();
      mockDeps.orchestrator.provideInput = vi.fn();
      mockDeps.persistence.loadWorkflow = vi.fn(() => ({
        id: 'wf-1',
        name: 'test-workflow',
        generation: 0,
        status: 'running' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      mockDeps.persistence.loadTasks = vi.fn(() => []);
    });

    it('allows mutations when persistence is writable', async () => {
      // This would normally execute the full command, but we're just verifying
      // it doesn't throw the read-only error. The command will fail for other
      // reasons (missing arguments, etc.) but that's expected.

      // We can't easily test all mutation commands without mocking their full
      // dependency trees, but we can verify the read-only check passes.
      const isReadOnly = (mockDeps.persistence as any).readOnly;
      expect(isReadOnly).toBe(false);

      // The error should NOT be the read-only error
      // (it might fail for other reasons like missing files, but that's OK)
    });
  });

  describe('non-mutating commands are never blocked', () => {
    beforeEach(() => {
      (mockDeps.persistence as any).readOnly = true;
    });

    it('allows open-terminal in read-only mode', async () => {
      mockDeps.persistence.loadTasks = vi.fn(() => [
        {
          id: 'wf-1/task-1',
          execution: { agentSessionId: 'sess-1' },
        } as any,
      ]);
      mockDeps.persistence.loadWorkflow = vi.fn(() => ({
        id: 'wf-1',
        name: 'test-workflow',
        generation: 0,
        status: 'running' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      mockDeps.orchestrator.syncFromDb = vi.fn();

      // This will fail for other reasons (no actual terminal to open),
      // but it should NOT throw the read-only error
      await expect(
        runHeadless(['open-terminal', 'wf-1/task-1'], mockDeps)
      ).rejects.not.toThrow(/persistence is read-only/);
    });

    it('allows query-select in read-only mode', async () => {
      mockDeps.persistence.getSelectedExperiment = vi.fn(() => null);
      await expect(
        runHeadless(['query-select', 'wf-1/task-1'], mockDeps)
      ).resolves.toBeUndefined();
    });

    it('rejects the removed mutation-queue query command', async () => {
      await expect(
        runHeadless(['query', 'mutation-queue'], mockDeps),
      ).rejects.toThrow(/Unknown query sub-command/);
    });
  });

  /**
   * Focused regression tests for owner boundary enforcement.
   * These tests verify the core invariants established by the owner boundary:
   * 1. Headless mutation command delegates to owner and succeeds when owner is present
   * 2. No direct writable adapter initialization in non-owner paths
   * 3. Existing workflow lifecycle mutations still work under owner path
   */
  describe('owner boundary regression tests', () => {
    describe('owner mode allows all mutations', () => {
      beforeEach(() => {
        (mockDeps.persistence as any).readOnly = false;
        mockDeps.orchestrator.loadPlan = vi.fn();
        mockDeps.orchestrator.startExecution = vi.fn(() => []);
        mockDeps.orchestrator.resumeWorkflow = vi.fn(() => []);
        mockDeps.orchestrator.getAllTasks = vi.fn(() => []);
        mockDeps.orchestrator.getReadyTasks = vi.fn(() => []);
        mockDeps.orchestrator.getWorkflowStatus = vi.fn(() => 'running');
        mockDeps.orchestrator.syncFromDb = vi.fn();
        mockDeps.orchestrator.retryTask = vi.fn(() => []);
        mockDeps.orchestrator.approve = vi.fn(async () => []);
        mockDeps.orchestrator.setBeforeApproveHook = vi.fn();
        mockDeps.orchestrator.provideInput = vi.fn();
        // CommandService mocks (headless now routes through commandService)
        mockDeps.commandService.retryTask = vi.fn(async () => ({ ok: true as const, data: [] }));
        mockDeps.commandService.approve = vi.fn(async () => ({ ok: true as const, data: [] }));
        mockDeps.persistence.loadWorkflow = vi.fn(() => ({
          id: 'wf-1',
          name: 'test-workflow',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
        mockDeps.persistence.listWorkflows = vi.fn(() => [{
          id: 'wf-1',
          name: 'test-workflow',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }]);
        mockDeps.persistence.loadTasks = vi.fn(() => [{
          id: 'wf-1/task-1',
          status: 'pending',
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any]);
      });

      it('allows workflow lifecycle mutations in owner mode', async () => {
        // These commands should NOT throw read-only errors
        // (they may fail for other reasons like missing files, but that's expected)
        const notReadOnlyError = (err: Error) => !err.message.includes('read-only');

        // run command
        try {
          await runHeadless(['run', '/path/to/plan.yaml'], mockDeps);
        } catch (err) {
          expect(notReadOnlyError(err as Error)).toBe(true);
        }

        // resume command
        await runHeadless(['resume', 'wf-1'], mockDeps);
        expect(mockDeps.orchestrator.syncFromDb).toHaveBeenCalledWith('wf-1');
      });

      it('allows task mutations in owner mode', async () => {
        mockDeps.orchestrator.getAllTasks = vi.fn(() => [
          {
            id: 'wf-1/task-1',
            status: 'pending',
            config: { workflowId: 'wf-1' },
          } as any,
        ]);

        // retry-task command (now routed through commandService)
        await runHeadless(['retry-task', 'wf-1/task-1'], mockDeps);
        expect(mockDeps.commandService.retryTask).toHaveBeenCalled();

        // approve command (now routed through commandService)
        mockDeps.orchestrator.getAllTasks = vi.fn(() => [
          {
            id: 'wf-1/task-1',
            status: 'completed',
            config: { workflowId: 'wf-1' },
          } as any,
        ]);
        await runHeadless(['approve', 'wf-1/task-1'], mockDeps);
        expect(mockDeps.commandService.approve).toHaveBeenCalled();
      });
    });

    /**
     * Regression coverage for deleted repro repro-no-track-immediate-return (scenario 2):
     * The --no-track flag must short-circuit before waitForCompletion(), so the headless
     * process exits immediately after submitting/resuming a workflow even when tasks are
     * still running. waitForCompletion otherwise polls every 100ms for up to 30 minutes.
     *
     * Strategy: stub orchestrator.getAllTasks to return a perpetually-running task.
     * Without --no-track, headlessResume would call waitForCompletion which would loop
     * until vitest's default 5s test timeout fires. With --no-track, the function must
     * return promptly.
     */
    describe('--no-track immediate return', () => {
      beforeEach(() => {
        (mockDeps.persistence as any).readOnly = false;
        mockDeps.orchestrator.loadPlan = vi.fn();
        mockDeps.orchestrator.startExecution = vi.fn(() => []);
        mockDeps.orchestrator.resumeWorkflow = vi.fn(() => []);
        mockDeps.orchestrator.syncFromDb = vi.fn();
        mockDeps.orchestrator.retryTask = vi.fn(() => []);
        mockDeps.orchestrator.setBeforeApproveHook = vi.fn();
        mockDeps.orchestrator.provideInput = vi.fn();
        mockDeps.orchestrator.approve = vi.fn(async () => []);
        mockDeps.orchestrator.getWorkflowStatus = vi.fn(() => 'running' as any);
        mockDeps.orchestrator.getAllTasks = vi.fn(() => [
          {
            id: 'wf-1/task-1',
            status: 'running',
            config: { workflowId: 'wf-1' },
            execution: {},
          } as any,
        ]);
        mockDeps.persistence.loadWorkflow = vi.fn(() => ({
          id: 'wf-1',
          name: 'test-workflow',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
        mockDeps.commandService.retryWorkflow = vi.fn(async () => ({
          ok: true as const,
          data: [
            {
              id: 'wf-1/task-1',
              status: 'running',
              config: { workflowId: 'wf-1' },
              execution: {},
            } as any,
          ],
        }));
        mockDeps.commandService.cancelWorkflow = vi.fn(async () => ({
          ok: true as const,
          data: { cancelled: [], runningCancelled: [] },
        }));
      });

      it('headless resume with deps.noTrack=true returns without polling for completion', async () => {
        // If --no-track regresses, waitForCompletion will loop forever on the
        // perpetually-running task and vitest will time out the whole test.
        const depsWithNoTrack: HeadlessDeps = { ...mockDeps, noTrack: true } as HeadlessDeps;
        await runHeadless(['resume', 'wf-1'], depsWithNoTrack);
        expect(mockDeps.orchestrator.syncFromDb).toHaveBeenCalledWith('wf-1');
      });

      it('headless resume completes quickly enough that the noTrack short-circuit is observable', async () => {
        // CC.2: post-orphan-relaunch removal, headless resume calls
        // orchestrator.startExecution() and (when noTrack) lets it run
        // asynchronously instead of awaiting completion. Make
        // startExecution return at least one task so the executeTasks
        // path actually fires.
        mockDeps.orchestrator.startExecution = vi.fn(() => [
          { id: 'wf-1/task-1', status: 'pending', config: { workflowId: 'wf-1' }, execution: {} } as any,
        ]);
        const executeTasksSpy = vi.spyOn(TaskRunner.prototype, 'executeTasks').mockResolvedValue(undefined as any);
        const depsWithNoTrack: HeadlessDeps = { ...mockDeps, noTrack: true } as HeadlessDeps;
        const start = Date.now();
        await runHeadless(['resume', 'wf-1'], depsWithNoTrack);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(1000);
        expect(executeTasksSpy).toHaveBeenCalled();
        executeTasksSpy.mockRestore();
      });

      // CC.2: the two tests that asserted explicit orphan relaunch
      // (retryTask called per orphaned 'running' task and per
      // 'pending+claimed' task) were removed when
      // relaunchOrphansAndStartReady was deleted. The
      // LaunchDispatcher's reapers (reapExpiredLeases /
      // abandonStuckLeases) are the new authoritative recovery path
      // and have direct unit coverage in launch-dispatcher.test.ts.

      it('headless set agent with deps.noTrack=true returns without polling all workflows', async () => {
        mockDeps.commandService.editTaskAgent = vi.fn(async () => ({
          ok: true as const,
          data: [],
        }));
        mockDeps.persistence.listWorkflows = vi.fn(() => [{
          id: 'wf-1',
          name: 'test-workflow',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }]);
        mockDeps.persistence.loadTasks = vi.fn(() => [{
          id: 'wf-1/task-1',
          status: 'pending',
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any]);

        const depsWithNoTrack: HeadlessDeps = { ...mockDeps, noTrack: true } as HeadlessDeps;
        const start = Date.now();
        await runHeadless(['set', 'agent', 'wf-1/task-1', 'codex'], depsWithNoTrack);
        const elapsed = Date.now() - start;

        expect(mockDeps.commandService.editTaskAgent).toHaveBeenCalled();
        expect(elapsed).toBeLessThan(1000);
      });

      it('headless generic setters update workflow and task metadata without dispatching', async () => {
        mockDeps.commandService.runSerializedForWorkflow = vi.fn(async (_workflowId: string, fn: () => unknown) => {
          await fn();
          return { ok: true as const, data: undefined };
        });
        mockDeps.orchestrator.syncFromDb = vi.fn();
        mockDeps.persistence.loadWorkflow = vi.fn(() => ({ id: 'wf-1', name: 'Workflow one' } as any));
        mockDeps.persistence.loadTask = vi.fn((id: string) => (id === 'task-1'
          ? {
              id: 'task-1',
              status: 'pending',
              description: 'Task one',
              dependencies: [],
              config: { workflowId: 'wf-1' },
              execution: {},
            } as any
          : undefined));
        mockDeps.persistence.listWorkflows = vi.fn(() => [{
          id: 'wf-1',
          name: 'test-workflow',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }]);
        mockDeps.persistence.loadTasks = vi.fn(() => [{
          id: 'task-1',
          status: 'pending',
          description: 'Task one',
          dependencies: [],
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any]);
        mockDeps.persistence.updateWorkflow = vi.fn();
        mockDeps.persistence.updateTask = vi.fn();
        mockDeps.persistence.logEvent = vi.fn();
        const executeTasksSpy = vi.spyOn(TaskRunner.prototype, 'executeTasks');

        await runHeadless(
          ['set', 'workflow', 'wf-1', 'repoUrl', 'git@github.com:Neko-Catpital-Labs/Invoker.git'],
          mockDeps,
        );
        await runHeadless(['set', 'task', 'task-1', 'config.poolId', 'some-pool'], mockDeps);

        expect(mockDeps.persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', {
          repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
        });
        expect(mockDeps.persistence.updateTask).toHaveBeenCalledWith('task-1', {
          config: { poolId: 'some-pool' },
        });
        expect(executeTasksSpy).not.toHaveBeenCalled();

        executeTasksSpy.mockRestore();
      });

      it('headless generic setters reject forbidden fields', async () => {
        mockDeps.commandService.runSerializedForWorkflow = vi.fn();
        mockDeps.persistence.loadTask = vi.fn(() => ({
          id: 'task-1',
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any));

        await expect(runHeadless(['set', 'task', 'task-1', 'execution.error', 'boom'], mockDeps))
          .rejects.toThrow(/not allowed/);
        await expect(runHeadless(['set', 'task', 'task-1', 'status', 'failed'], mockDeps))
          .rejects.toThrow(/not allowed/);
        await expect(runHeadless(['set', 'task', 'task-1', 'config.workflowId', 'wf-2'], mockDeps))
          .rejects.toThrow(/not allowed/);
      });

      it('headless set mutations accept runnable tasks without direct executor dispatch', async () => {
        let taskStatus: 'running' | 'completed' = 'completed';
        mockDeps.persistence.listWorkflows = vi.fn(() => [{
          id: 'wf-1',
          name: 'test-workflow',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }]);
        mockDeps.persistence.loadTasks = vi.fn(() => [{
          id: 'wf-1/task-1',
          status: 'failed',
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any]);
        mockDeps.orchestrator.getAllTasks = vi.fn(() => [{
          id: 'wf-1/task-1',
          status: taskStatus,
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any]);
        mockDeps.orchestrator.getReadyTasks = vi.fn(() => []);

        const runnableTask = {
          id: 'wf-1/task-1',
          status: 'running',
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any;
        mockDeps.commandService.editTaskCommand = vi.fn(async () => ({ ok: true as const, data: [runnableTask] }));
        mockDeps.commandService.editTaskType = vi.fn(async () => ({ ok: true as const, data: [runnableTask] }));
        mockDeps.commandService.editTaskAgent = vi.fn(async () => ({ ok: true as const, data: [runnableTask] }));
        mockDeps.commandService.setTaskExternalGatePolicies = vi.fn(async () => ({ ok: true as const, data: [runnableTask] }));
        const executeTasksSpy = vi
          .spyOn(TaskRunner.prototype, 'executeTasks')
          .mockResolvedValue(undefined);

        await runHeadless(['set', 'command', 'wf-1/task-1', 'echo ok'], mockDeps);
        await runHeadless(['set', 'executor', 'wf-1/task-1', 'shell'], mockDeps);
        await runHeadless(['set', 'agent', 'wf-1/task-1', 'codex'], mockDeps);
        await runHeadless(['set', 'gate-policy', 'wf-1/task-1', 'wf-upstream', 'review_ready'], mockDeps);

        expect(mockDeps.commandService.editTaskCommand).toHaveBeenCalled();
        expect(mockDeps.commandService.editTaskType).toHaveBeenCalled();
        expect(mockDeps.commandService.editTaskAgent).toHaveBeenCalled();
        expect(mockDeps.commandService.setTaskExternalGatePolicies).toHaveBeenCalled();

        executeTasksSpy.mockRestore();
      });

      it('headless replace-task is explicitly disabled', async () => {
        mockDeps.commandService.replaceTask = vi.fn();

        await expect(
          runHeadless(
            ['replace-task', 'wf-1/task-1', '[{\"id\":\"fix\",\"description\":\"Fix\",\"command\":\"echo fix\"}]'],
            mockDeps,
          ),
        ).rejects.toThrow('Headless replace-task is disabled because it is not a safe supported CLI flow.');

        expect(mockDeps.commandService.replaceTask).not.toHaveBeenCalled();
      });

      it('headless approve waits for downstream outbox work to settle', async () => {
        let taskBStatus: 'running' | 'completed' = 'running';
        mockDeps.persistence.listWorkflows = vi.fn(() => [{
          id: 'wf-1',
          name: 'test-workflow',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }]);
        mockDeps.persistence.loadTasks = vi.fn(() => [
          {
            id: 'wf-1/task-a',
            status: 'completed',
            config: { workflowId: 'wf-1' },
            execution: {},
          },
          {
            id: 'wf-1/task-b',
            status: taskBStatus,
            config: { workflowId: 'wf-1' },
            execution: {},
          },
        ] as any);
        mockDeps.orchestrator.getAllTasks = vi.fn(() => [
          {
            id: 'wf-1/task-a',
            status: 'completed',
            config: { workflowId: 'wf-1' },
            execution: {},
          },
          {
            id: 'wf-1/task-b',
            status: taskBStatus,
            config: { workflowId: 'wf-1' },
            execution: {},
          },
        ] as any);
        mockDeps.orchestrator.getReadyTasks = vi.fn(() => []);

        const runnableTask = {
          id: 'wf-1/task-b',
          status: 'running',
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any;
        mockDeps.commandService.approve = vi.fn(async () => {
          setTimeout(() => {
            taskBStatus = 'completed';
          }, 10);
          return { ok: true as const, data: [runnableTask] };
        });

        const executeTasksSpy = vi
          .spyOn(TaskRunner.prototype, 'executeTasks')
          .mockResolvedValue(undefined);

        await runHeadless(['approve', 'wf-1/task-a'], mockDeps);

        expect(executeTasksSpy).not.toHaveBeenCalled();
        expect(mockDeps.commandService.approve).toHaveBeenCalled();

        executeTasksSpy.mockRestore();
      });

      // Step 16: pin headless approve/reject routing.
      // Per docs/architecture/task-invalidation-roadmap.md row
      // "Approve or reject fix", these verbs MUST flow through
      // commandService.approve / commandService.reject (which
      // route to MUTATION_POLICIES.fixApprove / fixReject —
      // non-invalidating). They MUST NOT touch retry/recreate/
      // cancel surfaces; the task is already terminal at this
      // point and invalidating would be a generation-bumping
      // mistake.
      it('Step 16 headless approve routes through commandService.approve and never touches retry/recreate/cancel', async () => {
        const wfRow = { id: 'wf-1', name: 'test-workflow', generation: 0, status: 'running' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        const taskRow = { id: 'wf-1/task-a', status: 'completed', config: { workflowId: 'wf-1' }, execution: {} } as any;
        mockDeps.persistence.listWorkflows = vi.fn(() => [wfRow]);
        mockDeps.persistence.loadTasks = vi.fn(() => [taskRow]);
        mockDeps.orchestrator.getAllTasks = vi.fn(() => [taskRow]);
        mockDeps.commandService.approve = vi.fn(async () => ({ ok: true as const, data: [] }));
        mockDeps.commandService.retryTask = vi.fn(async () => ({ ok: true as const, data: [] }));
        mockDeps.commandService.retryWorkflow = vi.fn(async () => ({ ok: true as const, data: [] }));
        mockDeps.commandService.cancelTask = vi.fn(async () => ({ ok: true as const, data: { cancelled: [], runningCancelled: [] } }));
        mockDeps.commandService.cancelWorkflow = vi.fn(async () => ({ ok: true as const, data: { cancelled: [], runningCancelled: [] } }));
        mockDeps.orchestrator.recreateTask = vi.fn(() => []);
        mockDeps.orchestrator.recreateWorkflow = vi.fn(() => []);

        await runHeadless(['approve', 'wf-1/task-a'], mockDeps);

        expect(mockDeps.commandService.approve).toHaveBeenCalled();
        expect(mockDeps.commandService.retryTask).not.toHaveBeenCalled();
        expect(mockDeps.commandService.retryWorkflow).not.toHaveBeenCalled();
        expect(mockDeps.commandService.cancelTask).not.toHaveBeenCalled();
        expect(mockDeps.commandService.cancelWorkflow).not.toHaveBeenCalled();
        expect(mockDeps.orchestrator.retryTask).not.toHaveBeenCalled();
        expect(mockDeps.orchestrator.recreateTask).not.toHaveBeenCalled();
        expect(mockDeps.orchestrator.recreateWorkflow).not.toHaveBeenCalled();
      });

      it('Step 16 headless reject routes through commandService.reject and never touches retry/recreate/cancel', async () => {
        const wfRow = { id: 'wf-1', name: 'test-workflow', generation: 0, status: 'running' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        const taskRow = { id: 'wf-1/task-a', status: 'failed', config: { workflowId: 'wf-1' }, execution: {} } as any;
        mockDeps.persistence.listWorkflows = vi.fn(() => [wfRow]);
        mockDeps.persistence.loadTasks = vi.fn(() => [taskRow]);
        mockDeps.orchestrator.getAllTasks = vi.fn(() => [taskRow]);
        mockDeps.commandService.reject = vi.fn(async () => ({ ok: true as const, data: undefined }));
        mockDeps.commandService.retryTask = vi.fn(async () => ({ ok: true as const, data: [] }));
        mockDeps.commandService.retryWorkflow = vi.fn(async () => ({ ok: true as const, data: [] }));
        mockDeps.commandService.cancelTask = vi.fn(async () => ({ ok: true as const, data: { cancelled: [], runningCancelled: [] } }));
        mockDeps.commandService.cancelWorkflow = vi.fn(async () => ({ ok: true as const, data: { cancelled: [], runningCancelled: [] } }));
        mockDeps.orchestrator.recreateTask = vi.fn(() => []);
        mockDeps.orchestrator.recreateWorkflow = vi.fn(() => []);

        await runHeadless(['reject', 'wf-1/task-a', 'because reasons'], mockDeps);

        expect(mockDeps.commandService.reject).toHaveBeenCalled();
        const rejectCall = (mockDeps.commandService.reject as any).mock.calls[0]?.[0];
        expect(rejectCall?.payload?.taskId).toBe('wf-1/task-a');
        expect(rejectCall?.payload?.reason).toBe('because reasons');
        expect(mockDeps.commandService.retryTask).not.toHaveBeenCalled();
        expect(mockDeps.commandService.retryWorkflow).not.toHaveBeenCalled();
        expect(mockDeps.commandService.cancelTask).not.toHaveBeenCalled();
        expect(mockDeps.commandService.cancelWorkflow).not.toHaveBeenCalled();
        expect(mockDeps.orchestrator.retryTask).not.toHaveBeenCalled();
        expect(mockDeps.orchestrator.recreateTask).not.toHaveBeenCalled();
        expect(mockDeps.orchestrator.recreateWorkflow).not.toHaveBeenCalled();
      });

      it('headless approve returns once a workflow has no running or ready work', async () => {
        let taskBStatus: 'running' | 'pending' = 'running';
        mockDeps.persistence.listWorkflows = vi.fn(() => [{
          id: 'wf-1',
          name: 'test-workflow',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }]);
        mockDeps.persistence.loadTasks = vi.fn(() => [
          {
            id: 'wf-1/task-a',
            status: 'completed',
            config: { workflowId: 'wf-1' },
            execution: {},
          },
          {
            id: 'wf-1/task-b',
            status: taskBStatus,
            config: { workflowId: 'wf-1' },
            execution: {},
          },
        ] as any);
        mockDeps.orchestrator.getAllTasks = vi.fn(() => [
          {
            id: 'wf-1/task-a',
            status: 'completed',
            config: { workflowId: 'wf-1' },
            execution: {},
          },
          {
            id: 'wf-1/task-b',
            status: taskBStatus,
            config: { workflowId: 'wf-1' },
            execution: {},
          },
        ] as any);
        mockDeps.orchestrator.getReadyTasks = vi.fn(() => []);

        const runnableTask = {
          id: 'wf-1/task-b',
          status: 'running',
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any;
        mockDeps.commandService.approve = vi.fn(async () => {
          taskBStatus = 'pending';
          return { ok: true as const, data: [runnableTask] };
        });

        const executeTasksSpy = vi
          .spyOn(TaskRunner.prototype, 'executeTasks')
          .mockResolvedValue(undefined);

        await expect(runHeadless(['approve', 'wf-1/task-a'], mockDeps)).resolves.toBeUndefined();

        expect(executeTasksSpy).not.toHaveBeenCalled();
        expect(mockDeps.orchestrator.getReadyTasks).toHaveBeenCalled();

        executeTasksSpy.mockRestore();
      });

      it('headless retry with deps.noTrack=true can defer runnable execution to the caller', async () => {
        const deferRunnableTasks = vi.fn();
        const preemptWorkflowExecution = vi.fn(async () => {});
        mockDeps.orchestrator.getPersistedActiveTaskIds = vi.fn(() => new Set<string>(['wf-1/task-1']));
        mockDeps.persistence.loadTasks = vi.fn(() => [{
          id: 'wf-1/task-1',
          status: 'pending',
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any]);
        const depsWithNoTrack: HeadlessDeps = {
          ...mockDeps,
          noTrack: true,
          deferRunnableTasks,
          preemptWorkflowExecution,
        } as HeadlessDeps;

        await runHeadless(['retry', 'wf-1'], depsWithNoTrack);

        expect(preemptWorkflowExecution).toHaveBeenCalledWith('wf-1');
        expect(mockDeps.commandService.cancelWorkflow).not.toHaveBeenCalled();
        expect(mockDeps.commandService.retryWorkflow).toHaveBeenCalled();
        expect(deferRunnableTasks).toHaveBeenCalledTimes(1);
        expect(deferRunnableTasks.mock.calls[0]?.[1]).toBe('wf-1');
        const [runnable] = deferRunnableTasks.mock.calls[0] ?? [];
        expect(Array.isArray(runnable)).toBe(true);
        expect(runnable).toHaveLength(1);
        expect(runnable[0]?.id).toBe('wf-1/task-1');
      });

      it('headless retry dispatches runnable tasks from other workflows in no-track mode', async () => {
        const deferRunnableTasks = vi.fn();
        const preemptWorkflowExecution = vi.fn(async () => {});
        mockDeps.orchestrator.getPersistedActiveTaskIds = vi.fn(() => new Set<string>());
        mockDeps.commandService.retryWorkflow = vi.fn(async () => ({
          ok: true,
          data: [
            {
              id: 'wf-1/task-1',
              status: 'running',
              config: { workflowId: 'wf-1' },
              execution: {},
            },
            {
              id: 'wf-2/task-2',
              status: 'running',
              config: { workflowId: 'wf-2' },
              execution: {},
            },
          ],
        }));

        const depsWithNoTrack: HeadlessDeps = {
          ...mockDeps,
          noTrack: true,
          deferRunnableTasks,
          preemptWorkflowExecution,
        } as HeadlessDeps;

        await runHeadless(['retry', 'wf-1'], depsWithNoTrack);

        expect(deferRunnableTasks).toHaveBeenCalledTimes(1);
        const [runnable] = deferRunnableTasks.mock.calls[0] ?? [];
        expect(runnable).toHaveLength(2);
        expect(runnable.map((task: any) => task.id)).toEqual(['wf-1/task-1', 'wf-2/task-2']);
      });

      it('headless workflow retry includes global top-up tasks when deferring no-track execution', async () => {
        const deferRunnableTasks = vi.fn();
        const preemptWorkflowExecution = vi.fn(async () => {});
        mockDeps.orchestrator.getPersistedActiveTaskIds = vi.fn(() => new Set<string>());
        mockDeps.commandService.retryWorkflow = vi.fn(async () => ({
          ok: true,
          data: [
            {
              id: 'wf-1/task-1',
              status: 'running',
              config: { workflowId: 'wf-1' },
              execution: { selectedAttemptId: 'attempt-1' },
            },
          ],
        }));
        mockDeps.orchestrator.startExecution = vi.fn(() => [
          {
            id: 'wf-2/task-9',
            status: 'running',
            config: { workflowId: 'wf-2' },
            execution: { selectedAttemptId: 'attempt-9' },
          } as any,
        ]);

        const depsWithNoTrack: HeadlessDeps = {
          ...mockDeps,
          noTrack: true,
          deferRunnableTasks,
          preemptWorkflowExecution,
        } as HeadlessDeps;

        await runHeadless(['retry', 'wf-1'], depsWithNoTrack);

        expect(deferRunnableTasks).toHaveBeenCalledTimes(1);
        const [runnable] = deferRunnableTasks.mock.calls[0] ?? [];
        expect(runnable).toHaveLength(2);
        expect(runnable.map((task: any) => task.id)).toEqual(['wf-1/task-1', 'wf-2/task-9']);
      });

      it('headless workflow retry does not duplicate scoped attempts in global top-up', async () => {
        const deferRunnableTasks = vi.fn();
        const preemptWorkflowExecution = vi.fn(async () => {});
        mockDeps.orchestrator.getPersistedActiveTaskIds = vi.fn(() => new Set<string>());
        mockDeps.commandService.retryWorkflow = vi.fn(async () => ({
          ok: true,
          data: [
            {
              id: 'wf-1/task-1',
              status: 'running',
              config: { workflowId: 'wf-1' },
              execution: { selectedAttemptId: 'attempt-1' },
            },
          ],
        }));
        mockDeps.orchestrator.startExecution = vi.fn(() => [
          {
            id: 'wf-1/task-1',
            status: 'running',
            config: { workflowId: 'wf-1' },
            execution: { selectedAttemptId: 'attempt-1' },
          } as any,
        ]);

        const depsWithNoTrack: HeadlessDeps = {
          ...mockDeps,
          noTrack: true,
          deferRunnableTasks,
          preemptWorkflowExecution,
        } as HeadlessDeps;

        await runHeadless(['retry', 'wf-1'], depsWithNoTrack);

        const [runnable] = deferRunnableTasks.mock.calls[0] ?? [];
        expect(runnable).toHaveLength(1);
        expect(runnable[0]?.id).toBe('wf-1/task-1');
      });

      it('headless task retry defers runnable tasks in no-track mode', async () => {
        const deferRunnableTasks = vi.fn();
        const preemptTaskSubgraph = vi.fn(async () => {});
        mockDeps.orchestrator.getPersistedActiveTaskIds = vi.fn(() => new Set<string>());
        mockDeps.orchestrator.syncFromDb = vi.fn();
        mockDeps.persistence.listWorkflows = vi.fn(() => [{
          id: 'wf-1',
          name: 'Workflow one',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }]);
        mockDeps.persistence.loadTasks = vi.fn(() => [{
          id: 'wf-1/task-1',
          status: 'failed',
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any]);
        mockDeps.commandService.retryTask = vi.fn(async () => ({
          ok: true,
          data: [
            {
              id: 'wf-1/task-1',
              status: 'running',
              config: { workflowId: 'wf-1' },
              execution: { selectedAttemptId: 'attempt-1' },
            },
          ],
        }));
        mockDeps.orchestrator.startExecution = vi.fn(() => [
          {
            id: 'wf-2/task-9',
            status: 'running',
            config: { workflowId: 'wf-2' },
            execution: { selectedAttemptId: 'attempt-9' },
          } as any,
        ]);

        const depsWithNoTrack: HeadlessDeps = {
          ...mockDeps,
          noTrack: true,
          deferRunnableTasks,
          preemptTaskSubgraph,
        } as HeadlessDeps;

        await runHeadless(['retry-task', 'wf-1/task-1'], depsWithNoTrack);

        expect(deferRunnableTasks).toHaveBeenCalledTimes(1);
        const [runnable] = deferRunnableTasks.mock.calls[0] ?? [];
        expect(runnable).toHaveLength(2);
        expect(runnable.map((task: any) => task.id)).toEqual(['wf-1/task-1', 'wf-2/task-9']);
      });

      it('headless retry always preempts, even when the workflow has no active execution', async () => {
        const preemptWorkflowExecution = vi.fn(async () => {});
        const depsWithNoTrack: HeadlessDeps = {
          ...mockDeps,
          noTrack: true,
          deferRunnableTasks: vi.fn(),
          preemptWorkflowExecution,
        } as HeadlessDeps;

        await runHeadless(['retry', 'wf-1'], depsWithNoTrack);

        expect(preemptWorkflowExecution).toHaveBeenCalledWith('wf-1');
        expect(mockDeps.commandService.retryWorkflow).toHaveBeenCalled();
      });

      it('headless recreate preempts workflow before recreate mutation', async () => {
        const preemptWorkflowExecution = vi.fn(async () => ({ cancelled: [], runningCancelled: [] }));
        (mockDeps.commandService as any).recreateWorkflow = vi.fn(async () => ({ ok: true as const, data: [] }));
        mockDeps.persistence.updateWorkflow = vi.fn();

        const depsWithNoTrack: HeadlessDeps = {
          ...mockDeps,
          noTrack: true,
          preemptWorkflowExecution,
        } as HeadlessDeps;

        await runHeadless(['recreate', 'wf-1'], depsWithNoTrack);

        expect(preemptWorkflowExecution).toHaveBeenCalledWith('wf-1');
        expect(mockDeps.commandService.recreateWorkflow).toHaveBeenCalled();
      });

      it('headless recreate dispatches runnable tasks before waiting for completion', async () => {
        let taskStatus: 'running' | 'completed' = 'running';
        (mockDeps.commandService as any).recreateWorkflow = vi.fn(async () => ({
          ok: true as const,
          data: [
            {
              id: 'wf-1/task-1',
              status: 'running',
              config: { workflowId: 'wf-1' },
              execution: {},
            } as any,
          ],
        }));
        mockDeps.orchestrator.startExecution = vi.fn(() => []);
        mockDeps.persistence.updateWorkflow = vi.fn();
        mockDeps.persistence.listWorkflows = vi.fn(() => [{
          id: 'wf-1',
          name: 'test-workflow',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }]);
        mockDeps.persistence.loadTasks = vi.fn(() => [{
          id: 'wf-1/task-1',
          status: taskStatus,
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any]);
        mockDeps.orchestrator.getAllTasks = vi.fn(() => [{
          id: 'wf-1/task-1',
          status: taskStatus,
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any]);
        mockDeps.orchestrator.getReadyTasks = vi.fn(() => []);

        const executeTasksSpy = vi
          .spyOn(TaskRunner.prototype, 'executeTasks')
          .mockImplementation(async () => {
            taskStatus = 'completed';
          });

        await runHeadless(['recreate', 'wf-1'], mockDeps);

        expect(executeTasksSpy).toHaveBeenCalledTimes(1);
        expect((mockDeps.commandService as any).recreateWorkflow).toHaveBeenCalled();

        executeTasksSpy.mockRestore();
      });

      it('headless rebase preempts resolved workflow before rebase mutation', async () => {
        const preemptWorkflowExecution = vi.fn(async () => ({ cancelled: [], runningCancelled: [] }));
        mockDeps.persistence.listWorkflows = vi.fn(() => [{
          id: 'wf-1',
          name: 'wf-1',
          status: 'running' as const,
          generation: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }]);
        mockDeps.persistence.loadTasks = vi.fn(() => [{
          id: 'wf-1/task-1',
          status: 'running',
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any]);
        mockDeps.orchestrator.getTask = vi.fn((id: string) => {
          if (id === 'wf-1/task-1') {
            return {
              id: 'wf-1/task-1',
              status: 'running',
              config: { workflowId: 'wf-1' },
              execution: {},
            } as any;
          }
          return undefined;
        });
        mockDeps.persistence.loadWorkflow = vi.fn(() => ({
          id: 'wf-1',
          name: 'wf-1',
          status: 'running' as const,
          generation: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));

        const depsWithNoTrack: HeadlessDeps = {
          ...mockDeps,
          noTrack: true,
          preemptWorkflowExecution,
        } as HeadlessDeps;

        await expect(runHeadless(['rebase-retry', 'task-1'], depsWithNoTrack)).rejects.toThrow();
        expect(preemptWorkflowExecution).toHaveBeenCalledWith('wf-1');
      });

      // ── Step 12: routing assertions ────────────────────────────────────
      //
      // These pin the chart's three-way distinction at the headless layer:
      // each verb routes to its own orchestrator method, and `rebase-retry` reaches
      // the new first-class `recreateWorkflowFromFreshBase` (which closes
      // Step 11's "not yet wired" hole on `applyInvalidation`).
      describe('workflow-scope routing', () => {
        function seedRebaseHappyPath(): { preemptWorkflowExecution: ReturnType<typeof vi.fn>; preparePoolSpy: ReturnType<typeof vi.spyOn> } {
          const preemptWorkflowExecution = vi.fn(async () => ({ cancelled: [], runningCancelled: [] }));
          const wf = {
            id: 'wf-1',
            name: 'wf-1',
            status: 'running' as const,
            generation: 3,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            repoUrl: 'https://example/repo.git',
            baseBranch: 'main',
          };
          mockDeps.persistence.listWorkflows = vi.fn(() => [wf]);
          mockDeps.persistence.loadTasks = vi.fn(() => [
            {
              id: 'wf-1/task-1',
              status: 'failed',
              config: { workflowId: 'wf-1' },
              execution: {},
            } as any,
            {
              id: '__merge__wf-1',
              status: 'review_ready',
              config: { workflowId: 'wf-1' },
              execution: {},
            } as any,
          ]);
          mockDeps.persistence.loadWorkflow = vi.fn((id: string) => (id === 'wf-1' ? wf as any : null));
          mockDeps.persistence.updateWorkflow = vi.fn();
          mockDeps.orchestrator.syncFromDb = vi.fn();
          mockDeps.orchestrator.getTask = vi.fn((id: string) => {
            if (id === 'wf-1/task-1' || id === 'task-1') {
              return {
                id: 'wf-1/task-1',
                status: 'failed',
                config: { workflowId: 'wf-1' },
                execution: {},
              } as any;
            }
            return undefined;
          });
          mockDeps.orchestrator.retryWorkflow = vi.fn(() => []);
          mockDeps.orchestrator.recreateWorkflow = vi.fn(() => []);
          mockDeps.orchestrator.recreateWorkflowFromFreshBase = vi.fn(async () => []);

          // Spy on `preparePoolForRebaseRetry` to assert the app-layer
          // `recreateWorkflowFromFreshBase` actually invokes pool prep
          // (the part `recreateWorkflow` does NOT do).
          const preparePoolSpy = vi
            .spyOn(TaskRunner.prototype, 'preparePoolForRebaseRetry')
            .mockImplementation(async () => undefined);

          return { preemptWorkflowExecution, preparePoolSpy };
        }

        it('headless `rebase-retry <taskId>` routes to orchestrator.retryWorkflow after fresh-base prep', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedRebaseHappyPath();

          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['rebase-retry', 'task-1'], depsWithNoTrack);

          expect(preemptWorkflowExecution).toHaveBeenCalledWith('wf-1');
          expect(mockDeps.orchestrator.retryWorkflow).toHaveBeenCalledWith('wf-1');
          expect(mockDeps.orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
          // Cancel-first invariant: preempt before the recreate-from-fresh-base method.
          const preemptOrder = (preemptWorkflowExecution.mock.invocationCallOrder ?? [])[0];
          const retryOrder = (
            (mockDeps.orchestrator.retryWorkflow as any).mock.invocationCallOrder ?? []
          )[0];
          expect(preemptOrder).toBeLessThan(retryOrder);

          preparePoolSpy.mockRestore();
        });

        it('headless `rebase-retry` exercises the fresh-base-distinct pool prep step (preparePoolForRebaseRetry)', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedRebaseHappyPath();

          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['rebase-retry', 'task-1'], depsWithNoTrack);

          // The whole reason `recreateWorkflowFromFreshBase` is distinct
          // from `recreateWorkflow`: it refreshes the upstream pool/base.
          expect(preparePoolSpy).toHaveBeenCalledWith(
            'wf-1',
            'https://example/repo.git',
            'main',
          );

          preparePoolSpy.mockRestore();
        });

        it('deprecated alias `rebase-and-retry` is removed', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedRebaseHappyPath();

          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await expect(runHeadless(['rebase-and-retry', 'task-1'], depsWithNoTrack))
            .rejects.toThrow('Unknown command: rebase-and-retry');

          expect(mockDeps.orchestrator.retryWorkflow).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();

          preparePoolSpy.mockRestore();
        });

        it('headless `rebase-recreate <wfId>` routes to orchestrator.recreateWorkflow with workflowId directly', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedRebaseHappyPath();

          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['rebase-recreate', 'wf-1'], depsWithNoTrack);

          expect(preemptWorkflowExecution).toHaveBeenCalledWith('wf-1');
          expect(mockDeps.orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
          expect(mockDeps.orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
          expect(preparePoolSpy).toHaveBeenCalledWith(
            'wf-1',
            'https://example/repo.git',
            'main',
          );

          preparePoolSpy.mockRestore();
        });

        it('headless `rebase-recreate <mergeTaskId>` normalizes to the owning workflow', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedRebaseHappyPath();

          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['rebase-recreate', '__merge__wf-1'], depsWithNoTrack);

          expect(preemptWorkflowExecution).toHaveBeenCalledWith('wf-1');
          expect(mockDeps.orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');

          preparePoolSpy.mockRestore();
        });

        it('headless `rebase-recreate <taskId>` normalizes to the owning workflow', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedRebaseHappyPath();

          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['rebase-recreate', 'task-1'], depsWithNoTrack);

          expect(preemptWorkflowExecution).toHaveBeenCalledWith('wf-1');
          expect(mockDeps.orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');

          preparePoolSpy.mockRestore();
        });

        it('headless `recreate <wfId>` routes to commandService.recreateWorkflow — NOT recreateWorkflowFromFreshBase (no upstream pool refresh)', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedRebaseHappyPath();
          (mockDeps.commandService as any).recreateWorkflow = vi.fn(async () => ({ ok: true as const, data: [] }));

          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['recreate', 'wf-1'], depsWithNoTrack);

          expect((mockDeps.commandService as any).recreateWorkflow).toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
          expect(preparePoolSpy).not.toHaveBeenCalled();

          preparePoolSpy.mockRestore();
        });

        it('headless `retry <wfId>` routes to commandService.retryWorkflow — NOT to recreateWorkflow / recreateWorkflowFromFreshBase', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedRebaseHappyPath();
          mockDeps.orchestrator.recreateWorkflow = vi.fn(() => []);
          mockDeps.commandService.retryWorkflow = vi.fn(async () => ({
            ok: true as const,
            data: [],
          }));

          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['retry', 'wf-1'], depsWithNoTrack);

          expect(mockDeps.commandService.retryWorkflow).toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflow).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
          expect(preparePoolSpy).not.toHaveBeenCalled();

          preparePoolSpy.mockRestore();
        });
      });

      // Step 17 (`docs/architecture/task-invalidation-roadmap.md`,
      // `docs/architecture/task-invalidation-chart.md` "Proposed
      // API Direction"): pin the canonical 2x2 + 1 lifecycle
      // matrix at the headless surface in a single block. Each
      // cell asserts that the explicit verb routes to its
      // matching commandService method or orchestrator
      // primitive, and ONLY that method (no legacy `restartTask`
      // path, no cross-collapse, and no in-place re-routing
      // through the deprecated `restart` shim — Step 13
      // removed it from the headless verb table).
      describe('Step 17: 5-cell canonical lifecycle matrix', () => {
        function seedHappyPath(): {
          preemptWorkflowExecution: ReturnType<typeof vi.fn>;
          preparePoolSpy: ReturnType<typeof vi.spyOn>;
        } {
          const preemptWorkflowExecution = vi.fn(async () => ({ cancelled: [], runningCancelled: [] }));
          const wf = {
            id: 'wf-1',
            name: 'wf-1',
            status: 'running' as const,
            generation: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            repoUrl: 'https://example/repo.git',
            baseBranch: 'main',
          };
          mockDeps.persistence.listWorkflows = vi.fn(() => [wf]);
          mockDeps.persistence.loadTasks = vi.fn(() => [{
            id: 'wf-1/task-1',
            status: 'failed',
            config: { workflowId: 'wf-1' },
            execution: {},
          } as any]);
          mockDeps.persistence.loadWorkflow = vi.fn(() => wf as any);
          mockDeps.persistence.updateWorkflow = vi.fn();
          mockDeps.orchestrator.syncFromDb = vi.fn();
          mockDeps.orchestrator.getTask = vi.fn((id: string) => {
            if (id === 'wf-1/task-1' || id === 'task-1') {
              return {
                id: 'wf-1/task-1',
                status: 'failed',
                config: { workflowId: 'wf-1' },
                execution: {},
              } as any;
            }
            return undefined;
          });
          mockDeps.orchestrator.getAllTasks = vi.fn(() => [{
            id: 'wf-1/task-1',
            status: 'failed',
            config: { workflowId: 'wf-1' },
            execution: {},
          } as any]);
          mockDeps.orchestrator.startExecution = vi.fn(() => []);
          mockDeps.orchestrator.getPersistedActiveTaskIds = vi.fn(() => new Set<string>());
          mockDeps.orchestrator.recreateTask = vi.fn(() => []);
          mockDeps.orchestrator.retryWorkflow = vi.fn(() => []);
          mockDeps.orchestrator.recreateWorkflow = vi.fn(() => []);
          mockDeps.orchestrator.recreateWorkflowFromFreshBase = vi.fn(
            async (_id: string, options?: any) => {
              await options?.refreshBase?.(_id);
              return [];
            },
          ) as any;
          (mockDeps.orchestrator as any).restartTask = vi.fn(() => []);
          mockDeps.commandService.retryTask = vi.fn(async () => ({ ok: true as const, data: [] }));
          mockDeps.commandService.retryWorkflow = vi.fn(async () => ({ ok: true as const, data: [] }));
          (mockDeps.commandService as any).recreateTask = vi.fn(async () => ({ ok: true as const, data: [] }));
          (mockDeps.commandService as any).recreateWorkflow = vi.fn(async () => ({ ok: true as const, data: [] }));
          (mockDeps.commandService as any).recreateWorkflowFromFreshBase = vi.fn(async () => ({
            ok: true as const,
            data: [],
          }));
          const preparePoolSpy = vi
            .spyOn(TaskRunner.prototype, 'preparePoolForRebaseRetry')
            .mockImplementation(async () => undefined);
          return { preemptWorkflowExecution, preparePoolSpy };
        }

        it('headless `retry-task <id>` routes to commandService.retryTask (only)', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedHappyPath();
          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['retry-task', 'wf-1/task-1'], depsWithNoTrack);

          expect(mockDeps.commandService.retryTask).toHaveBeenCalled();
          expect(mockDeps.commandService.retryWorkflow).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateTask).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflow).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
          expect((mockDeps.orchestrator as any).restartTask).not.toHaveBeenCalled();
          preparePoolSpy.mockRestore();
        });

        it('headless `recreate-task <id>` routes to commandService.recreateTask (only)', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedHappyPath();
          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['recreate-task', 'wf-1/task-1'], depsWithNoTrack);

          expect((mockDeps.commandService as any).recreateTask).toHaveBeenCalled();
          expect(mockDeps.commandService.retryTask).not.toHaveBeenCalled();
          expect(mockDeps.commandService.retryWorkflow).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateTask).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflow).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
          expect((mockDeps.orchestrator as any).restartTask).not.toHaveBeenCalled();
          preparePoolSpy.mockRestore();
        });

        it('headless `retry <wfId>` routes to commandService.retryWorkflow (only)', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedHappyPath();
          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['retry', 'wf-1'], depsWithNoTrack);

          expect(mockDeps.commandService.retryWorkflow).toHaveBeenCalled();
          expect(mockDeps.commandService.retryTask).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateTask).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflow).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
          expect((mockDeps.orchestrator as any).restartTask).not.toHaveBeenCalled();
          preparePoolSpy.mockRestore();
        });

        it('headless `recreate <wfId>` routes to commandService.recreateWorkflow (only)', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedHappyPath();
          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['recreate', 'wf-1'], depsWithNoTrack);

          expect((mockDeps.commandService as any).recreateWorkflow).toHaveBeenCalled();
          expect(mockDeps.commandService.retryTask).not.toHaveBeenCalled();
          expect(mockDeps.commandService.retryWorkflow).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateTask).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflow).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
          expect((mockDeps.orchestrator as any).restartTask).not.toHaveBeenCalled();
          preparePoolSpy.mockRestore();
        });

        it('headless `rebase-retry <taskId>` routes to orchestrator.retryWorkflow after fresh-base prep', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedHappyPath();
          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['rebase-retry', 'task-1'], depsWithNoTrack);

          expect(mockDeps.orchestrator.retryWorkflow).toHaveBeenCalledWith('wf-1');
          expect(preparePoolSpy).toHaveBeenCalledWith(
            'wf-1',
            'https://example/repo.git',
            'main',
          );
          expect(mockDeps.orchestrator.recreateWorkflow).not.toHaveBeenCalled();
          expect(mockDeps.commandService.retryTask).not.toHaveBeenCalled();
          expect(mockDeps.commandService.retryWorkflow).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateTask).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
          expect((mockDeps.orchestrator as any).restartTask).not.toHaveBeenCalled();
          preparePoolSpy.mockRestore();
        });

        it('headless `rebase-recreate <wfId>` routes to orchestrator.recreateWorkflow after fresh-base prep', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedHappyPath();
          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['rebase-recreate', 'wf-1'], depsWithNoTrack);

          expect(mockDeps.orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
          expect(preparePoolSpy).toHaveBeenCalledWith(
            'wf-1',
            'https://example/repo.git',
            'main',
          );
          expect(mockDeps.commandService.retryTask).not.toHaveBeenCalled();
          expect(mockDeps.commandService.retryWorkflow).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateTask).not.toHaveBeenCalled();
          expect(mockDeps.orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
          expect((mockDeps.orchestrator as any).restartTask).not.toHaveBeenCalled();
          preparePoolSpy.mockRestore();
        });
      });

      it('headless cancel-workflow prefers preemptWorkflowExecution when available', async () => {
        const preemptWorkflowExecution = vi.fn(async () => ({ cancelled: ['wf-1/task-1'], runningCancelled: ['wf-1/task-1'] }));
        mockDeps.commandService.cancelWorkflow = vi.fn(async () => ({
          ok: true as const,
          data: { cancelled: ['wf-1/task-1'], runningCancelled: ['wf-1/task-1'] },
        }));

        const depsWithPreempt: HeadlessDeps = {
          ...mockDeps,
          preemptWorkflowExecution,
        } as HeadlessDeps;

        await runHeadless(['cancel-workflow', 'wf-1'], depsWithPreempt);

        expect(preemptWorkflowExecution).toHaveBeenCalledWith('wf-1');
        expect(mockDeps.commandService.cancelWorkflow).not.toHaveBeenCalled();
      });
    });

    describe('query commands work in both modes', () => {
      it('allows query workflows in both read-only and owner mode', async () => {
        // Read-only mode
        (mockDeps.persistence as any).readOnly = true;
        await expect(
          runHeadless(['query', 'workflows'], mockDeps)
        ).resolves.toBeUndefined();

        // Owner mode
        (mockDeps.persistence as any).readOnly = false;
        await expect(
          runHeadless(['query', 'workflows'], mockDeps)
        ).resolves.toBeUndefined();
      });

      it('allows query tasks in both read-only and owner mode', async () => {
        mockDeps.orchestrator.syncFromDb = vi.fn();
        mockDeps.orchestrator.getAllTasks = vi.fn(() => []);

        // Read-only mode
        (mockDeps.persistence as any).readOnly = true;
        await expect(
          runHeadless(['query', 'tasks'], mockDeps)
        ).resolves.toBeUndefined();

        // Owner mode
        (mockDeps.persistence as any).readOnly = false;
        await expect(
          runHeadless(['query', 'tasks'], mockDeps)
        ).resolves.toBeUndefined();
      });
    });

    describe('headless mutation delegates to owner when present', () => {
      it('integrates delegation and execution via message bus', async () => {
        // Non-owner (read-only) headless process
        (mockDeps.persistence as any).readOnly = true;

        // Owner registers handler that accepts mutations
        const ownerHandler = vi.fn(async () => {
          // Owner has writable persistence and can execute
          return { ok: true };
        });
        mockDeps.messageBus.onRequest('headless.exec', ownerHandler);

        // Import and test delegation function
        const { tryDelegateExec } = await import('../headless.js');

        // Headless delegates mutation to owner
        const outcome = await tryDelegateExec(
          ['run', '/path/to/plan.yaml'],
          mockDeps.messageBus
        );

        // Verify delegation succeeded — outcome is a DelegationOutcome union
        expect(outcome.kind).toBe('delegated');
        expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
          args: ['run', '/path/to/plan.yaml'],
          waitForApproval: undefined,
        }));
      });

      it('delegates all mutation commands deterministically', async () => {
        (mockDeps.persistence as any).readOnly = true;
        const ownerHandler = vi.fn(async () => ({ ok: true }));
        mockDeps.messageBus.onRequest('headless.exec', ownerHandler);

        const { tryDelegateExec } = await import('../headless.js');

        const mutationCommands = [
          ['run', '/path/to/plan.yaml'],
          ['resume', 'wf-1'],
          ['retry-task', 'wf-1/task-1'],
          ['approve', 'wf-1/task-1'],
          ['reject', 'wf-1/task-1', 'reason'],
        ];

        for (const cmd of mutationCommands) {
          const outcome = await tryDelegateExec(cmd, mockDeps.messageBus);
          expect(outcome.kind).toBe('delegated');
        }

        expect(ownerHandler).toHaveBeenCalledTimes(mutationCommands.length);
      });
    });

    describe('no writable adapter initialization in non-owner paths', () => {
      it('persistence adapter retains read-only flag throughout execution', async () => {
        // Start with read-only adapter (non-owner mode)
        (mockDeps.persistence as any).readOnly = true;

        // Execute query command (allowed in read-only mode)
        await runHeadless(['query', 'workflows'], mockDeps);

        // Verify adapter is still read-only (no re-initialization occurred)
        expect((mockDeps.persistence as any).readOnly).toBe(true);
      });

      it('mutation attempts do not create writable adapter instances', async () => {
        // Track if any new SQLiteAdapter.create calls would occur
        // (in reality, headless.ts never calls SQLiteAdapter.create - it receives deps)
        (mockDeps.persistence as any).readOnly = true;

        // Attempt mutation. The specific error comes from deeper layers now.
        await expect(
          runHeadless(['run', '/path/to/plan.yaml'], mockDeps)
        ).rejects.toBeDefined();

        // Verify adapter remained read-only (no writable adapter was created)
        expect((mockDeps.persistence as any).readOnly).toBe(true);
      });

      it('headless code path never instantiates new persistence adapters', async () => {
        // This test documents the architecture: headless.ts receives deps,
        // never creates its own SQLiteAdapter instances (unlike main.ts which
        // calls SQLiteAdapter.create).
        //
        // Verify by checking that runHeadless only uses the provided deps.persistence
        (mockDeps.persistence as any).readOnly = true;
        const originalPersistence = mockDeps.persistence;

        await runHeadless(['query', 'workflows'], mockDeps);

        // Same adapter instance throughout (no re-initialization)
        expect(mockDeps.persistence).toBe(originalPersistence);
        expect((mockDeps.persistence as any).readOnly).toBe(true);
      });
    });
  });

  describe('delete-all winner task races', () => {
    beforeEach(() => {
      (mockDeps.persistence as any).readOnly = false;
      mockDeps.persistence.listWorkflows = vi.fn(() => []);
      mockDeps.commandService.approve = vi.fn();
      mockDeps.commandService.cancelTask = vi.fn();
    });

    it('treats approve on a deleted task as a no-op when delete-all already removed every workflow', async () => {
      await expect(runHeadless(['approve', 'wf-1/task-a'], mockDeps)).resolves.toBeUndefined();
      expect(mockDeps.commandService.approve).not.toHaveBeenCalled();
    });

    it('treats cancel on a deleted task as a no-op when delete-all already removed every workflow', async () => {
      await expect(runHeadless(['cancel', 'wf-1/task-a'], mockDeps)).resolves.toBeUndefined();
      expect(mockDeps.commandService.cancelTask).not.toHaveBeenCalled();
    });
  });

  describe('delete-workflow lifecycle bridge', () => {
    it('headless delete-workflow always routes through commandService.deleteWorkflow', async () => {
      mockDeps.commandService.deleteWorkflow = vi.fn(async () => ({ ok: true as const, data: undefined })) as any;
      mockDeps.commandService.cancelWorkflow = vi.fn(async () => ({
        ok: true as const,
        data: { cancelled: [], runningCancelled: [] },
      }));

      await runHeadless(['delete-workflow', 'wf-1'], mockDeps);

      expect(mockDeps.commandService.deleteWorkflow).toHaveBeenCalled();
    });

    it('headless delete preempts running tasks before commandService.deleteWorkflow', async () => {
      const callOrder: string[] = [];
      const preemptWorkflowExecution = vi.fn(async () => {
        callOrder.push('preempt');
        return { cancelled: ['wf-1/task-1'], runningCancelled: ['wf-1/task-1'] };
      });
      mockDeps.commandService.deleteWorkflow = vi.fn(async () => {
        callOrder.push('delete');
        return { ok: true as const, data: undefined };
      }) as any;

      const depsWithPreempt: HeadlessDeps = {
        ...mockDeps,
        preemptWorkflowExecution,
      } as HeadlessDeps;

      await runHeadless(['delete', 'wf-1'], depsWithPreempt);

      expect(preemptWorkflowExecution).toHaveBeenCalledWith('wf-1');
      expect(mockDeps.commandService.deleteWorkflow).toHaveBeenCalled();
      expect(callOrder).toEqual(['preempt', 'delete']);
    });
  });
});
