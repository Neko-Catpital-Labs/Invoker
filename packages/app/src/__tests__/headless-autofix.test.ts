import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessAutoFix } from '../headless.js';
import type { InvokerConfig } from '../config.js';
import type { RecoverySpawnFn } from '../external-failure-recovery.js';

interface SpawnCall {
  command: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

function recordingSpawn(): { fn: RecoverySpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const fn: RecoverySpawnFn = (command, options) => {
    calls.push({ command, cwd: options.cwd, env: options.env });
  };
  return { fn, calls };
}

function makeOrchestrator(workflowByTask: Record<string, string | undefined>) {
  return {
    getTask: vi.fn((id: string) => {
      const workflowId = workflowByTask[id];
      if (workflowId === undefined) return undefined;
      return { id, config: { workflowId } } as any;
    }),
    // Defensive: if any caller still reaches for the legacy autofix gate, fail loud.
    shouldAutoFix: vi.fn(() => {
      throw new Error(
        'wireHeadlessAutoFix must not consult orchestrator.shouldAutoFix on failed deltas',
      );
    }),
  };
}

function makePersistence() {
  return { logEvent: vi.fn() } as any;
}

describe('wireHeadlessAutoFix (external failure recovery wiring)', () => {
  it('launches external recovery with task + workflow context when configured', () => {
    const messageBus = new LocalBus() as MessageBus;
    const { fn, calls } = recordingSpawn();
    const invokerConfig: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: '/usr/local/bin/recover.sh --verbose',
        cwd: '/var/lib/invoker',
      },
    };
    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: makeOrchestrator({ 'wf-1/task-1': 'wf-1' }) as any,
        persistence: makePersistence(),
        invokerConfig,
        repoRoot: '/work/repo',
      },
      { spawn: fn, dbDir: '/work/db' },
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('/usr/local/bin/recover.sh --verbose');
    expect(call.cwd).toBe('/var/lib/invoker');
    expect(call.env.INVOKER_FAILED_TASK_ID).toBe('wf-1/task-1');
    expect(call.env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf-1');
    expect(call.env.INVOKER_REPO_ROOT).toBe('/work/repo');
    expect(call.env.INVOKER_DB_DIR).toBe('/work/db');
    expect(call.env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });

  it('does not launch (and does not consult shouldAutoFix) when externalFailureRecovery is unset', () => {
    const messageBus = new LocalBus() as MessageBus;
    const { fn, calls } = recordingSpawn();
    const orchestrator = makeOrchestrator({ 'wf-1/task-1': 'wf-1' });
    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: makePersistence(),
        invokerConfig: {},
        repoRoot: '/work/repo',
      },
      { spawn: fn, dbDir: '/work/db' },
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    expect(calls).toHaveLength(0);
    expect(orchestrator.shouldAutoFix).not.toHaveBeenCalled();
  });

  it('enforces cooldown across consecutive failed deltas', () => {
    const messageBus = new LocalBus() as MessageBus;
    const { fn, calls } = recordingSpawn();
    let nowMs = 1_000_000;
    const invokerConfig: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: '/bin/recover',
        cooldownSeconds: 60,
      },
    };
    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: makeOrchestrator({ 'wf-1/task-1': 'wf-1', 'wf-1/task-2': 'wf-1' }) as any,
        persistence: makePersistence(),
        invokerConfig,
        repoRoot: '/work/repo',
      },
      { spawn: fn, dbDir: '/work/db', now: () => nowMs },
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });
    nowMs = 1_000_000 + 30_000;
    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-2',
      changes: { status: 'failed' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.env.INVOKER_FAILED_TASK_ID).toBe('wf-1/task-1');

    nowMs = 1_000_000 + 60_000;
    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-2',
      changes: { status: 'failed' },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.env.INVOKER_FAILED_TASK_ID).toBe('wf-1/task-2');
  });

  it('ignores non-failed deltas', () => {
    const messageBus = new LocalBus() as MessageBus;
    const { fn, calls } = recordingSpawn();
    const invokerConfig: InvokerConfig = {
      externalFailureRecovery: { enabled: true, command: '/bin/recover' },
    };
    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: makeOrchestrator({ 'wf-1/task-1': 'wf-1' }) as any,
        persistence: makePersistence(),
        invokerConfig,
        repoRoot: '/work/repo',
      },
      { spawn: fn, dbDir: '/work/db' },
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'running' },
    });

    expect(calls).toHaveLength(0);
  });

  it('skips when the failed task is not owned by any known workflow', () => {
    const messageBus = new LocalBus() as MessageBus;
    const { fn, calls } = recordingSpawn();
    const invokerConfig: InvokerConfig = {
      externalFailureRecovery: { enabled: true, command: '/bin/recover' },
    };
    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: makeOrchestrator({}) as any,
        persistence: makePersistence(),
        invokerConfig,
        repoRoot: '/work/repo',
      },
      { spawn: fn, dbDir: '/work/db' },
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-unknown',
      changes: { status: 'failed' },
    });

    expect(calls).toHaveLength(0);
  });
});
