import { describe, expect, it } from 'vitest';
import {
  isHeadlessMutatingCommand,
  isHeadlessReadOnlyCommand,
  resolveHeadlessTarget,
  resolveHeadlessTargetWorkflowId,
  type HeadlessTargetLookup,
} from '../headless-command-classification.js';

describe('headless-command-classification', () => {
  const targetLookup: HeadlessTargetLookup = {
    loadWorkflow: (workflowId) => workflowId === 'wf-1' ? { id: workflowId } as any : undefined,
    listWorkflows: () => [{ id: 'wf-1' } as any, { id: 'wf-2' } as any],
    loadTasks: (workflowId) => {
      if (workflowId === 'wf-2') {
        return [{ id: 'wf-2/task-1' }] as any;
      }
      return [];
    },
  };

  it('classifies read-only commands', () => {
    expect(isHeadlessReadOnlyCommand([])).toBe(true);
    expect(isHeadlessReadOnlyCommand(['query'])).toBe(true);
    expect(isHeadlessReadOnlyCommand(['list'])).toBe(true);
    expect(isHeadlessReadOnlyCommand(['session'])).toBe(true);
    expect(isHeadlessReadOnlyCommand(['open-terminal'])).toBe(true);
    expect(isHeadlessReadOnlyCommand(['run'])).toBe(false);
  });

  it('classifies mutating commands', () => {
    expect(isHeadlessMutatingCommand([])).toBe(false);
    expect(isHeadlessMutatingCommand(['query'])).toBe(false);
    expect(isHeadlessMutatingCommand(['open-terminal'])).toBe(false);
    expect(isHeadlessMutatingCommand(['slack'])).toBe(false);

    expect(isHeadlessMutatingCommand(['run'])).toBe(true);
    expect(isHeadlessMutatingCommand(['migrate-compat'])).toBe(true);
    expect(isHeadlessMutatingCommand(['cancel-workflow'])).toBe(true);
    expect(isHeadlessMutatingCommand(['set', 'agent'])).toBe(true);
    expect(isHeadlessMutatingCommand(['set', 'unknown'])).toBe(false);
  });

  it('resolves workflow and task targets via lookup', () => {
    expect(resolveHeadlessTarget('wf-1', targetLookup)).toEqual({
      kind: 'workflow',
      workflowId: 'wf-1',
    });
    expect(resolveHeadlessTarget('wf-2/task-1', targetLookup)).toEqual({
      kind: 'task',
      workflowId: 'wf-2',
      taskId: 'wf-2/task-1',
      resolvedTaskId: 'wf-2/task-1',
    });
  });

  it('throws when target workflow cannot be resolved', () => {
    expect(() => resolveHeadlessTargetWorkflowId('missing-target', targetLookup)).toThrow(
      'Could not resolve headless target workflow for "missing-target"',
    );
  });
});
