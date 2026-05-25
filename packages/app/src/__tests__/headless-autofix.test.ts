import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessAutoFix } from '../headless.js';
import type {
  ExternalRecoveryLauncher,
  RecoveryContext,
  RecoveryLaunchResult,
} from '../external-failure-recovery.js';
import type { ExternalFailureRecoveryConfig } from '../config.js';

function makeOrchestrator(taskWorkflowMap: Record<string, string>) {
  return {
    getTask: (taskId: string) => {
      const workflowId = taskWorkflowMap[taskId];
      return workflowId ? { config: { workflowId } } : undefined;
    },
    shouldAutoFix: vi.fn(() => true),
  };
}

function captureLauncher(launchResult: RecoveryLaunchResult = { launched: true, pid: 99 }): {
  launcher: ExternalRecoveryLauncher;
  calls: Array<{ config: ExternalFailureRecoveryConfig | undefined; context: RecoveryContext }>;
} {
  const calls: Array<{ config: ExternalFailureRecoveryConfig | undefined; context: RecoveryContext }> = [];
  const launcher: ExternalRecoveryLauncher = {
    launch(config, context) {
      calls.push({ config, context });
      return launchResult;
    },
  };
  return { launcher, calls };
}

function writeConfig(cfg: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'wire-hl-af-'));
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(cfg));
  process.env.INVOKER_REPO_CONFIG_PATH = cfgPath;
  return cfgPath;
}

function clearConfigEnv(): void {
  delete process.env.INVOKER_REPO_CONFIG_PATH;
}

describe('wireHeadlessAutoFix', () => {
  it('does not launch external recovery when config is missing', () => {
    clearConfigEnv();
    writeConfig({}); // ensure no externalFailureRecovery key
    const messageBus = new LocalBus() as MessageBus;
    const persistence = { logEvent: vi.fn() };
    const orchestrator = makeOrchestrator({ 'wf-1/task-1': 'wf-1' });
    const { launcher, calls } = captureLauncher();

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        repoRoot: '/repo',
      },
      {} as any,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    expect(calls).toHaveLength(0);
    expect(persistence.logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'skip', reason: 'disabled' }),
    );
  });

  it('launches external recovery for failed deltas with workflow context', () => {
    const enabledConfig: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: '/tmp/recover.sh',
    };
    writeConfig({ externalFailureRecovery: enabledConfig });

    const messageBus = new LocalBus() as MessageBus;
    const persistence = { logEvent: vi.fn() };
    const orchestrator = makeOrchestrator({ 'wf-1/task-1': 'wf-1' });
    const { launcher, calls } = captureLauncher({ launched: true, pid: 4242 });

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        repoRoot: '/repo',
      },
      {} as any,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.config).toEqual(enabledConfig);
    expect(calls[0]!.context.taskId).toBe('wf-1/task-1');
    expect(calls[0]!.context.workflowId).toBe('wf-1');
    expect(calls[0]!.context.repoRoot).toBe('/repo');
    expect(typeof calls[0]!.context.dbDir).toBe('string');
    expect(persistence.logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'launched', workflowId: 'wf-1', pid: 4242 }),
    );
  });

  it('does not invoke any in-process Fix-with-AI path on failed deltas', async () => {
    writeConfig({ externalFailureRecovery: { enabled: true, command: '/tmp/recover.sh' } });
    const workflowActions = await import('../workflow-actions.js');
    const autoFixSpy = vi.spyOn(workflowActions, 'autoFixOnFailure');

    const messageBus = new LocalBus() as MessageBus;
    const persistence = { logEvent: vi.fn() };
    const orchestrator = makeOrchestrator({ 'wf-1/task-1': 'wf-1' });
    const { launcher } = captureLauncher();

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        repoRoot: '/repo',
      },
      {} as any,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    // Allow any microtasks queued by the delta handler to flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(autoFixSpy).not.toHaveBeenCalled();
    autoFixSpy.mockRestore();
  });

  it('skips when the task cannot be resolved to a workflow', () => {
    writeConfig({ externalFailureRecovery: { enabled: true, command: '/tmp/recover.sh' } });
    const messageBus = new LocalBus() as MessageBus;
    const persistence = { logEvent: vi.fn() };
    const orchestrator = makeOrchestrator({});
    const { launcher, calls } = captureLauncher();

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        repoRoot: '/repo',
      },
      {} as any,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/orphan',
      changes: { status: 'failed' },
    });

    expect(calls).toHaveLength(0);
    expect(persistence.logEvent).toHaveBeenCalledWith(
      'wf-1/orphan',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'skip', reason: 'workflow-not-found' }),
    );
  });

  it('isBusy is always false because recovery runs out of process', () => {
    const messageBus = new LocalBus() as MessageBus;
    const persistence = { logEvent: vi.fn() };
    const orchestrator = makeOrchestrator({ 'wf-1/task-1': 'wf-1' });
    const { launcher } = captureLauncher();
    const controller = wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        repoRoot: '/repo',
      },
      {} as any,
      launcher,
    );

    expect(controller.isBusy()).toBe(false);
  });
});
