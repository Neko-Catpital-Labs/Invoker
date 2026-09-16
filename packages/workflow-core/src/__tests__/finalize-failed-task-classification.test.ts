import { describe, expect, it } from 'vitest';
import {
  InMemoryPersistence,
  makeOrchestrator,
  makeResponse,
} from './helpers/cross-workflow-cascade-helpers.js';

describe('finalize failed task classification', () => {
  it('persists classifications for docker and local runner kinds', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    orchestrator.loadPlan({
      name: 'finalize-classification',
      onFinish: 'none',
      tasks: [
        { id: 'docker-task', description: 'docker', command: 'x', runnerKind: 'docker' },
        { id: 'local-task', description: 'local', command: 'x', runnerKind: 'worktree' },
      ],
    });
    const tasks = orchestrator.getAllTasks().filter((task) => !task.config.isMergeNode);
    const dockerTask = tasks.find((task) => task.id.endsWith('/docker-task'))!;
    const localTask = tasks.find((task) => task.id.endsWith('/local-task'))!;

    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(makeResponse({
      actionId: dockerTask.id,
      status: 'failed',
      outputs: { exitCode: 1, error: 'No space left on device' },
    }));
    orchestrator.handleWorkerResponse(makeResponse({
      actionId: localTask.id,
      status: 'failed',
      outputs: { exitCode: 255, error: 'SSH transport failed (exit 255): connection reset by peer.' },
    }));

    expect(persistence.getTaskEntry(dockerTask.id)?.task.execution.failureClass).toBe('ssh-disk-full');
    expect(persistence.getTaskEntry(localTask.id)?.task.execution.failureClass).toBe('ssh-transport-transient');
  });

  it('persists workspace and branch classes when no infra class matches', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    orchestrator.loadPlan({
      name: 'finalize-work-classification',
      onFinish: 'none',
      tasks: [
        { id: 'deps', description: 'deps', command: 'x', runnerKind: 'worktree' },
        { id: 'moved', description: 'moved', command: 'x', runnerKind: 'worktree' },
        { id: 'gone', description: 'gone', command: 'x', runnerKind: 'worktree' },
        { id: 'both', description: 'both', command: 'x', runnerKind: 'worktree' },
      ],
    });
    const byName = (name: string) => orchestrator.getAllTasks().find((task) => task.id.endsWith(`/${name}`))!;
    const errors: Record<string, string> = {
      deps: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@neko-catpital-labs/drafter-core' imported from /w/validate-pr-body.mjs",
      moved: 'pr-worker-safe-push: stale-head: refs/heads/stack/a is 7af8; expected b3fd',
      gone: 'Error: Branch "feature/x" required by the merge/gate step was not found on the remote (git@github.com:o/r.git).',
      both: "Cannot find package 'left-pad' imported from /w/a.mjs\nNo space left on device",
    };

    orchestrator.startExecution();
    for (const [name, error] of Object.entries(errors)) {
      orchestrator.handleWorkerResponse(makeResponse({
        actionId: byName(name).id,
        status: 'failed',
        outputs: { exitCode: 1, error },
      }));
    }

    const classOf = (name: string) => persistence.getTaskEntry(byName(name).id)?.task.execution.failureClass;
    expect(classOf('deps')).toBe('dependency-missing');
    expect(classOf('moved')).toBe('branch-head-moved');
    expect(classOf('gone')).toBe('branch-missing-on-remote');
    expect(classOf('both')).toBe('ssh-disk-full');
  });
});
