#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claims, evaluateDirectory, sha256 } from '../evals/db-maintenance-starvation.eval.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const repro = join(root, 'scripts/repro/repro-db-maintenance-starvation.mjs');
export function makeHarness(source, rows) {
  assert.ok(Number.isSafeInteger(rows) && rows > 0, 'invalid workload');
  const replaceOnce = (text, from, to) => {
    assert.equal(text.split(from).length, 2, `repro contract changed: ${from}`);
    return text.replace(from, to);
  };
  let harness = replaceOnce(source, 'WHERE x < 25000)', `WHERE x < ${rows})`);
  harness = replaceOnce(harness, 'createRequire(import.meta.url)', `createRequire(${JSON.stringify(pathToFileURL(repro).href)})`);
  for (const module of ['packages/data-store/src/sqlite-adapter.ts', 'packages/execution-engine/src/workers/db-reaper-worker.ts']) {
    harness = replaceOnce(harness, `new URL('../../${module}', import.meta.url)`,
      `new URL(${JSON.stringify(pathToFileURL(join(root, module)).href)})`);
  }
  return harness;
}

function main() {
  const options = { trials: '5', sizes: '1000,25000,100000',
    output: join(root, '.invoker', `db-maintenance-benchmark-${Date.now()}`) };
  for (const arg of process.argv.slice(2)) {
    const match = /^--(trials|sizes|output)=(.+)$/.exec(arg);
    assert.ok(match, `unknown option: ${arg}`);
    options[match[1]] = match[2];
  }
  const trials = Number(options.trials);
  const sizes = options.sizes.split(',').map(Number);
  assert.ok(Number.isSafeInteger(trials) && trials >= 5, 'at least five pairs per size');
  assert.ok(sizes.length >= 2 && new Set(sizes).size === sizes.length
    && sizes.every((n) => Number.isSafeInteger(n) && n > 0), 'at least two distinct positive sizes');
  const directory = resolve(options.output);
  mkdirSync(dirname(directory), { recursive: true });
  mkdirSync(directory);
  console.log(`Evidence: ${directory}`);
  const save = (name, data) => {
    writeFileSync(join(directory, name), data);
    return { file: name, sha256: sha256(data) };
  };
  const source = readFileSync(repro, 'utf8');
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
  const manifest = { schema: 1, claims, trials, sizes,
    revision: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']),
    node: process.version, platform: process.platform, arch: process.arch,
    source: save('repro-source.mjs', source), harnesses: [], runs: [],
    runtime_sources: ['packages/data-store/src/sqlite-adapter.ts',
      'packages/execution-engine/src/workers/db-reaper-worker.ts'].map((file) => ({
      file, sha256: sha256(readFileSync(join(root, file))),
    })), baseline: 'Existing --mode=before replay of recorded synchronous FULL checkpoint; not a historical checkout.' };
  const writeManifest = () => save('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  writeManifest();
  for (const rows of sizes) {
    const harness = save(`harness-${rows}.mjs`, makeHarness(source, rows));
    manifest.harnesses.push({ rows, ...harness });
    for (let trial = 1; trial <= trials; trial++) {
      for (const mode of trial % 2 ? ['before', 'after'] : ['after', 'before']) {
        const prefix = `${rows}-${trial}-${mode}`;
        const child = spawnSync(process.execPath, [join(directory, harness.file), `--mode=${mode}`], {
          cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
        });
        const stdout = save(`${prefix}.jsonl`, child.stdout ?? '');
        const stderr = save(`${prefix}.stderr`, child.stderr ?? '');
        manifest.runs.push({ rows, trial, mode, exit_code: child.status, signal: child.signal,
          error: child.error?.message ?? null, trace: stdout.file, trace_sha256: stdout.sha256,
          stderr: stderr.file, stderr_sha256: stderr.sha256 });
        writeManifest();
        console.log(`${prefix}: exit code ${child.status}${child.error ? ` (${child.error.message})` : ''}`);
      }
    }
  }
  const report = evaluateDirectory(directory);
  save('report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ metrics: report.metrics, limitations: report.limitations,
    sensitivity: report.sensitivity }, null, 2));
  console.log('exit code 0');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(error.stack);
    console.log('exit code 1');
    process.exitCode = 1;
  }
}
