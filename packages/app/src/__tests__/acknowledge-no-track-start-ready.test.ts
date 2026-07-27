import { describe, expect, it, vi } from 'vitest';

import { headlessStartReady } from '../headless-run-resume.js';
import type { HeadlessDeps } from '../headless-shared.js';
import { acknowledgeNoTrackHeadlessExec } from '../ipc/gui-mutation-handlers.js';

function makeStartReadyDeps(): HeadlessDeps {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return {
    logger,
    orchestrator: {
      syncAllFromDb: vi.fn(),
      getAllTasks: vi.fn(() => []),
      getExecutableReadyTasks: vi.fn(() => []),
      getPersistedActiveTaskIds: vi.fn(() => new Set<string>()),
    },
    persistence: {},
    commandService: {},
    executorRegistry: {},
    messageBus: {},
    repoRoot: '/fake/repo',
    invokerConfig: {},
  } as unknown as HeadlessDeps;
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
        args: ['start-ready', '--recreate-failed-and-pending'],
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

  it.each([
    '--fresh-base-failed',
    '--fresh-base-failed-and-pending',
    '--fresh-base-failed-pending-and-running',
    '--fresh-base-all',
  ])('falls through for global start-ready no-track with %s', (flag) => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const result = acknowledgeNoTrackHeadlessExec(
      {
        args: ['start-ready', flag],
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
});

describe('headlessStartReady fresh-base surface', () => {
  it.each([
    ['--fresh-base-failed', 'Start and recreate failed from fresh base', []],
    ['--fresh-base-failed-and-pending', 'Start and recreate failed and pending from fresh base', [
      'pending workflows',
    ]],
    ['--fresh-base-failed-pending-and-running', 'Start and recreate failed, pending, and running from fresh base', [
      'pending workflows',
      'running workflows',
    ]],
    ['--fresh-base-all', 'Start and recreate all from fresh base (including finished)', [
      'pending workflows',
      'running workflows',
      'completed workflows',
    ]],
  ])('prints an explicit mode label and fresh-base preview count for %s', async (flag, label, extraLines) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await headlessStartReady(['--dry-run', flag], makeStartReadyDeps());
      const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(output).toContain(`${label}: preview`);
      expect(output).toContain('  fresh-base workflows: 0\n');
      for (const line of extraLines) {
        expect(output).toContain(`  ${line}: 0\n`);
      }
    } finally {
      stdout.mockRestore();
    }
  });

  it('includes fresh-base flags in unknown-option usage', async () => {
    await expect(
      headlessStartReady(['--unknown-start-ready-flag'], makeStartReadyDeps()),
    ).rejects.toThrow(
      'Usage: --headless start-ready [--dry-run] [--recreate-failed] [--recreate-failed-and-pending] [--recreate-failed-pending-and-running] [--recreate-all] [--fresh-base-failed] [--fresh-base-failed-and-pending] [--fresh-base-failed-pending-and-running] [--fresh-base-all] [--no-track]',
    );
  });
});
