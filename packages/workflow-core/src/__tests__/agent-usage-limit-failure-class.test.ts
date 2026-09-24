import { describe, it, expect, beforeEach } from 'vitest';
import type { Orchestrator } from '../orchestrator.js';
import { InMemoryPersistence, makeOrchestrator, makeResponse } from './helpers/cross-workflow-cascade-helpers.js';

const USAGE_LIMIT_ERROR = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.";

describe('agent-usage-limit failureClass persistence', () => {
  let persistence: InMemoryPersistence;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    orchestrator = makeOrchestrator(persistence);
  });

  function loadSingleTask(task: Record<string, unknown> & { id: string }): string {
    orchestrator.loadPlan({ name: 'quota', onFinish: 'none', tasks: [task as never] });
    orchestrator.startExecution();
    return orchestrator.getAllTasks().find((t) => !t.config.isMergeNode && t.id.endsWith(`/${task.id}`))!.id;
  }

  function failTask(taskId: string, error: string): void {
    orchestrator.handleWorkerResponse(makeResponse({ actionId: taskId, status: 'failed', outputs: { exitCode: 1, error } }));
  }

  const agentTask = { id: 'agent-task', description: 'agent', prompt: 'do it', runnerKind: 'worktree' };

  it('persists agent-usage-limit when an agent task fails on a quota refusal', () => {
    const taskId = loadSingleTask(agentTask);
    failTask(taskId, USAGE_LIMIT_ERROR);

    expect(persistence.getTaskEntry(taskId)?.task.execution.failureClass).toBe('agent-usage-limit');
  });

  it('persists agent-usage-limit when the fix session is reverted after a quota refusal', () => {
    const taskId = loadSingleTask(agentTask);
    failTask(taskId, 'AssertionError: expected 1 to be 2');

    const { savedError } = orchestrator.beginFixSession(taskId);
    orchestrator.revertFixSession(taskId, {
      savedError,
      fixError: `codex fix exited with code 1: ${USAGE_LIMIT_ERROR}`,
    });

    const task = persistence.getTaskEntry(taskId)?.task;
    expect(task?.status).toBe('failed');
    expect(task?.execution.error).toContain('[Fix with Agent failed]');
    expect(task?.execution.failureClass).toBe('agent-usage-limit');
  });

  it('does not classify command task errors as agent-usage-limit', () => {
    const taskId = loadSingleTask({ id: 'cmd-task', description: 'cmd', command: 'pnpm test' });
    failTask(taskId, 'Error: rate limit exceeded while calling the test API');

    expect(persistence.getTaskEntry(taskId)?.task.execution.failureClass).toBeUndefined();
  });

  it('leaves failureClass undefined for ordinary agent task failures', () => {
    const taskId = loadSingleTask(agentTask);
    failTask(taskId, 'AssertionError: expected 1 to be 2');

    expect(persistence.getTaskEntry(taskId)?.task.execution.failureClass).toBeUndefined();
  });
});
