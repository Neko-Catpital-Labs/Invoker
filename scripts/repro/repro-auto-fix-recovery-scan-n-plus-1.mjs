#!/usr/bin/env node
/**
 * Repro for the auto-fix recovery scan's N+1 query pattern.
 *
 * listAutoFixRecoveryScanCandidates() in
 * packages/execution-engine/src/auto-fix-recovery.ts used to call
 * store.loadTasks(id) once per workflow inside a loop over
 * store.listWorkflows() -- one SQL round trip per workflow, every scan
 * tick, even though it only keeps tasks with status 'failed'. On a
 * production host with hundreds of workflows this showed up as the
 * recovery worker's tick logging a skip line for every workflow, every
 * cycle, contending with everything else on the owner's single-threaded
 * synchronous SQLite connection.
 *
 * This inlines the pre-fix and post-fix scan loop -- semantically
 * identical to what lives in that file, verified by the real
 * "listAutoFixRecoveryScanCandidates" describe block in
 * packages/execution-engine/src/__tests__/auto-fix-recovery.test.ts --
 * against a call-counting mock store, and prints the real call pattern.
 *
 * Usage:
 *   node scripts/repro/repro-auto-fix-recovery-scan-n-plus-1.mjs before
 *   node scripts/repro/repro-auto-fix-recovery-scan-n-plus-1.mjs after
 *
 * Env knobs:
 *   WORKFLOW_COUNT (default 300) number of workflows in the mock store
 */

const WORKFLOW_COUNT = Number(process.env.WORKFLOW_COUNT ?? '300');
const mode = process.argv[2];
if (mode !== 'before' && mode !== 'after') {
  console.error('Usage: repro-auto-fix-recovery-scan-n-plus-1.mjs <before|after>');
  process.exit(2);
}

function makeTask(workflowId, index) {
  return {
    id: `${workflowId}/task-${index}`,
    status: index === 0 ? 'failed' : 'completed',
    config: { workflowId },
  };
}

function workflowIdForTask(task) {
  return task.config.workflowId ?? task.id.split('/')[0];
}

function groupTasksByWorkflowId(tasks) {
  const grouped = new Map();
  for (const task of tasks) {
    const workflowId = workflowIdForTask(task);
    if (!workflowId) continue;
    const existing = grouped.get(workflowId);
    if (existing) existing.push(task);
    else grouped.set(workflowId, [task]);
  }
  return grouped;
}

// Pre-fix: one store.loadTasks(id) call per workflow inside the loop.
function scanBefore(store) {
  const candidates = [];
  for (const workflow of store.listWorkflows()) {
    for (const task of store.loadTasks(workflow.id)) {
      if (task.status !== 'failed') continue;
      candidates.push(task);
    }
  }
  return candidates;
}

// Post-fix: one batched store.loadTasksForWorkflows(ids) call.
function scanAfter(store) {
  const candidates = [];
  const workflows = store.listWorkflows();
  const tasksByWorkflow = groupTasksByWorkflowId(store.loadTasksForWorkflows(workflows.map((w) => w.id)));
  for (const workflow of workflows) {
    for (const task of tasksByWorkflow.get(workflow.id) ?? []) {
      if (task.status !== 'failed') continue;
      candidates.push(task);
    }
  }
  return candidates;
}

const workflows = Array.from({ length: WORKFLOW_COUNT }, (_, i) => ({ id: `wf-${i}` }));
const tasksByWorkflow = new Map(workflows.map((wf) => [wf.id, [makeTask(wf.id, 0), makeTask(wf.id, 1)]]));

let loadTasksCalls = 0;
let loadTasksForWorkflowsCalls = 0;

const store = {
  listWorkflows: () => workflows,
  loadTasks: (workflowId) => {
    loadTasksCalls += 1;
    return tasksByWorkflow.get(workflowId) ?? [];
  },
  loadTasksForWorkflows: (workflowIds) => {
    loadTasksForWorkflowsCalls += 1;
    return workflowIds.flatMap((id) => tasksByWorkflow.get(id) ?? []);
  },
};

const candidates = mode === 'before' ? scanBefore(store) : scanAfter(store);

console.log(`mode=${mode} workflows=${WORKFLOW_COUNT}`);
console.log(`loadTasks calls=${loadTasksCalls}`);
console.log(`loadTasksForWorkflows calls=${loadTasksForWorkflowsCalls}`);
console.log(`candidates found=${candidates.length}`);

if (candidates.length !== WORKFLOW_COUNT) {
  console.error(`FAIL: expected ${WORKFLOW_COUNT} failed-task candidates, got ${candidates.length}`);
  process.exit(1);
}

if (mode === 'after') {
  if (loadTasksForWorkflowsCalls === 1 && loadTasksCalls === 0) {
    console.log('PASS: batched -- exactly 1 loadTasksForWorkflows call, 0 per-workflow loadTasks calls.');
    process.exit(0);
  }
  console.error(`FAIL: expected batched call pattern, got loadTasks=${loadTasksCalls} loadTasksForWorkflows=${loadTasksForWorkflowsCalls}`);
  process.exit(1);
}

// mode === 'before': demonstrate the bug -- this is EXPECTED to "pass" by
// reproducing the N+1 pattern (exit 0 here means the bug reproduced).
if (loadTasksCalls === WORKFLOW_COUNT && loadTasksForWorkflowsCalls === 0) {
  console.log(`REPRODUCED: N+1 pattern -- ${loadTasksCalls} separate loadTasks calls, one per workflow.`);
  process.exit(0);
}
console.error(`FAIL: unexpected call pattern for 'before' mode (loadTasks=${loadTasksCalls}, loadTasksForWorkflows=${loadTasksForWorkflowsCalls})`);
process.exit(1);
