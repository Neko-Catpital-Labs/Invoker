import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@invoker/contracts';
import { recoverWorkflowMutationsOnStartup } from '../workflow-mutation-startup.js';

function makeLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

describe('recoverWorkflowMutationsOnStartup', () => {
  it('requeues and resumes pending mutations for owner startup without env gating', async () => {
    const persistence = {
      requeueExpiredWorkflowMutationLeases: vi.fn(),
    };
    const workflowMutationCoordinator = {
      resumePending: vi.fn(async () => {}),
    };
    const maybeDelayResume = vi.fn(async () => {});
    const logger = makeLogger();

    await recoverWorkflowMutationsOnStartup({
      ownerMode: true,
      persistence,
      workflowMutationCoordinator,
      logger,
      maybeDelayResume,
    });

    expect(persistence.requeueExpiredWorkflowMutationLeases).toHaveBeenCalledTimes(1);
    expect(maybeDelayResume).toHaveBeenCalledTimes(1);
    expect(workflowMutationCoordinator.resumePending).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('requeued expired workflow mutation leases on startup', { module: 'init' });
    expect(logger.info).toHaveBeenCalledWith('resuming pending workflow mutations on startup', { module: 'init' });
    expect(logger.info).toHaveBeenCalledWith('workflow mutation recovery finished on startup', { module: 'init' });
  });

  it('does nothing in follower mode', async () => {
    const persistence = {
      requeueExpiredWorkflowMutationLeases: vi.fn(),
    };
    const workflowMutationCoordinator = {
      resumePending: vi.fn(async () => {}),
    };
    const logger = makeLogger();

    await recoverWorkflowMutationsOnStartup({
      ownerMode: false,
      persistence,
      workflowMutationCoordinator,
      logger,
    });

    expect(persistence.requeueExpiredWorkflowMutationLeases).not.toHaveBeenCalled();
    expect(workflowMutationCoordinator.resumePending).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
