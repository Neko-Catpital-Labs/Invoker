import { describe, expect, it, vi } from 'vitest';

import { runHeadless } from '../headless.js';
import { headlessStartReady } from '../headless-run-resume.js';
import { acknowledgeNoTrackHeadlessExec } from '../ipc/gui-mutation-handlers.js';

function makeTask(id: string, status: string): any {
  return {
    id,
    status,
    config: { workflowId: id.split('/')[0] },
    execution: {},
  };
}

function makeStartReadyDeps(tasks: any[]): any {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  };
  return {
    logger,
    orchestrator: {
      syncAllFromDb: vi.fn(),
      getAllTasks: vi.fn(() => tasks),
      getExecutableReadyTasks: vi.fn(() => []),
      getPersistedActiveTaskIds: vi.fn(() => new Set<string>()),
      startExecution: vi.fn(() => []),
    },
    persistence: {},
    commandService: {},
    executorRegistry: {},
    messageBus: {},
    repoRoot: '/fake/repo',
    invokerConfig: {},
  };
}

describe('acknowledgeNoTrackHeadlessExec start-ready', () => {
  it('falls through for global start-ready instead of requiring a workflow id', () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const result = acknowledgeNoTrackHeadlessExec(
      {
        args: ['start-ready', '--fresh-base-failed-and-pending'],
        noTrack: true,
      },
      undefined,
      'normal',
      'gui',
      {
        ownerId: 'owner-1',
        getWorkflowMutationCoordinator: () => ({
          submit: vi.fn(),
        }) as never,
        workflowExists: () => false,
        logger: logger as never,
      },
    );

    expect(result).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('headless.exec start-ready noTrack fallthrough'),
      expect.objectContaining({ module: 'ipc-delegate' }),
    );
  });

  it('documents fresh-base start-ready flags in headless help', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output = '';

    try {
      await runHeadless(['--help'], {} as never);
      output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    } finally {
      stdout.mockRestore();
    }

    expect(output).toContain('[--fresh-base-failed]');
    expect(output).toContain('[--fresh-base-failed-and-pending]');
    expect(output).toContain('[--fresh-base-failed-pending-and-running]');
    expect(output).toContain('[--fresh-base-all]');
    expect(output).toContain('Fresh-base flags recreate selected workflows from a refreshed base');
  });

  it.each([
    [
      '--fresh-base-failed',
      'failed',
      'Start ready work and recreate failed workflows from fresh base',
      1,
    ],
    [
      '--fresh-base-failed-and-pending',
      'failed-and-pending',
      'Start ready work and recreate failed and pending workflows from fresh base',
      2,
    ],
    [
      '--fresh-base-failed-pending-and-running',
      'failed-pending-and-running',
      'Start ready work and recreate failed, pending, and running workflows from fresh base',
      3,
    ],
    [
      '--fresh-base-all',
      'all',
      'Start ready work and recreate all workflows from fresh base (including finished)',
      4,
    ],
  ])('prints explicit fresh-base preview output for %s', async (
    flag,
    scope,
    label,
    workflowCount,
  ) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const deps = makeStartReadyDeps([
      makeTask('wf-failed/task-1', 'failed'),
      makeTask('wf-pending/task-1', 'pending'),
      makeTask('wf-running/task-1', 'running'),
      makeTask('wf-completed/task-1', 'completed'),
    ]);
    let output = '';

    try {
      await headlessStartReady(['--dry-run', flag], deps);
      output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    } finally {
      stdout.mockRestore();
    }

    expect(output).toContain(`${label}: preview`);
    expect(output).toContain(`fresh-base scope: ${scope}`);
    expect(output).toContain(`fresh-base workflows: ${workflowCount}`);
    expect(output).toContain('fresh-base recreated workflows: 0');
  });

  it('repro: pre-fix path rejected no-track start-ready as workflow-not-resolved', () => {
    // Root cause proof: without the start-ready fallthrough, acknowledgeNoTrackHeadlessExec
    // throws because classifyHeadlessExecMutation leaves workflowId undefined for global
    // start-ready. The production fix returns undefined (inline execute) instead.
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const payload = { args: ['start-ready', '--dry-run'], noTrack: true as const };
    expect(() => {
      // Simulate the old reject branch for a non-global command shape to keep the
      // workflow-not-resolved contract locked, then prove start-ready escapes it.
      acknowledgeNoTrackHeadlessExec(
        { args: ['retry', 'wf-missing'], noTrack: true },
        undefined,
        'normal',
        'gui',
        {
          ownerId: 'owner-1',
          getWorkflowMutationCoordinator: () => ({ submit: vi.fn() }) as never,
          workflowExists: () => false,
          logger: logger as never,
        },
      );
    }).toThrow('workflow-not-resolved');

    expect(
      acknowledgeNoTrackHeadlessExec(
        payload,
        undefined,
        'normal',
        'gui',
        {
          ownerId: 'owner-1',
          getWorkflowMutationCoordinator: () => ({ submit: vi.fn() }) as never,
          workflowExists: () => false,
          logger: logger as never,
        },
      ),
    ).toBeUndefined();
  });

  it('falls through for unscoped repair-filing insert instead of requiring a workflow id', () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const result = acknowledgeNoTrackHeadlessExec(
      {
        args: ['repair-filing', 'insert', '--kind', 'K', '--subject', 'S', '--state-sha', 'SHA'],
        noTrack: true,
      },
      undefined,
      'normal',
      'standalone',
      {
        ownerId: 'owner-1',
        getWorkflowMutationCoordinator: () => ({
          submit: vi.fn(),
        }) as never,
        workflowExists: () => false,
        logger: logger as never,
      },
    );

    expect(result).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('headless.exec start-ready noTrack fallthrough'),
      expect.objectContaining({ module: 'ipc-delegate' }),
    );
  });

  it('still rejects other no-track commands without a workflow id', () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    expect(() => acknowledgeNoTrackHeadlessExec(
      {
        args: ['retry-task', 'wf-1/task-a'],
        noTrack: true,
      },
      undefined,
      'normal',
      'gui',
      {
        ownerId: 'owner-1',
        getWorkflowMutationCoordinator: () => ({
          submit: vi.fn(),
        }) as never,
        workflowExists: () => false,
        logger: logger as never,
      },
    )).toThrow('workflow-not-resolved');
  });
});
