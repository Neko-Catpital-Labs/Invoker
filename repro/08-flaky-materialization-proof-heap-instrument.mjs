#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';

let SQLiteAdapter;
try {
  ({ SQLiteAdapter } = await import('../packages/data-store/dist/index.js'));
} catch (error) {
  console.error(`cannot load @invoker/data-store dist: ${error.message}`);
  console.error('run `pnpm --filter @invoker/data-store build` first');
  process.exit(2);
}

const WORKFLOW_COUNT = 5_000;
const THRESHOLD = 1_000_000;
const ITERATIONS = Number(process.env.REPRO_ITERATIONS ?? 12);

function seed(adapter, withPayload) {
  const payload = 'x'.repeat(256);
  for (let i = 0; i < WORKFLOW_COUNT; i += 1) {
    adapter.saveWorkflow({
      id: `wf-${i}`,
      name: `Workflow ${i} with a longer name to increase memory footprint`,
      description: withPayload
        ? `Description for workflow ${i}: ${payload}`
        : `Description for workflow ${i} that adds more bytes per row`,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}

async function sample(withPayload) {
  const dir = mkdtempSync(join(tmpdir(), 'repro-flaky-'));
  const adapter = await SQLiteAdapter.create(join(dir, 'invoker.db'), { ownerCapability: true });
  try {
    seed(adapter, withPayload);
    const before = process.memoryUsage().heapUsed;
    const workflows = adapter.listWorkflows();
    const after = process.memoryUsage().heapUsed;
    return { heapDelta: after - before, bytes: Buffer.byteLength(JSON.stringify(workflows)) };
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function report(label, values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const under = values.filter((v) => v < THRESHOLD).length;
  console.log(
    `${label.padEnd(22)} min=${min.toLocaleString().padStart(12)}  max=${max.toLocaleString().padStart(12)}  `
    + `spread=${(max - min).toLocaleString().padStart(12)}  runs_under_${THRESHOLD.toLocaleString()}=${under}/${values.length}`,
  );
  return under;
}

const heapDeltas = [];
const byteCounts = [];
for (let i = 0; i < ITERATIONS; i += 1) {
  const s = await sample(true);
  heapDeltas.push(s.heapDelta);
  byteCounts.push(s.bytes);
}

console.log(`repro: it.fails('listWorkflows materializes every row into JS objects')`);
console.log(`the block is GREEN only while its assertion THROWS, i.e. while the measured value is >= ${THRESHOLD.toLocaleString()}`);
console.log(`${ITERATIONS} iterations, ${WORKFLOW_COUNT.toLocaleString()} workflows each\n`);

const heapUnder = report('heapUsed delta (old)', heapDeltas);
const bytesUnder = report('serialized bytes (new)', byteCounts);

const heapSpread = Math.max(...heapDeltas) - Math.min(...heapDeltas);
const bytesSpread = Math.max(...byteCounts) - Math.min(...byteCounts);

console.log('');
let failures = 0;
if (bytesSpread !== 0) {
  console.log(`FAIL: serialized-byte instrument varied by ${bytesSpread.toLocaleString()} across runs; it must be constant`);
  failures += 1;
} else {
  console.log(`PASS: serialized-byte instrument is identical on every run (${byteCounts[0].toLocaleString()} bytes)`);
}
if (bytesUnder > 0) {
  console.log(`FAIL: serialized-byte instrument fell under the threshold ${bytesUnder} time(s); the block would go red`);
  failures += 1;
} else {
  console.log(`PASS: serialized-byte instrument never fell under the threshold, so the block cannot flake`);
}
if (heapSpread === 0) {
  console.log(`INCONCLUSIVE: heap instrument did not vary on this host; it is still not a guaranteed-stable measurement`);
} else {
  console.log(`OBSERVED: heap instrument varied by ${heapSpread.toLocaleString()} bytes across identical runs (${heapUnder} run(s) under the threshold)`);
}

process.exit(failures === 0 ? 0 : 1);
