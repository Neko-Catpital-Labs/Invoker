#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const dataStoreDistPath = join(root, 'packages/data-store/dist/index.js');
const appDiagnosticsDistPath = join(root, 'packages/app/dist/action-graph-diagnostics.js');
const uiSelectorDistPath = join(root, 'packages/ui/dist/lib/workflow-core-activity.js');

const workflowId = 'wf-status-truth';
const taskId = 'wf-status-truth/task-a';
const attemptId = 'wf-status-truth/task-a-attempt-1';
const nowIso = '2026-06-22T10:00:12.000Z';
const intentStartedAt = '2026-06-22T10:00:00.000Z';
const dispatchEnqueuedAt = '2026-06-22T10:00:07.000Z';
const rejectedCardLine = 'Running: invoker:rebase-recreate';
const requiredCardLine = 'Pending: queued for launch';

function usage() {
  return [
    'Usage: repro-workflow-mutation-status-source-of-truth.mjs (--expect-bug|--expect-fixed) [--iterations <n>] [--json]',
    '',
    'Options:',
    '  --expect-bug      Assert the rejected mutation-label card rule wins.',
    '  --expect-fixed    Assert the built UI selector returns core launch state.',
    '  --iterations <n>  Projection benchmark iterations. Default: 50.',
    '  --json            Print only the final JSON report.',
  ].join('\n');
}

function parseArgs(argv) {
  let expectation;
  let iterations = 50;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--expect-bug') {
      expectation = expectation === 'fixed' ? 'both' : 'bug';
      continue;
    }
    if (arg === '--expect-fixed') {
      expectation = expectation === 'bug' ? 'both' : 'fixed';
      continue;
    }
    if (arg === '--iterations') {
      const raw = argv[index + 1];
      index += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--iterations must be a positive integer, got ${raw ?? '(missing)'}`);
      }
      iterations = parsed;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (expectation === 'both') throw new Error('Choose exactly one of --expect-bug or --expect-fixed.');
  if (!expectation) throw new Error(`Missing expectation.\n${usage()}`);
  return { expectation, iterations, json };
}

function fail(message) {
  throw new Error(`[workflow-mutation-status-source-of-truth] ${message}`);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(3));
}

function makeTask() {
  return {
    id: taskId,
    description: 'workflow status truth task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(nowIso),
    config: { workflowId },
    execution: {
      phase: 'launching',
      selectedAttemptId: attemptId,
      generation: 0,
    },
    taskStateVersion: 1,
  };
}

function makeAttempt() {
  return {
    id: attemptId,
    nodeId: taskId,
    queuePriority: 1,
    status: 'claimed',
    upstreamAttemptIds: [],
    createdAt: new Date(nowIso),
    claimedAt: new Date(dispatchEnqueuedAt),
  };
}

function oldRejectedCardRule(nodes) {
  const intent = nodes.find((node) => (
    node.workflowId === workflowId &&
    node.type === 'mutation-intent' &&
    node.status === 'running'
  ));
  if (!intent) return undefined;
  return `Running: ${intent.label}`;
}

function localCoreActivityRule(nodes) {
  const dispatch = nodes.find((node) => (
    node.workflowId === workflowId &&
    node.type === 'launch-dispatch' &&
    node.status === 'queued'
  ));
  return dispatch ? requiredCardLine : undefined;
}

function assertNode(graph, id, checks) {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) fail(`missing action graph node ${id}`);
  for (const [key, expected] of Object.entries(checks)) {
    const actual = key.split('.').reduce((value, part) => value?.[part], node);
    if (actual !== expected) {
      fail(`${id}.${key} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  return node;
}

function collectGraphInputs(adapter) {
  const snapshot = adapter.loadWorkflowTaskSnapshot();
  return {
    workflows: snapshot.workflows,
    tasks: snapshot.tasks,
    attemptsByTaskId: new Map(snapshot.tasks.map((task) => [task.id, adapter.loadAttempts(task.id)])),
    queueStatus: { maxConcurrency: 1, running: [], queued: [] },
    mutationIntents: adapter.listWorkflowMutationIntents(undefined, ['queued', 'running', 'failed']),
    mutationLeases: adapter.listWorkflowMutationLeases(),
    eventsByTaskId: new Map(snapshot.tasks.map((task) => [task.id, adapter.getEvents(task.id, 'desc', 20)])),
    activityLogs: adapter.getActivityLogs(0, 200),
    stallThresholdMs: 60_000,
    launchDispatches: adapter.listLaunchDispatchesByState(['enqueued', 'leased']),
    now: new Date(nowIso),
  };
}

async function seedGraph(SQLiteAdapter, buildActionGraphDiagnostics) {
  const tempDir = mkdtempSync(join(tmpdir(), 'invoker-workflow-mutation-status-repro-'));
  const dbPath = join(tempDir, 'invoker.db');
  let adapter;
  try {
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    adapter.saveWorkflow({
      id: workflowId,
      name: 'workflow status truth repro',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    adapter.saveTask(workflowId, makeTask());
    adapter.updateTask(taskId, {
      status: 'pending',
      execution: {
        phase: 'launching',
        selectedAttemptId: attemptId,
        generation: 0,
      },
    });
    adapter.saveAttempt(makeAttempt());
    const intentId = adapter.enqueueWorkflowMutationIntent(
      workflowId,
      'invoker:rebase-recreate',
      [workflowId],
      'high',
    );
    adapter.db.run(
      `UPDATE workflow_mutation_intents
          SET status = 'running',
              started_at = ?,
              owner_id = ?
        WHERE id = ?`,
      [intentStartedAt, 'repro-owner', intentId],
    );
    const dispatch = adapter.enqueueLaunchDispatch({
      taskId,
      attemptId,
      workflowId,
      priority: 'high',
      generation: 0,
    });
    adapter.db.run(
      `UPDATE task_launch_dispatch
          SET enqueued_at = ?
        WHERE id = ?`,
      [dispatchEnqueuedAt, dispatch.id],
    );
    const inputs = collectGraphInputs(adapter);
    const graph = buildActionGraphDiagnostics(inputs);
    return { tempDir, adapter, inputs, graph, intentId, dispatchId: dispatch.id };
  } catch (error) {
    adapter?.close();
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(dataStoreDistPath) || !existsSync(appDiagnosticsDistPath)) {
    fail('built data-store/app modules are not available yet; run pnpm --filter @invoker/data-store build and pnpm --filter @invoker/app build');
  }
  const { SQLiteAdapter } = await import(pathToFileURL(dataStoreDistPath).href);
  const { buildActionGraphDiagnostics } = await import(pathToFileURL(appDiagnosticsDistPath).href);
  const seeded = await seedGraph(SQLiteAdapter, buildActionGraphDiagnostics);
  try {
    const intentNode = assertNode(seeded.graph, `intent:${seeded.intentId}`, {
      type: 'mutation-intent',
      status: 'running',
      label: 'invoker:rebase-recreate',
      'durations.runningMs': 12_000,
    });
    assertNode(seeded.graph, `launch-dispatch:${seeded.dispatchId}`, {
      type: 'launch-dispatch',
      status: 'queued',
      'durations.queuedMs': 5_000,
    });
    assertNode(seeded.graph, `attempt:${attemptId}`, {
      type: 'task-attempt',
      status: 'pending',
      'details.taskStatus': 'pending',
    });

    const oldLine = oldRejectedCardRule(seeded.graph.nodes);
    let selectCoreActivity = (nodes) => ({ label: localCoreActivityRule(nodes) });
    if (options.expectation === 'fixed') {
      if (!existsSync(uiSelectorDistPath)) {
        fail('fixed selector is not available yet; run pnpm --filter @invoker/ui build after implementing Step 5');
      }
      const selectorModule = await import(pathToFileURL(uiSelectorDistPath).href);
      if (typeof selectorModule.selectWorkflowCoreActivity !== 'function') {
        fail('fixed selector is not available yet; run pnpm --filter @invoker/ui build after implementing Step 5');
      }
      selectCoreActivity = (nodes) => selectorModule.selectWorkflowCoreActivity(nodes, workflowId);
    }

    if (options.expectation === 'bug' && oldLine !== rejectedCardLine) {
      fail(`expected rejected card rule to return ${rejectedCardLine}, got ${oldLine ?? '(none)'}`);
    }
    if (options.expectation === 'fixed') {
      const selected = selectCoreActivity(seeded.graph.nodes);
      if (selected?.label !== requiredCardLine) {
        fail(`expected fixed selector to return ${requiredCardLine}, got ${selected?.label ?? '(none)'}`);
      }
      if (selected.label.includes(String(intentNode.label))) {
        fail('fixed selector leaked the mutation command label into workflow-card copy');
      }
    }

    const buildTimes = [];
    const selectTimes = [];
    for (let index = 0; index < options.iterations; index += 1) {
      const buildStarted = performance.now();
      const graph = buildActionGraphDiagnostics(seeded.inputs);
      buildTimes.push(performance.now() - buildStarted);
      const selectStarted = performance.now();
      if (options.expectation === 'bug') oldRejectedCardRule(graph.nodes);
      else selectCoreActivity(graph.nodes);
      selectTimes.push(performance.now() - selectStarted);
    }

    const report = {
      expectation: options.expectation,
      workflowId,
      timelineMs: {
        mutationIntentRunningAgeMs: 12_000,
        launchDispatchQueuedAgeMs: 5_000,
        taskStillPending: true,
      },
      rejectedCardLine,
      requiredCardLine,
      projectionBenchmarkMs: {
        iterations: options.iterations,
        actionGraphBuildP50: percentile(buildTimes, 50),
        actionGraphBuildP95: percentile(buildTimes, 95),
        coreActivitySelectP50: percentile(selectTimes, 50),
        coreActivitySelectP95: percentile(selectTimes, 95),
      },
    };

    if (options.json) {
      console.log(JSON.stringify(report));
    } else {
      console.log(JSON.stringify(report, null, 2));
      console.log(`[workflow-mutation-status-source-of-truth] ${options.expectation} expectation passed`);
    }
  } finally {
    seeded.adapter.close();
    rmSync(seeded.tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
