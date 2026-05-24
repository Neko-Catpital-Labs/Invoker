import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessAutoFix } from '../headless.js';

describe('wireHeadlessAutoFix', () => {
  it('routes failed deltas to external recovery instead of automatic Fix with AI', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const shouldAutoFix = vi.fn(() => true);
    const invokeRecovery = vi.fn();
    const onError = vi.fn();

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: {
          shouldAutoFix,
          getTask: () => ({ status: 'failed', config: { workflowId: 'wf-1' } }),
        } as any,
        persistence: { logEvent: vi.fn() } as any,
        repoRoot: '/repos/example',
      },
      {} as any,
      invokeRecovery,
      onError,
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

    // shouldAutoFix is intentionally not consulted — external recovery is the
    // single failure pathway and recovery decisions belong to the operator script.
    expect(shouldAutoFix).not.toHaveBeenCalled();
    expect(invokeRecovery).toHaveBeenCalledTimes(2);
    expect(invokeRecovery).toHaveBeenNthCalledWith(1, 'wf-1/task-1');
    expect(invokeRecovery).toHaveBeenNthCalledWith(2, 'wf-1/task-2');
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not call external recovery for non-failed deltas', () => {
    const messageBus = new LocalBus() as MessageBus;
    const invokeRecovery = vi.fn();

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: { shouldAutoFix: () => true, getTask: () => undefined } as any,
        persistence: { logEvent: vi.fn() } as any,
        repoRoot: '/repos/example',
      },
      {} as any,
      invokeRecovery,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'running' },
    });
    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-2',
      changes: { status: 'completed' },
    });

    expect(invokeRecovery).not.toHaveBeenCalled();
  });

  it('forwards recovery errors to onError without crashing the subscription', () => {
    const messageBus = new LocalBus() as MessageBus;
    const onError = vi.fn();
    const boom = new Error('spawn failed');
    const invokeRecovery = vi.fn(() => {
      throw boom;
    });

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: { shouldAutoFix: () => true, getTask: () => ({ status: 'failed' }) } as any,
        persistence: { logEvent: vi.fn() } as any,
        repoRoot: '/repos/example',
      },
      {} as any,
      invokeRecovery,
      onError,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('wf-1/task-1', boom);
  });

  it('default invokeRecovery spawns the configured external command with INVOKER_* env vars', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'invoker-headless-recovery-'));
    const previousConfig = process.env.INVOKER_REPO_CONFIG_PATH;
    try {
      const markerPath = join(tmpDir, 'marker.env');
      const configPath = join(tmpDir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        externalFailureRecovery: {
          enabled: true,
          command: `env | grep -E '^INVOKER_(FAILED_|REPO_ROOT|RECOVERY_REASON)' | sort > '${markerPath}'`,
        },
      }));
      process.env.INVOKER_REPO_CONFIG_PATH = configPath;

      const messageBus = new LocalBus() as MessageBus;
      wireHeadlessAutoFix(
        {
          messageBus,
          orchestrator: {
            shouldAutoFix: () => true,
            getTask: () => ({ status: 'failed', config: { workflowId: 'wf-int' } }),
          } as any,
          persistence: { logEvent: vi.fn() } as any,
          repoRoot: tmpDir,
        },
        {} as any,
      );

      messageBus.publish(Channels.TASK_DELTA, {
        type: 'updated',
        taskId: 'wf-int/task-int',
        changes: { status: 'failed' },
      });

      for (let i = 0; i < 50 && !existsSync(markerPath); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(existsSync(markerPath)).toBe(true);

      const contents = readFileSync(markerPath, 'utf-8');
      expect(contents).toContain('INVOKER_FAILED_TASK_ID=wf-int/task-int');
      expect(contents).toContain('INVOKER_FAILED_WORKFLOW_ID=wf-int');
      expect(contents).toContain(`INVOKER_REPO_ROOT=${tmpDir}`);
      expect(contents).toContain('INVOKER_RECOVERY_REASON=task_failed');
    } finally {
      if (previousConfig === undefined) delete process.env.INVOKER_REPO_CONFIG_PATH;
      else process.env.INVOKER_REPO_CONFIG_PATH = previousConfig;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('isBusy always returns false — external recovery is fire-and-forget', () => {
    const messageBus = new LocalBus() as MessageBus;
    const controller = wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: { shouldAutoFix: () => false, getTask: () => undefined } as any,
        persistence: { logEvent: vi.fn() } as any,
        repoRoot: '/repos/example',
      },
      {} as any,
      vi.fn(),
    );
    expect(controller.isBusy()).toBe(false);
  });
});
