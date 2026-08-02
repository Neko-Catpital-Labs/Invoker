#!/usr/bin/env node
/**
 * REPRO Issue 6 — "Merge gate execution was stopped before completion" is a
 * SHUTDOWN/crash symptom, not a merge-gate logic failure.
 *
 * Proof:
 *   (a) source: the exact string is emitted only from MergeGateExecutor.destroyAll()
 *       — the executor-teardown path invoked during owner shutdown/crash.
 *   (b) data: the in-flight __merge__ task carried that error, exit 1, phase
 *       executing — i.e. it was aborted mid-flight, same as the other orphans.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assert, done } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const STOP = 'Merge gate execution was stopped before completion';

// (a) the message originates in destroyAll() (teardown), not normal gate eval
const src = readFileSync(
  path.join(repoRoot, 'packages/execution-engine/src/merge-gate-executor.ts'), 'utf8');
const destroyAllIdx = src.indexOf('async destroyAll(');
const stopIdx = src.indexOf(STOP);
const nextMethodIdx = src.indexOf('\n  private ', destroyAllIdx);
assert(
  'stop message is emitted from MergeGateExecutor.destroyAll() (shutdown teardown)',
  destroyAllIdx !== -1 && stopIdx > destroyAllIdx
    && (nextMethodIdx === -1 || stopIdx < nextMethodIdx),
  [`destroyAll() at char ${destroyAllIdx}, stop-emit at char ${stopIdx}`],
);
assert(
  'destroyAll only fails entries that are NOT completed (in-flight abort)',
  /if \(!entry\.completed\) \{[\s\S]*?killed = true/.test(src),
);

// (b) the real __merge__ task was aborted with exactly this error
const tasks = JSON.parse(readFileSync(
  path.join(here, 'fixtures', 'task-merge-gate-stopped-wf-1785622640581-20.json'), 'utf8'));
const merge = tasks.find(t => t.id.startsWith('__merge__') && t.status === 'failed');
assert(
  'in-flight __merge__ task was aborted with the shutdown stop error',
  merge && merge.execution.error === STOP && merge.execution.exitCode === 1
    && merge.execution.phase === 'executing',
  [`${merge?.id}: error="${merge?.execution?.error}" phase=${merge?.execution?.phase}`],
);

done('merge-gate "stopped before completion" = executor teardown during the crash, not a gate failure');
