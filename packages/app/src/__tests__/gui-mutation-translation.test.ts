import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(path.resolve(__dirname, '..', 'main.ts'), 'utf8');
const guiMutationHandlersSource = readFileSync(
  path.resolve(__dirname, '..', 'ipc', 'gui-mutation-handlers.ts'),
  'utf8',
);

function getTranslatorSource(): string {
  const start = guiMutationHandlersSource.indexOf('function translateGuiMutationToHeadless');
  const end = guiMutationHandlersSource.indexOf('  async function performSharedApproveTask', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return guiMutationHandlersSource.slice(start, end);
}

function getStandaloneClassifierSource(): string {
  const start = mainSource.indexOf('const classifyStandaloneHeadlessExecMutation =');
  const end = mainSource.indexOf('        const standaloneWorkflowIdForTaskArg', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return mainSource.slice(start, end);
}

function getStandaloneGuiMutationSource(): string {
  const start = mainSource.indexOf('const executeStandaloneGuiMutation = async');
  const end = mainSource.indexOf('      // In standalone owner mode, serve delegated requests from peer headless processes.', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return mainSource.slice(start, end);
}

function getPerformDeleteWorkflowSource(): string {
  const start = guiMutationHandlersSource.indexOf('async function performDeleteWorkflow');
  const end = guiMutationHandlersSource.indexOf('  async function performDetachWorkflow', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return guiMutationHandlersSource.slice(start, end);
}

function getPerformDetachWorkflowSource(): string {
  const start = guiMutationHandlersSource.indexOf('async function performDetachWorkflow');
  const end = guiMutationHandlersSource.indexOf('  /** Orchestrator error codes', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return guiMutationHandlersSource.slice(start, end);
}

function getSetMergeBranchSource(): string {
  const start = guiMutationHandlersSource.lastIndexOf("'invoker:set-merge-branch'");
  const end = guiMutationHandlersSource.indexOf("'invoker:set-workflow-merge-mode'", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return guiMutationHandlersSource.slice(start, end);
}

function getRetryTaskSource(): string {
  const start = guiMutationHandlersSource.lastIndexOf("'invoker:retry-task'");
  const end = guiMutationHandlersSource.indexOf("'invoker:cancel-task'", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return guiMutationHandlersSource.slice(start, end);
}

describe('GUI mutation translation', () => {
  it.each([
    'invoker:check-pr-statuses',
    'invoker:check-pr-status',
    'invoker:start-ready',
    'invoker:select-experiment',
    'invoker:edit-task-pool',
  ])('routes %s to the owner GUI mutation handler', (channel) => {
    const translatorSource = getTranslatorSource();
    expect(translatorSource).toMatch(
      new RegExp(
        `case '${channel}':\\s*return \\{ channel: 'headless\\.gui-mutation', request: payload \\};`,
      ),
    );
  });

  it('routes spawn-repair-workflow to the owner GUI mutation handler', () => {
    const translatorSource = getTranslatorSource();
    expect(translatorSource).toMatch(
      /case SPAWN_REPAIR_WORKFLOW_CHANNEL:\s*return \{ channel: 'headless\.gui-mutation', request: payload \};/,
    );
  });

  it.each([
    ['invoker:retry-task', 'retry-task'],
    ['invoker:cancel-task', 'cancel'],
    ['invoker:delete-task', 'delete-task'],
    ['invoker:cancel-workflow', 'cancel-workflow'],
    ['invoker:delete-workflow', 'delete'],
    ['invoker:recreate-workflow', 'recreate'],
    ['invoker:recreate-task', 'recreate-task'],
    ['invoker:recreate-downstream', 'recreate-downstream'],
    ['invoker:retry-workflow', 'retry'],
    ['invoker:rebase-retry', 'rebase-retry'],
    ['invoker:rebase-recreate', 'rebase-recreate'],
  ])('routes %s as a no-track owner command', (channel, command) => {
    const translatorSource = getTranslatorSource();
    expect(translatorSource).toMatch(
      new RegExp(
        `case '${channel}':\\s*return \\{ channel: 'headless\\.exec', request: \\{ args: \\['${command}', String\\(arg0\\)\\], noTrack: true \\} \\};`,
      ),
    );
  });


  it('classifies delegated standalone workflow delete and detach as workflow-scoped', () => {
    const classifierSource = getStandaloneClassifierSource();
    expect(classifierSource).toMatch(
      /case 'delete':\s*case 'delete-workflow':\s*case 'detach-workflow':\s*return \{ workflowId: arg0 === undefined \? undefined : String\(arg0\), priority: 'high' \};/,
    );
  });

  it('handles start-ready in the standalone owner GUI mutation switch', () => {
    const standaloneGuiMutationSource = getStandaloneGuiMutationSource();
    expect(standaloneGuiMutationSource).toMatch(
      /case 'invoker:start-ready':\s*\{[\s\S]*workflowMutationDispatcher\.get\('invoker:start-ready'\)[\s\S]*return handler\(payload\.args\[0\] as StartReadyRequest \| undefined\);/,
    );
  });

  it('handles edit-task-pool in the standalone owner GUI mutation switch', () => {
    const standaloneGuiMutationSource = getStandaloneGuiMutationSource();
    expect(standaloneGuiMutationSource).toMatch(
      /case 'invoker:edit-task-pool':\s*\{[\s\S]*commandService\.editTaskPool\(envelope\)[\s\S]*dispatchStartedTasksWithGlobalTopup\(/,
    );
  });

  it('publishes workflow metadata after every successful workflow delete', () => {
    const deleteSource = getPerformDeleteWorkflowSource();
    expect(deleteSource).toMatch(
      /if \(!result\.ok\) throw new Error\(result\.error\.message\);\s*requestWorkflowMetadataPublish\('delete-workflow'\);/,
    );
  });

  it('publishes workflow metadata after every successful workflow detach', () => {
    const detachSource = getPerformDetachWorkflowSource();
    expect(detachSource).toMatch(
      /if \(!result\.ok\) throw new Error\(result\.error\.message\);\s*logger\.info\(`performDetachWorkflow end workflow="\$\{workflowId\}" upstream="\$\{upstreamWorkflowId\}"`, \{ module: 'kill' \}\);\s*requestWorkflowMetadataPublish\('detach-workflow'\);/,
    );
  });

  it('publishes workflow metadata after setting the workflow merge branch', () => {
    const setMergeBranchSource = getSetMergeBranchSource();
    expect(setMergeBranchSource).toMatch(
      /persistence\.updateWorkflow\(workflowId, \{ baseBranch \}\);[\s\S]*requestWorkflowMetadataPublish\('set-merge-branch'\);/,
    );
  });

  it('retry-task lets commandService own active-task preemption', () => {
    const retryTaskSource = getRetryTaskSource();
    expect(retryTaskSource).not.toContain('preemptTaskSubgraph(taskId)');
    expect(retryTaskSource).toContain('commandService.retryTask(envelope)');
  });
});
