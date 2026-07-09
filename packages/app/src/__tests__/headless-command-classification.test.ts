import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEADLESS_SET_SUBCOMMANDS,
  formatHeadlessSetSubcommands,
} from '../headless-command-registry.js';
import {
  isHeadlessMutatingCommand,
  isHeadlessReadOnlyCommand,
  resolveHeadlessTarget,
  resolveHeadlessTargetWorkflowId,
  type HeadlessTargetLookup,
} from '../headless-command-classification.js';
import { runHeadless } from '../headless.js';

describe('headless-command-classification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const targetLookup: HeadlessTargetLookup = {
    loadWorkflow: (workflowId) => workflowId === 'wf-1' ? { id: workflowId } as any : undefined,
    listWorkflows: () => [{ id: 'wf-1' } as any, { id: 'wf-2' } as any],
    loadTasks: (workflowId) => {
      if (workflowId === 'wf-1') {
        return [{ id: '__merge__wf-1', config: { workflowId: 'wf-1', isMergeNode: true } }] as any;
      }
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
    expect(isHeadlessMutatingCommand(['set', 'prompt'])).toBe(true);
    expect(isHeadlessMutatingCommand(['set', 'agent'])).toBe(true);
    expect(isHeadlessMutatingCommand(['set', 'fix-context'])).toBe(true);
    expect(isHeadlessMutatingCommand(['set', 'xyz'])).toBe(false);
  });

  it('classifies every registered set subcommand as mutating', () => {
    for (const subcommand of HEADLESS_SET_SUBCOMMANDS) {
      expect(isHeadlessMutatingCommand(['set', subcommand])).toBe(true);
    }

    expect(isHeadlessMutatingCommand(['set', 'xyz'])).toBe(false);
    expect(isHeadlessMutatingCommand(['set'])).toBe(false);
  });

  it('derives set subcommand errors from the registry', async () => {
    await expect(runHeadless(['set'], {} as any)).rejects.toThrow(
      `Missing set sub-command. Usage: --headless set <${formatHeadlessSetSubcommands('|')}>`,
    );
    await expect(runHeadless(['set', 'xyz'], {} as any)).rejects.toThrow(
      `Unknown set sub-command: "xyz". Use: ${formatHeadlessSetSubcommands(', ')}`,
    );
  });

  it('documents registered public set subcommands in help output', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless(['--help'], {} as any);

    const help = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    for (const subcommand of HEADLESS_SET_SUBCOMMANDS) {
      if (subcommand === 'executor') continue;
      expect(help).toContain(`set ${subcommand}`);
    }
  });

  it('resolves workflow and task targets via lookup', () => {
    expect(resolveHeadlessTarget('wf-1', targetLookup)).toEqual({
      kind: 'workflow',
      workflowId: 'wf-1',
    });
    expect(resolveHeadlessTarget('__merge__wf-1', targetLookup)).toEqual({
      kind: 'task',
      workflowId: 'wf-1',
      taskId: '__merge__wf-1',
      resolvedTaskId: '__merge__wf-1',
    });
    expect(resolveHeadlessTarget('wf-2/task-1', targetLookup)).toEqual({
      kind: 'task',
      workflowId: 'wf-2',
      taskId: 'wf-2/task-1',
      resolvedTaskId: 'wf-2/task-1',
    });
  });

  it('resolves explicit workflow and task ids without requiring persistence lookup', () => {
    const emptyLookup: HeadlessTargetLookup = {
      loadWorkflow: () => undefined,
      listWorkflows: () => [],
      loadTasks: () => [],
    };

    expect(resolveHeadlessTarget('wf-99', emptyLookup)).toEqual({
      kind: 'workflow',
      workflowId: 'wf-99',
    });
    expect(resolveHeadlessTarget('wf-99/task-a', emptyLookup)).toEqual({
      kind: 'task',
      workflowId: 'wf-99',
      taskId: 'wf-99/task-a',
      resolvedTaskId: 'wf-99/task-a',
    });
  });

  it('throws when target workflow cannot be resolved', () => {
    expect(resolveHeadlessTargetWorkflowId('__merge__wf-1', targetLookup)).toBe('wf-1');
    expect(() => resolveHeadlessTargetWorkflowId('missing-target', targetLookup)).toThrow(
      'Could not resolve headless target workflow for "missing-target"',
    );
  });
});
