import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessExternalRecovery } from '../headless.js';
import {
  ExternalFailureRecoveryLauncher,
  type SpawnFn,
} from '../external-failure-recovery.js';
import type { InvokerConfig } from '../config.js';

describe('wireHeadlessExternalRecovery', () => {
  it('launches the configured external recovery helper on failed deltas instead of invoking auto-fix', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const spawnCalls: Parameters<SpawnFn>[] = [];
    const spawnFn: SpawnFn = (command, args, options) => {
      spawnCalls.push([command, args, options]);
      return { pid: 99, unref: () => {} };
    };
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 1_000,
      spawn: spawnFn,
    });
    const invokerConfig: InvokerConfig = {
      externalFailureRecovery: { enabled: true, command: '/opt/recover.sh' },
    };
    const persistedEvents: Array<{ taskId: string; eventType: string; payload: unknown }> = [];
    const orchestrator = {
      getTask: vi.fn((taskId: string) =>
        taskId === 'wf-1/task-1'
          ? { config: { workflowId: 'wf-1' } }
          : undefined,
      ),
    };

    wireHeadlessExternalRecovery(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: {
          logEvent: (taskId: string, eventType: string, payload: unknown) => {
            persistedEvents.push({ taskId, eventType, payload });
          },
        } as any,
        invokerConfig,
        repoRoot: '/repo/root',
        logger: undefined,
      },
      launcher,
      '/db/dir',
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });
    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-2',
      changes: { status: 'failed' },
    });

    await Promise.resolve();

    expect(spawnCalls).toHaveLength(1);
    const [command, args, options] = spawnCalls[0]!;
    expect(command).toBe('/opt/recover.sh');
    expect(args).toEqual([]);
    expect(options.env).toMatchObject({
      INVOKER_FAILED_TASK_ID: 'wf-1/task-1',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-1',
      INVOKER_REPO_ROOT: '/repo/root',
      INVOKER_DB_DIR: '/db/dir',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });

    expect(persistedEvents.every((event) => event.eventType === 'debug.external-recovery')).toBe(true);
    expect(persistedEvents.some((event) => event.eventType === 'debug.auto-fix')).toBe(false);
  });

  it('does not launch when externalFailureRecovery is disabled', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const spawnCalls: Parameters<SpawnFn>[] = [];
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 0,
      spawn: ((cmd, args, opts) => {
        spawnCalls.push([cmd, args, opts]);
        return { pid: 1, unref: () => {} };
      }) as SpawnFn,
    });

    wireHeadlessExternalRecovery(
      {
        messageBus,
        orchestrator: { getTask: () => ({ config: { workflowId: 'wf-1' } }) } as any,
        persistence: { logEvent: () => {} } as any,
        invokerConfig: {},
        repoRoot: '/repo/root',
        logger: undefined,
      },
      launcher,
      '/db/dir',
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    await Promise.resolve();
    expect(spawnCalls).toHaveLength(0);
  });

  it('skips cancellation failures so manual stops do not trigger recovery', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const spawnCalls: Parameters<SpawnFn>[] = [];
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 0,
      spawn: ((cmd, args, opts) => {
        spawnCalls.push([cmd, args, opts]);
        return { pid: 1, unref: () => {} };
      }) as SpawnFn,
    });

    wireHeadlessExternalRecovery(
      {
        messageBus,
        orchestrator: { getTask: () => ({ config: { workflowId: 'wf-1' } }) } as any,
        persistence: { logEvent: () => {} } as any,
        invokerConfig: {
          externalFailureRecovery: { enabled: true, command: '/opt/recover.sh' },
        },
        repoRoot: '/repo/root',
        logger: undefined,
      },
      launcher,
      '/db/dir',
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: {
        status: 'failed',
        execution: { error: 'Cancelled by user' },
      },
    });

    await Promise.resolve();
    expect(spawnCalls).toHaveLength(0);
  });
});
