#!/usr/bin/env node
// Repro: the workflow-resume worker must persist its recovery.worker.submit
// audit event with events.task_id set to the ready pending task id. If the
// worker logs the bare workflow id instead, the real SQLiteAdapter rejects the
// event via the events.task_id foreign key and aborts the tick after the first
// submit.
//
// Run via scripts/repro/repro-workflow-resume-fk.sh, which bundles this driver
// with esbuild so the real TypeScript worker and SQLite adapter sources are
// exercised without tsx, vitest, or network installs.

import { SQLiteAdapter } from '../../packages/data-store/src/sqlite-adapter.ts';
import {
  createWorkflowResumeCooldownLedger,
  createWorkflowResumeTick,
  WORKFLOW_RESUME_COMMAND_CHANNEL,
} from '../../packages/execution-engine/src/workers/workflow-resume-worker.ts';

const POLL_CTX = {
  identity: { kind: 'workflow-resume', instanceId: 'repro-workflow-resume-fk' },
  reason: 'poll',
  tickNumber: 1,
  signal: new AbortController().signal,
};

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  child: () => logger,
};

const failures = [];
function expect(ok, message) {
  if (!ok) failures.push(message);
}

function makeWorkflow(id, createdAt) {
  return {
    id,
    name: id,
    status: 'running',
    createdAt,
    updatedAt: createdAt,
  };
}

function makeTask(workflowId, taskId, createdAt) {
  return {
    id: taskId,
    description: taskId,
    status: 'pending',
    dependencies: [],
    createdAt: new Date(createdAt),
    config: { workflowId },
    execution: {},
    taskStateVersion: 1,
  };
}

function payloadOf(event) {
  if (event.payload === undefined) return undefined;
  return JSON.parse(event.payload);
}

function checkSubmitEvent(adapter, workflowId) {
  const taskId = `${workflowId}/t1`;
  const events = adapter.getEvents(taskId);
  expect(
    events.length === 1,
    `expected exactly one event row for ${taskId}, got ${events.length}`,
  );
  expect(
    events[0]?.eventType === 'recovery.worker.submit',
    `expected ${taskId} event type to be recovery.worker.submit`,
  );
  const payload = events[0] ? payloadOf(events[0]) : undefined;
  expect(
    payload?.workflowId === workflowId,
    `expected ${taskId} payload.workflowId to be ${workflowId}`,
  );
  expect(
    payload?.worker === 'workflow-resume',
    `expected ${taskId} payload.worker to be workflow-resume`,
  );
  expect(
    payload?.phase === 'start-ready',
    `expected ${taskId} payload.phase to be start-ready`,
  );
  expect(
    payload?.channel === WORKFLOW_RESUME_COMMAND_CHANNEL,
    `expected ${taskId} payload.channel to be ${WORKFLOW_RESUME_COMMAND_CHANNEL}`,
  );
}

let adapter;
try {
  adapter = await SQLiteAdapter.create(':memory:');

  // Seed wf-2 earlier and wf-1 later. SQLiteAdapter.listWorkflows orders by
  // created_at DESC, so wf-1 must be the first workflow-resume candidate.
  adapter.saveWorkflow(makeWorkflow('wf-2', '2026-07-01T00:00:00.000Z'));
  adapter.saveTask('wf-2', makeTask('wf-2', 'wf-2/t1', '2026-07-01T00:00:00.000Z'));
  adapter.saveWorkflow(makeWorkflow('wf-1', '2026-07-01T00:00:01.000Z'));
  adapter.saveTask('wf-1', makeTask('wf-1', 'wf-1/t1', '2026-07-01T00:00:01.000Z'));

  const submitCalls = [];
  const submitter = {
    submit(workflowId, priority, channel, args) {
      submitCalls.push({ workflowId, priority, channel, args });
      return workflowId === 'wf-1' ? 101 : 202;
    },
  };

  const tick = createWorkflowResumeTick({
    store: adapter,
    submitter,
    logger,
    ledger: createWorkflowResumeCooldownLedger(),
    now: () => 0,
  });

  let tickError;
  try {
    await tick(POLL_CTX);
  } catch (err) {
    tickError = err;
  }

  expect(
    tickError === undefined,
    `expected workflow-resume tick to resolve cleanly, got ${tickError?.message ?? tickError}`,
  );
  expect(
    submitCalls.map((call) => call.workflowId).join(',') === 'wf-1,wf-2',
    `expected submit order wf-1,wf-2, got ${submitCalls.map((call) => call.workflowId).join(',') || '<none>'}`,
  );
  for (const call of submitCalls) {
    expect(
      call.priority === 'normal',
      `expected ${call.workflowId} priority normal, got ${call.priority}`,
    );
    expect(
      call.channel === WORKFLOW_RESUME_COMMAND_CHANNEL,
      `expected ${call.workflowId} channel ${WORKFLOW_RESUME_COMMAND_CHANNEL}, got ${call.channel}`,
    );
    expect(
      JSON.stringify(call.args) === '[{}]',
      `expected ${call.workflowId} args [{}], got ${JSON.stringify(call.args)}`,
    );
  }

  checkSubmitEvent(adapter, 'wf-1');
  checkSubmitEvent(adapter, 'wf-2');

  const bareWorkflowEvents = [
    ...adapter.getEvents('wf-1'),
    ...adapter.getEvents('wf-2'),
  ];
  expect(
    bareWorkflowEvents.length === 0,
    `expected zero bare workflow-id event rows, got ${bareWorkflowEvents.length}`,
  );
} finally {
  adapter?.close();
}

if (failures.length > 0) {
  console.error('FAIL: workflow-resume FK regression guard failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('PASS: workflow-resume tick submitted ready workflows in order wf-1,wf-2.');
console.log('PASS: recovery.worker.submit events are keyed by real task ids wf-1/t1 and wf-2/t1.');
console.log('PASS: no recovery.worker.submit event row used a bare workflow id.');
