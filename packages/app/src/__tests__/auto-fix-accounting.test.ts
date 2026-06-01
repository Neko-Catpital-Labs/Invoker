import { describe, expect, it, vi } from 'vitest';
import { applyAutoFixAccounting } from '../workflow-actions.js';

function makeDeps(options: {
  shouldAutoFix: boolean;
  autoFixAttempts?: number;
  budget?: number;
  autoFixAgent?: string;
}) {
  const updateTask = vi.fn();
  const logEvent = vi.fn();
  const task = { execution: { autoFixAttempts: options.autoFixAttempts ?? 0 } };
  return {
    updateTask,
    logEvent,
    deps: {
      orchestrator: {
        shouldAutoFix: vi.fn(() => options.shouldAutoFix),
        getTask: vi.fn(() => task as any),
        getAutoFixRetryBudget: vi.fn(() => options.budget ?? 3),
      },
      persistence: { updateTask, logEvent } as any,
      getAutoFixAgent: () => options.autoFixAgent,
    },
  };
}

describe('applyAutoFixAccounting', () => {
  it('increments autoFixAttempts exactly once when accepted', () => {
    const { deps, updateTask } = makeDeps({ shouldAutoFix: true, autoFixAttempts: 1, budget: 3 });

    const result = applyAutoFixAccounting('wf-1/task-1', deps);

    expect(result.accepted).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.max).toBe(3);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith('wf-1/task-1', { execution: { autoFixAttempts: 2 } });
  });

  it('does not increment when the retry budget is exhausted', () => {
    const { deps, updateTask } = makeDeps({ shouldAutoFix: false, autoFixAttempts: 3, budget: 3 });

    const result = applyAutoFixAccounting('wf-1/task-1', deps);

    expect(result.accepted).toBe(false);
    expect(result.attempts).toBe(3);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('selects the configured auto-fix agent, falling back to undefined when empty', () => {
    const configured = applyAutoFixAccounting('t', makeDeps({ shouldAutoFix: true, autoFixAgent: ' codex ' }).deps);
    expect(configured.agentName).toBe('codex');

    const empty = applyAutoFixAccounting('t', makeDeps({ shouldAutoFix: true, autoFixAgent: '   ' }).deps);
    expect(empty.agentName).toBeUndefined();

    const none = applyAutoFixAccounting('t', makeDeps({ shouldAutoFix: true }).deps);
    expect(none.agentName).toBeUndefined();
  });
});
