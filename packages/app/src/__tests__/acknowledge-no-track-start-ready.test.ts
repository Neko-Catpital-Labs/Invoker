import { describe, expect, it, vi } from 'vitest';

import { acknowledgeNoTrackHeadlessExec } from '../ipc/gui-mutation-handlers.js';

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
});
