import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessExternalRecovery } from '../headless.js';
import {
  ExternalFailureRecoveryLauncher,
  type RecoverySpawnFn,
} from '../external-failure-recovery.js';
import type { InvokerConfig } from '../config.js';

describe('wireHeadlessExternalRecovery', () => {
  it('launches the configured external recovery command on failed deltas instead of invoking autoFixOnFailure', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: Record<string, unknown>;
    }> = [];
    const spawnFn: RecoverySpawnFn = (command, args, options) => {
      calls.push({ command, args, options: options as Record<string, unknown> });
      return { unref: () => {} };
    };
    const launcher = new ExternalFailureRecoveryLauncher({ spawnFn });
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: true, command: '/bin/recover' },
    };
    const logEvent = vi.fn();
    const orchestrator = {
      getTask: (taskId: string) =>
        taskId === 'wf-1/task-1'
          ? { config: { workflowId: 'wf-1' } }
          : undefined,
    };

    wireHeadlessExternalRecovery(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: { logEvent } as any,
      },
      {
        repoRoot: '/repo/root',
        dbDir: '/repo/root/.invoker/db',
        configProvider: () => config,
        launcher,
      },
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('/bin/recover');
    const env = call.options.env as NodeJS.ProcessEnv;
    expect(env.INVOKER_FAILED_TASK_ID).toBe('wf-1/task-1');
    expect(env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf-1');
    expect(env.INVOKER_REPO_ROOT).toBe('/repo/root');
    expect(env.INVOKER_DB_DIR).toBe('/repo/root/.invoker/db');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
    const recoverySkips = logEvent.mock.calls.filter(
      ([, eventType]) => eventType === 'debug.external-recovery',
    );
    expect(recoverySkips).not.toHaveLength(0);
    expect(recoverySkips[0]![2]).toMatchObject({ phase: 'launched', workflowId: 'wf-1' });
  });

  it('emits debug.external-recovery skip when no workflow can be resolved', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const spawnFn = vi.fn();
    const launcher = new ExternalFailureRecoveryLauncher({
      spawnFn: spawnFn as unknown as RecoverySpawnFn,
    });
    const logEvent = vi.fn();
    const orchestrator = { getTask: () => undefined };

    wireHeadlessExternalRecovery(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: { logEvent } as any,
      },
      {
        repoRoot: '/repo/root',
        configProvider: () => ({
          externalFailureRecovery: { enabled: true, command: '/bin/recover' },
        }),
        launcher,
      },
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'orphan',
      changes: { status: 'failed' },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(spawnFn).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      'orphan',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'skip', reason: 'workflow-not-found' }),
    );
  });

  it('does not launch and reports disabled skip when externalFailureRecovery is missing', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const spawnFn = vi.fn();
    const launcher = new ExternalFailureRecoveryLauncher({
      spawnFn: spawnFn as unknown as RecoverySpawnFn,
    });
    const logEvent = vi.fn();
    const orchestrator = {
      getTask: () => ({ config: { workflowId: 'wf-1' } }),
    };

    wireHeadlessExternalRecovery(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: { logEvent } as any,
      },
      {
        repoRoot: '/repo/root',
        configProvider: () => ({}),
        launcher,
      },
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    await Promise.resolve();

    expect(spawnFn).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'skip', reason: 'disabled' }),
    );
  });
});
