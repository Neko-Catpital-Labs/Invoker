#!/usr/bin/env node
/**
 * Benchmark repro for the applyDelta per-batch allocation issue.
 *
 * Before the fix, useTasks applied each TaskDelta in a coalesced batch with
 * a fresh `new Map(tasks)` allocation. For a burst of N deltas over a task
 * set of size T, that is N × O(T) copies inside the React render path.
 *
 * This repro inlines the two implementations (the pre-fix per-delta
 * allocator and the post-fix batched allocator) — semantically identical
 * to what lives in packages/ui/src/lib/delta.ts, verified by
 * packages/ui/src/__tests__/delta-batch.test.ts — and times each end to
 * end for `ITERATIONS` batches. Prints wall-clock ms and the ratio.
 * Exits non-zero if the batched variant is not meaningfully faster.
 *
 * Env knobs:
 *   TASKS         (default 1000)   size of the task map
 *   BATCH_SIZE    (default 50)     deltas per batch
 *   ITERATIONS    (default 200)    number of batches to time
 *   MIN_SPEEDUP   (default 2.0)    baseline_ms / batched_ms must exceed this
 */

import { performance } from 'node:perf_hooks';

const TASKS = Number(process.env.TASKS ?? '1000');
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? '50');
const ITERATIONS = Number(process.env.ITERATIONS ?? '200');
const MIN_SPEEDUP = Number(process.env.MIN_SPEEDUP ?? '2.0');

function applyDeltaInPlace(target, delta) {
  switch (delta.type) {
    case 'created':
      target.set(delta.task.id, delta.task);
      break;
    case 'updated': {
      const existing = target.get(delta.taskId);
      if (existing) {
        const { config: cfgChanges, execution: execChanges, ...topLevel } = delta.changes;
        target.set(delta.taskId, {
          ...existing,
          ...topLevel,
          config: { ...existing.config, ...cfgChanges },
          execution: { ...existing.execution, ...execChanges },
        });
      }
      break;
    }
    case 'removed':
      target.delete(delta.taskId);
      break;
  }
}

function applyDeltaBaseline(tasks, delta) {
  const next = new Map(tasks);
  applyDeltaInPlace(next, delta);
  return next;
}

function applyDeltasBatched(tasks, deltas) {
  if (deltas.length === 0) return tasks;
  const next = new Map(tasks);
  for (const delta of deltas) applyDeltaInPlace(next, delta);
  return next;
}

function makeTask(id) {
  return {
    id,
    description: `task ${id}`,
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { command: 'true' },
    execution: {},
  };
}

function seedTasks(size) {
  const map = new Map();
  for (let i = 0; i < size; i += 1) {
    const id = `task-${i}`;
    map.set(id, makeTask(id));
  }
  return map;
}

function makeBatch(size, taskCount) {
  const batch = [];
  for (let i = 0; i < size; i += 1) {
    const id = `task-${i % taskCount}`;
    batch.push({ type: 'updated', taskId: id, changes: { status: 'running' } });
  }
  return batch;
}

function timeMs(fn) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

const seed = seedTasks(TASKS);
const batch = makeBatch(BATCH_SIZE, TASKS);

for (let i = 0; i < 5; i += 1) {
  let m = seed;
  for (const d of batch) m = applyDeltaBaseline(m, d);
  applyDeltasBatched(seed, batch);
}

let baselineMs = 0;
let batchedMs = 0;

for (let i = 0; i < ITERATIONS; i += 1) {
  baselineMs += timeMs(() => {
    let m = seed;
    for (const d of batch) m = applyDeltaBaseline(m, d);
    return m;
  });
  batchedMs += timeMs(() => applyDeltasBatched(seed, batch));
}

const speedup = baselineMs / batchedMs;

console.log('repro-summary:');
console.log(`  tasks:         ${TASKS}`);
console.log(`  batch size:    ${BATCH_SIZE}`);
console.log(`  iterations:    ${ITERATIONS}`);
console.log(`  baseline:      ${baselineMs.toFixed(1)}ms total (${(baselineMs / ITERATIONS).toFixed(3)}ms per batch)`);
console.log(`  batched:       ${batchedMs.toFixed(1)}ms total (${(batchedMs / ITERATIONS).toFixed(3)}ms per batch)`);
console.log(`  speedup:       ${speedup.toFixed(2)}x`);
console.log(`  min required:  ${MIN_SPEEDUP.toFixed(2)}x`);

if (speedup < MIN_SPEEDUP) {
  console.error(
    `repro: FAIL -- batched apply was only ${speedup.toFixed(2)}x faster (min ${MIN_SPEEDUP.toFixed(2)}x). ` +
      'The per-batch allocation regression may be back.',
  );
  process.exit(1);
}

console.log(`repro: PASS -- batched apply is ${speedup.toFixed(2)}x faster than per-delta apply`);
