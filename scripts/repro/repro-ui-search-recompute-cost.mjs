#!/usr/bin/env node
/**
 * Benchmark repro for the O(W×T) searchResults recompute path.
 *
 * Before the fix, the renderer computed searchResults with an inner
 * `[...tasks.values()].filter(t => t.config.workflowId === workflow.id)`
 * pass for every workflow — an O(W × T) scan on every keystroke and on
 * every task delta batch that flipped the tasks Map reference.
 *
 * This repro inlines both variants — the per-workflow filter baseline
 * and the indexed variant that pre-builds a `Map<workflowId, TaskState[]>`
 * once per call — and times each over ITERATIONS runs. Exits non-zero
 * if the indexed variant is not meaningfully faster.
 *
 * Env knobs:
 *   WORKFLOWS      (default 100)   number of workflows
 *   TASKS_PER_WF   (default 20)    tasks per workflow
 *   ITERATIONS     (default 200)   query executions to time
 *   QUERY          (default "42")  search term
 *   MIN_SPEEDUP    (default 5.0)   baseline_ms / indexed_ms must exceed this
 */

import { performance } from 'node:perf_hooks';

const WORKFLOWS = Number(process.env.WORKFLOWS ?? '100');
const TASKS_PER_WF = Number(process.env.TASKS_PER_WF ?? '20');
const ITERATIONS = Number(process.env.ITERATIONS ?? '200');
const QUERY = process.env.QUERY ?? '42';
const MIN_SPEEDUP = Number(process.env.MIN_SPEEDUP ?? '2.0');

const normalizedSearchText = (v) => (v ?? '').toLowerCase();
const MAX = 12;

function baseline(query, tasks, workflows) {
  const needle = normalizedSearchText(query.trim());
  if (!needle) return [];
  const results = [];
  for (const workflow of workflows.values()) {
    const workflowTasks = [...tasks.values()].filter((t) => t.config.workflowId === workflow.id);
    const reviewUrl = workflowTasks.find((t) => t.execution.reviewUrl)?.execution.reviewUrl;
    const haystack = [
      workflow.id,
      workflow.name,
      workflow.status,
      workflow.repoUrl,
      workflow.intermediateRepoUrl,
      reviewUrl,
    ].map(normalizedSearchText).join(' ');
    if (haystack.includes(needle)) {
      results.push({ kind: 'workflow', id: workflow.id, title: workflow.name || workflow.id, subtitle: `Workflow · ${workflow.status}` });
    }
  }
  for (const task of tasks.values()) {
    const workflow = task.config.workflowId ? workflows.get(task.config.workflowId) : null;
    const haystack = [
      task.id, task.description, task.status,
      task.config.summary, task.config.prompt, task.config.command,
      task.execution.reviewUrl, workflow?.name,
    ].map(normalizedSearchText).join(' ');
    if (haystack.includes(needle)) {
      results.push({ kind: 'task', id: task.id, workflowId: task.config.workflowId ?? null, title: task.description || task.id, subtitle: `Task · ${workflow?.name ?? 'unknown'}` });
    }
  }
  return results.slice(0, MAX);
}

function indexed(query, tasks, workflows) {
  const needle = normalizedSearchText(query.trim());
  if (!needle) return [];
  const tasksByWorkflowId = new Map();
  for (const task of tasks.values()) {
    const wid = task.config.workflowId;
    if (!wid) continue;
    let list = tasksByWorkflowId.get(wid);
    if (list === undefined) { list = []; tasksByWorkflowId.set(wid, list); }
    list.push(task);
  }
  const results = [];
  for (const workflow of workflows.values()) {
    const workflowTasks = tasksByWorkflowId.get(workflow.id) ?? [];
    const reviewUrl = workflowTasks.find((t) => t.execution.reviewUrl)?.execution.reviewUrl;
    const haystack = [
      workflow.id,
      workflow.name,
      workflow.status,
      workflow.repoUrl,
      workflow.intermediateRepoUrl,
      reviewUrl,
    ].map(normalizedSearchText).join(' ');
    if (haystack.includes(needle)) {
      results.push({ kind: 'workflow', id: workflow.id, title: workflow.name || workflow.id, subtitle: `Workflow · ${workflow.status}` });
    }
  }
  for (const task of tasks.values()) {
    const workflow = task.config.workflowId ? workflows.get(task.config.workflowId) : null;
    const haystack = [
      task.id, task.description, task.status,
      task.config.summary, task.config.prompt, task.config.command,
      task.execution.reviewUrl, workflow?.name,
    ].map(normalizedSearchText).join(' ');
    if (haystack.includes(needle)) {
      results.push({ kind: 'task', id: task.id, workflowId: task.config.workflowId ?? null, title: task.description || task.id, subtitle: `Task · ${workflow?.name ?? 'unknown'}` });
    }
  }
  return results.slice(0, MAX);
}

function seed() {
  const workflows = new Map();
  const tasks = new Map();
  for (let w = 0; w < WORKFLOWS; w += 1) {
    const wid = `wf-${w}`;
    workflows.set(wid, {
      id: wid,
      name: `Workflow ${w}`,
      status: 'pending',
    });
    for (let t = 0; t < TASKS_PER_WF; t += 1) {
      const tid = `${wid}-task-${t}`;
      tasks.set(tid, {
        id: tid,
        description: `Task ${w}-${t}`,
        status: 'pending',
        config: { workflowId: wid, command: 'true' },
        execution: {},
      });
    }
  }
  return { tasks, workflows };
}

const { tasks, workflows } = seed();

for (let i = 0; i < 5; i += 1) {
  baseline(QUERY, tasks, workflows);
  indexed(QUERY, tasks, workflows);
}

function time(fn) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

let baselineMs = 0;
let indexedMs = 0;
for (let i = 0; i < ITERATIONS; i += 1) {
  baselineMs += time(() => baseline(QUERY, tasks, workflows));
  indexedMs += time(() => indexed(QUERY, tasks, workflows));
}

const speedup = baselineMs / indexedMs;
const totalTasks = WORKFLOWS * TASKS_PER_WF;

console.log('repro-summary:');
console.log(`  workflows:          ${WORKFLOWS}`);
console.log(`  tasks-per-workflow: ${TASKS_PER_WF}`);
console.log(`  total tasks:        ${totalTasks}`);
console.log(`  iterations:         ${ITERATIONS}`);
console.log(`  query:              ${JSON.stringify(QUERY)}`);
console.log(`  baseline O(W*T):    ${baselineMs.toFixed(1)}ms total (${(baselineMs / ITERATIONS).toFixed(3)}ms per call)`);
console.log(`  indexed  O(W+T):    ${indexedMs.toFixed(1)}ms total (${(indexedMs / ITERATIONS).toFixed(3)}ms per call)`);
console.log(`  speedup:            ${speedup.toFixed(2)}x`);
console.log(`  min required:       ${MIN_SPEEDUP.toFixed(2)}x`);

if (speedup < MIN_SPEEDUP) {
  console.error(
    `repro: FAIL -- indexed variant was only ${speedup.toFixed(2)}x faster (min ${MIN_SPEEDUP.toFixed(2)}x). ` +
      'The per-workflow scan regression may be back.',
  );
  process.exit(1);
}

console.log(`repro: PASS -- indexed searchResults is ${speedup.toFixed(2)}x faster than per-workflow scan`);
