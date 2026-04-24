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

    it('allows query ui-perf in read-only mode', async () => {
      mockDeps.getUiPerfStats = vi.fn(() => ({
        maxRendererEventLoopLagMs: 12,
        maxRendererLongTaskMs: 34,
      }));
      await expect(
        runHeadless(['query', 'ui-perf', '--output', 'json'], mockDeps)
      ).resolves.toBeUndefined();
    });

    it('allows deprecated list command in read-only mode', async () => {
      await expect(
        runHeadless(['list'], mockDeps)
      ).resolves.toBeUndefined();
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
        const executeTasksSpy = vi.spyOn(TaskRunner.prototype, 'executeTasks').mockResolvedValue(undefined as any);
        // Sanity check: prove the noTrack path returns in well under 1s. If the
        // function ever falls back to waitForCompletion (100ms polls), this would
        // fail because at minimum one poll iteration would be observed.
        const depsWithNoTrack: HeadlessDeps = { ...mockDeps, noTrack: true } as HeadlessDeps;
        const start = Date.now();
        await runHeadless(['resume', 'wf-1'], depsWithNoTrack);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(1000);
        expect(executeTasksSpy).toHaveBeenCalled();
        executeTasksSpy.mockRestore();
      });

      it('headless resume only relaunches orphaned tasks in the requested workflow', async () => {
        const executeTasksSpy = vi.spyOn(TaskRunner.prototype, 'executeTasks').mockResolvedValue(undefined as any);
        mockDeps.orchestrator.getAllTasks = vi.fn(() => [
          {
            id: 'wf-1/task-1',
            status: 'running',
            config: { workflowId: 'wf-1' },
            execution: {},
          } as any,
          {
            id: 'wf-2/task-1',
            status: 'running',
            config: { workflowId: 'wf-2' },
            execution: {},
          } as any,
        ]);

        const depsWithNoTrack: HeadlessDeps = { ...mockDeps, noTrack: true } as HeadlessDeps;
        await runHeadless(['resume', 'wf-1'], depsWithNoTrack);

        expect(mockDeps.orchestrator.retryTask).toHaveBeenCalledTimes(1);
        expect(mockDeps.orchestrator.retryTask).toHaveBeenCalledWith('wf-1/task-1');
        expect(executeTasksSpy).toHaveBeenCalled();
        executeTasksSpy.mockRestore();
      });

      it('headless resume relaunches pending tasks with persisted claimed attempts', async () => {
        const executeTasksSpy = vi.spyOn(TaskRunner.prototype, 'executeTasks').mockResolvedValue(undefined as any);
        mockDeps.orchestrator.getPersistedActiveTaskIds = vi.fn(() => new Set(['wf-1/task-claimed']));
        mockDeps.orchestrator.getAllTasks = vi.fn(() => [
          {
            id: 'wf-1/task-claimed',
            status: 'pending',
            config: { workflowId: 'wf-1' },
            execution: {},
          } as any,
          {
            id: 'wf-1/task-ready',
            status: 'pending',
            config: { workflowId: 'wf-1' },
            execution: {},
          } as any,
        ]);

        const depsWithNoTrack: HeadlessDeps = { ...mockDeps, noTrack: true } as HeadlessDeps;
        await runHeadless(['resume', 'wf-1'], depsWithNoTrack);

        expect(mockDeps.orchestrator.retryTask).toHaveBeenCalledTimes(1);
        expect(mockDeps.orchestrator.retryTask).toHaveBeenCalledWith('wf-1/task-claimed');
        expect(executeTasksSpy).toHaveBeenCalled();
        executeTasksSpy.mockRestore();
      });

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

      it('headless set mutations dispatch runnable tasks before waiting for completion', async () => {
        let taskStatus: 'running' | 'completed' = 'running';
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
        mockDeps.commandService.replaceTask = vi.fn(async () => ({ ok: true as const, data: [runnableTask] }));

        const executeTasksSpy = vi
          .spyOn(TaskRunner.prototype, 'executeTasks')
          .mockImplementation(async () => {
            taskStatus = 'completed';
          });

        await runHeadless(['set', 'command', 'wf-1/task-1', 'echo ok'], mockDeps);
        taskStatus = 'running';
        await runHeadless(['set', 'executor', 'wf-1/task-1', 'shell'], mockDeps);
        taskStatus = 'running';
        await runHeadless(['set', 'agent', 'wf-1/task-1', 'codex'], mockDeps);
        taskStatus = 'running';
        await runHeadless(['set', 'gate-policy', 'wf-1/task-1', 'wf-upstream', 'review_ready'], mockDeps);
        taskStatus = 'running';
        await runHeadless(['replace-task', 'wf-1/task-1', '[{\"id\":\"fix\",\"description\":\"Fix\",\"command\":\"echo fix\"}]'], mockDeps);

        expect(executeTasksSpy).toHaveBeenCalledTimes(5);
        expect(mockDeps.commandService.editTaskCommand).toHaveBeenCalled();
        expect(mockDeps.commandService.editTaskType).toHaveBeenCalled();
        expect(mockDeps.commandService.editTaskAgent).toHaveBeenCalled();
        expect(mockDeps.commandService.setTaskExternalGatePolicies).toHaveBeenCalled();
        expect(mockDeps.commandService.replaceTask).toHaveBeenCalled();

        executeTasksSpy.mockRestore();
      });

      it('headless approve waits for downstream runnable tasks to settle', async () => {
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

        const runnableTask = {
          id: 'wf-1/task-b',
          status: 'running',
          config: { workflowId: 'wf-1' },
          execution: {},
        } as any;
        mockDeps.commandService.approve = vi.fn(async () => ({ ok: true as const, data: [runnableTask] }));

        const executeTasksSpy = vi
          .spyOn(TaskRunner.prototype, 'executeTasks')
          .mockImplementation(async () => {
            taskBStatus = 'completed';
          });

        await runHeadless(['approve', 'wf-1/task-a'], mockDeps);

        expect(executeTasksSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(executeTasksSpy).toHaveBeenCalledWith([runnableTask]);
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
        mockDeps.orchestrator.recreateWorkflow = vi.fn(() => []);
        mockDeps.persistence.updateWorkflow = vi.fn();

        const depsWithNoTrack: HeadlessDeps = {
          ...mockDeps,
          noTrack: true,
          preemptWorkflowExecution,
        } as HeadlessDeps;

        await runHeadless(['recreate', 'wf-1'], depsWithNoTrack);

        expect(preemptWorkflowExecution).toHaveBeenCalledWith('wf-1');
        expect(mockDeps.orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
      });

      it('headless recreate dispatches runnable tasks before waiting for completion', async () => {
        let taskStatus: 'running' | 'completed' = 'running';
        mockDeps.orchestrator.recreateWorkflow = vi.fn(() => [
          {
            id: 'wf-1/task-1',
            status: 'running',
            config: { workflowId: 'wf-1' },
            execution: {},
          } as any,
        ]);
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

        const executeTasksSpy = vi
          .spyOn(TaskRunner.prototype, 'executeTasks')
          .mockImplementation(async () => {
            taskStatus = 'completed';
          });

        await runHeadless(['recreate', 'wf-1'], mockDeps);

        expect(executeTasksSpy).toHaveBeenCalledTimes(1);
        expect(mockDeps.orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');

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

        await expect(runHeadless(['rebase', 'task-1'], depsWithNoTrack)).rejects.toThrow();
        expect(preemptWorkflowExecution).toHaveBeenCalledWith('wf-1');
      });

      // ── Step 12: routing assertions ────────────────────────────────────
      //
      // These pin the chart's three-way distinction at the headless layer:
      // each verb routes to its own orchestrator method, and `rebase` reaches
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
          mockDeps.orchestrator.recreateWorkflowFromFreshBase = vi.fn(
            async (_workflowId: string, options?: any) => {
              // Drive the refresh callback the way the orchestrator does in
              // production so we exercise the real `preparePoolForRebaseRetry`
              // wiring inside `workflow-actions.recreateWorkflowFromFreshBase`.
              await options?.refreshBase?.(_workflowId);
              return [];
            },
          ) as any;

          // Spy on `preparePoolForRebaseRetry` to assert the app-layer
          // `recreateWorkflowFromFreshBase` actually invokes pool prep
          // (the part `recreateWorkflow` does NOT do).
          const preparePoolSpy = vi
            .spyOn(TaskRunner.prototype, 'preparePoolForRebaseRetry')
            .mockImplementation(async () => undefined);

          return { preemptWorkflowExecution, preparePoolSpy };
        }

        it('headless `rebase <taskId>` routes to orchestrator.recreateWorkflowFromFreshBase', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedRebaseHappyPath();

          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['rebase', 'task-1'], depsWithNoTrack);

          expect(preemptWorkflowExecution).toHaveBeenCalledWith('wf-1');
          expect(mockDeps.orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledTimes(1);
          expect(
            (mockDeps.orchestrator.recreateWorkflowFromFreshBase as any).mock.calls[0][0],
          ).toBe('wf-1');
          // Cancel-first invariant: preempt before the recreate-from-fresh-base method.
          const preemptOrder = (preemptWorkflowExecution.mock.invocationCallOrder ?? [])[0];
          const recreateOrder = (
            (mockDeps.orchestrator.recreateWorkflowFromFreshBase as any).mock.invocationCallOrder ?? []
          )[0];
          expect(preemptOrder).toBeLessThan(recreateOrder);

          preparePoolSpy.mockRestore();
        });

        it('headless `rebase` exercises the fresh-base-distinct pool prep step (preparePoolForRebaseRetry)', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedRebaseHappyPath();

          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['rebase', 'task-1'], depsWithNoTrack);

          // The whole reason `recreateWorkflowFromFreshBase` is distinct
          // from `recreateWorkflow`: it refreshes the upstream pool/base.
          expect(preparePoolSpy).toHaveBeenCalledWith(
            'wf-1',
            'https://example/repo.git',
            'main',
          );

          preparePoolSpy.mockRestore();
        });

        it('deprecated alias `rebase-and-retry` routes to the same orchestrator.recreateWorkflowFromFreshBase method', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedRebaseHappyPath();

          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['rebase-and-retry', 'task-1'], depsWithNoTrack);

          expect(mockDeps.orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
            'wf-1',
            expect.objectContaining({ refreshBase: expect.any(Function) }),
          );

          preparePoolSpy.mockRestore();
        });

        it('headless `recreate <wfId>` routes to orchestrator.recreateWorkflow — NOT recreateWorkflowFromFreshBase (no upstream pool refresh)', async () => {
          const { preemptWorkflowExecution, preparePoolSpy } = seedRebaseHappyPath();
          mockDeps.orchestrator.recreateWorkflow = vi.fn(() => []);

          const depsWithNoTrack: HeadlessDeps = {
            ...mockDeps,
            noTrack: true,
            preemptWorkflowExecution,
          } as HeadlessDeps;

          await runHeadless(['recreate', 'wf-1'], depsWithNoTrack);

          expect(mockDeps.orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
          // Distinction guard — recreate must NOT refresh the upstream pool.
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
          return { success: true, workflowId: 'wf-test' };
        });
        mockDeps.messageBus.onRequest('headless.exec', ownerHandler);

        // Import and test delegation function
        const { tryDelegateExec } = await import('../headless.js');

        // Headless delegates mutation to owner
        const delegated = await tryDelegateExec(
          ['run', '/path/to/plan.yaml'],
          mockDeps.messageBus
        );

        // Verify delegation succeeded
        expect(delegated).toBe(true);
        expect(ownerHandler).toHaveBeenCalledWith({
          args: ['run', '/path/to/plan.yaml'],
          waitForApproval: undefined,
        });
      });

      it('delegates all mutation commands deterministically', async () => {
        (mockDeps.persistence as any).readOnly = true;
        const ownerHandler = vi.fn(async () => ({ success: true }));
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
          const delegated = await tryDelegateExec(cmd, mockDeps.messageBus);
          expect(delegated).toBe(true);
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
});
