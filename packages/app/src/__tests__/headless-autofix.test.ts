import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessAutoFix } from '../headless.js';
import type { ExternalFailureRecoveryLauncher } from '../external-failure-recovery.js';

function makeOrchestrator(workflowByTaskId: Record<string, string | undefined>): any {
  return {
    getTask: (id: string) => {
      const workflowId = workflowByTaskId[id];
      if (!workflowId) return undefined;
      return { config: { workflowId } };
    },
    shouldAutoFix: () => false,
  };
}

describe('wireHeadlessAutoFix (external recovery)', () => {
  it('routes failed deltas to the external recovery launcher with workflow/task context', () => {
    const messageBus = new LocalBus() as MessageBus;
    const launcher = vi.fn<Parameters<ExternalFailureRecoveryLauncher>, ReturnType<ExternalFailureRecoveryLauncher>>(
      () => ({ launched: true }),
    );

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: makeOrchestrator({ 'wf-1/task-1': 'wf-1', 'wf-1/task-2': 'wf-1' }),
        persistence: { logEvent: vi.fn() } as any,
        invokerConfig: {} as any,
        repoRoot: '/repos/example',
      },
      {} as any,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    } as any);

    expect(launcher).toHaveBeenCalledTimes(1);
    const call = launcher.mock.calls[0]?.[0];
    expect(call?.taskId).toBe('wf-1/task-1');
    expect(call?.workflowId).toBe('wf-1');
    expect(call?.repoRoot).toBe('/repos/example');
    expect(typeof call?.dbDir).toBe('string');
  });

  it('does NOT invoke any Fix-with-AI path when a delta fails', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const launcher = vi.fn<Parameters<ExternalFailureRecoveryLauncher>, ReturnType<ExternalFailureRecoveryLauncher>>(
      () => ({ launched: false, reason: 'disabled' }),
    );
    const fixWithAgent = vi.fn();
    const resolveConflict = vi.fn();
    const executeTasks = vi.fn();

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: makeOrchestrator({ 'wf-1/task-1': 'wf-1' }),
        persistence: { logEvent: vi.fn() } as any,
        invokerConfig: {} as any,
        repoRoot: '/repos/example',
      },
      { executeTasks, fixWithAgent, resolveConflict } as any,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    } as any);

    await Promise.resolve();
    expect(fixWithAgent).not.toHaveBeenCalled();
    expect(resolveConflict).not.toHaveBeenCalled();
    expect(executeTasks).not.toHaveBeenCalled();
  });

  it('skips cancellation-style failures without launching', () => {
    const messageBus = new LocalBus() as MessageBus;
    const launcher = vi.fn<Parameters<ExternalFailureRecoveryLauncher>, ReturnType<ExternalFailureRecoveryLauncher>>(
      () => ({ launched: true }),
    );

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: makeOrchestrator({ 'wf-1/task-1': 'wf-1' }),
        persistence: { logEvent: vi.fn() } as any,
        invokerConfig: {} as any,
        repoRoot: '/repos/example',
      },
      {} as any,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed', execution: { error: 'Cancelled by user' } },
    } as any);

    expect(launcher).not.toHaveBeenCalled();
  });

  it('records launcher skip reasons via debug.external-recovery events', () => {
    const messageBus = new LocalBus() as MessageBus;
    const logEvent = vi.fn();
    const launcher = vi.fn<Parameters<ExternalFailureRecoveryLauncher>, ReturnType<ExternalFailureRecoveryLauncher>>(
      () => ({ launched: false, reason: 'cooldown' }),
    );

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: makeOrchestrator({ 'wf-1/task-1': 'wf-1' }),
        persistence: { logEvent } as any,
        invokerConfig: {} as any,
        repoRoot: '/repos/example',
      },
      {} as any,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    } as any);

    expect(launcher).toHaveBeenCalledTimes(1);
    const debugCalls = logEvent.mock.calls.filter((c) => c[1] === 'debug.external-recovery');
    expect(debugCalls.length).toBeGreaterThan(0);
    expect(debugCalls.some((c) => (c[2] as { phase?: string }).phase === 'skip-cooldown')).toBe(true);
    const autoFixCalls = logEvent.mock.calls.filter((c) => c[1] === 'debug.auto-fix');
    expect(autoFixCalls).toHaveLength(0);
  });
});
