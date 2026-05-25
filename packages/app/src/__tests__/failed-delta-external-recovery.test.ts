import { describe, expect, it, vi } from 'vitest';
import type { TaskDelta } from '@invoker/workflow-core';
import { handleFailedDeltaForExternalRecovery } from '../failed-delta-external-recovery.js';
import {
  ExternalFailureRecoveryLauncher,
  type SpawnFn,
} from '../external-failure-recovery.js';
import type { InvokerConfig } from '../config.js';

function makeFailedDelta(
  taskId: string,
  error?: string,
): TaskDelta {
  return {
    type: 'updated',
    taskId,
    changes: error
      ? { status: 'failed', execution: { error } }
      : { status: 'failed' },
  } as TaskDelta;
}

function makeDeps(overrides: {
  config?: InvokerConfig;
  workflowIdForTask?: string;
  spawnCalls?: Parameters<SpawnFn>[];
  logCalls?: Array<[string, string, unknown]>;
}) {
  const spawnCalls = overrides.spawnCalls ?? [];
  const logCalls = overrides.logCalls ?? [];
  const spawnFn: SpawnFn = (command, args, options) => {
    spawnCalls.push([command, args, options]);
    return { pid: 4242, unref: () => {} };
  };
  const launcher = new ExternalFailureRecoveryLauncher({
    now: () => 1_000,
    spawn: spawnFn,
  });
  return {
    deps: {
      orchestrator: {
        getTask: vi.fn(() =>
          overrides.workflowIdForTask
            ? ({ config: { workflowId: overrides.workflowIdForTask } } as any)
            : undefined,
        ),
      },
      persistence: {
        logEvent: (taskId: string, eventType: string, payload: unknown) => {
          logCalls.push([taskId, eventType, payload]);
        },
      } as any,
      invokerConfig: overrides.config ?? {},
      repoRoot: '/repo/root',
      dbDir: '/db/dir',
      launcher,
      logSource: 'test',
    },
    spawnCalls,
    logCalls,
  };
}

describe('handleFailedDeltaForExternalRecovery', () => {
  it('launches the external recovery helper with INVOKER_* env vars on failed deltas', () => {
    const { deps, spawnCalls } = makeDeps({
      config: {
        externalFailureRecovery: { enabled: true, command: '/opt/recover.sh' },
      },
      workflowIdForTask: 'wf-7',
    });

    const result = handleFailedDeltaForExternalRecovery(
      makeFailedDelta('wf-7/task-a'),
      deps,
    );

    expect(result).toEqual({ launched: true, pid: 4242 });
    expect(spawnCalls).toHaveLength(1);
    const [, , options] = spawnCalls[0]!;
    expect(options.env).toMatchObject({
      INVOKER_FAILED_TASK_ID: 'wf-7/task-a',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-7',
      INVOKER_REPO_ROOT: '/repo/root',
      INVOKER_DB_DIR: '/db/dir',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('does not launch for non-failed deltas', () => {
    const { deps, spawnCalls } = makeDeps({
      config: {
        externalFailureRecovery: { enabled: true, command: '/opt/recover.sh' },
      },
      workflowIdForTask: 'wf-7',
    });

    const result = handleFailedDeltaForExternalRecovery(
      {
        type: 'updated',
        taskId: 'wf-7/task-a',
        changes: { status: 'running' },
      } as TaskDelta,
      deps,
    );

    expect(result).toEqual({ launched: false, reason: 'not-failed-delta' });
    expect(spawnCalls).toHaveLength(0);
  });

  it('skips cancellation failures so manual stops do not retrigger recovery', () => {
    const { deps, spawnCalls, logCalls } = makeDeps({
      config: {
        externalFailureRecovery: { enabled: true, command: '/opt/recover.sh' },
      },
      workflowIdForTask: 'wf-7',
    });

    const result = handleFailedDeltaForExternalRecovery(
      makeFailedDelta('wf-7/task-a', 'Cancelled by user'),
      deps,
    );

    expect(result).toEqual({ launched: false, reason: 'cancellation' });
    expect(spawnCalls).toHaveLength(0);
    expect(logCalls.some(([, eventType]) => eventType === 'debug.external-recovery')).toBe(true);
  });

  it('skips when the failed task has no resolvable workflowId', () => {
    const { deps, spawnCalls } = makeDeps({
      config: {
        externalFailureRecovery: { enabled: true, command: '/opt/recover.sh' },
      },
    });

    const result = handleFailedDeltaForExternalRecovery(
      makeFailedDelta('orphan/task-a'),
      deps,
    );

    expect(result).toEqual({ launched: false, reason: 'no-workflow-id' });
    expect(spawnCalls).toHaveLength(0);
  });

  it('reports the launcher skip reason when externalFailureRecovery is disabled', () => {
    const { deps, spawnCalls, logCalls } = makeDeps({
      config: {},
      workflowIdForTask: 'wf-7',
    });

    const result = handleFailedDeltaForExternalRecovery(
      makeFailedDelta('wf-7/task-a'),
      deps,
    );

    expect(result).toEqual({ launched: false, reason: 'no_config' });
    expect(spawnCalls).toHaveLength(0);
    const launchResultLog = logCalls.find(
      ([, eventType, payload]) =>
        eventType === 'debug.external-recovery'
        && (payload as { phase?: string }).phase === 'launch-result',
    );
    expect(launchResultLog).toBeDefined();
  });

  it('emits debug.external-recovery events instead of debug.auto-fix', () => {
    const { deps, logCalls } = makeDeps({
      config: {
        externalFailureRecovery: { enabled: true, command: '/opt/recover.sh' },
      },
      workflowIdForTask: 'wf-7',
    });

    handleFailedDeltaForExternalRecovery(
      makeFailedDelta('wf-7/task-a'),
      deps,
    );

    expect(logCalls.length).toBeGreaterThan(0);
    expect(logCalls.every(([, eventType]) => eventType === 'debug.external-recovery')).toBe(true);
    expect(logCalls.every(([, eventType]) => eventType !== 'debug.auto-fix')).toBe(true);
  });
});
