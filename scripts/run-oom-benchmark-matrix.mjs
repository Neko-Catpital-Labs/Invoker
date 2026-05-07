#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'benchmarks', 'oom');

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  return d.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function parsePeakMetric(log, fieldName) {
  const regex = new RegExp(`${fieldName}=(\\d+\\.\\d+)MB`, 'g');
  let match;
  let peak = 0;
  while ((match = regex.exec(log)) !== null) {
    peak = Math.max(peak, Number(match[1]));
  }
  return Number(peak.toFixed(1));
}

function parseDbGrowthRateMbPerMin(log, elapsedMs) {
  const regex = /db-on-disk=(\d+\.\d+)MB/g;
  let match;
  let maxDb = 0;
  while ((match = regex.exec(log)) !== null) {
    maxDb = Math.max(maxDb, Number(match[1]));
  }
  if (elapsedMs <= 0) return 0;
  return Number(((maxDb / elapsedMs) * 60000).toFixed(2));
}

function parseSummary(log) {
  const line = log.split('\n').find((l) => l.startsWith('[repro-summary] '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('[repro-summary] '.length));
  } catch {
    return null;
  }
}

function runOne(mode, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const result = spawnSync('./scripts/run-oom-repro.sh', [mode], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });

  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const summary = parseSummary(log);
  const elapsedMs = summary?.elapsedMs ?? 0;
  const peakRssMb = parsePeakMetric(log, 'rss');
  const peakExternalMb = parsePeakMetric(log, 'external');
  const dbGrowthRateMbPerMin = parseDbGrowthRateMbPerMin(log, elapsedMs);
  const metrics = {
    mode,
    exitCode: result.status ?? -1,
    elapsedMs,
    elapsedSec: Number((elapsedMs / 1000).toFixed(2)),
    status: summary?.status ?? (result.status === 0 ? 'completed' : 'failed'),
    failureReason: summary?.failureReason ?? null,
    peakRssMb,
    peakExternalMb,
    flushCount: summary?.flushCount ?? 0,
    meanFlushIntervalMs: summary?.meanFlushIntervalMs ?? null,
    dbGrowthRateMbPerMin,
    leaseRenewWritesPerSec: summary?.leaseRenewWritesPerSec ?? 0,
    mutationThroughputPerSec: summary?.mutationThroughputPerSec ?? 0,
  };
  return { metrics, log };
}

function writeMarkdown(outPath, runLabel, commit, results) {
  const lines = [];
  lines.push(`# OOM Benchmark Matrix: ${runLabel}`);
  lines.push('');
  lines.push(`- Commit: \`${commit}\``);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('| mode | status | time-to-failure/completion (s) | peak RSS (MB) | peak external (MB) | flush count | mean flush interval (ms) | db growth (MB/min) | lease renew writes/sec | mutation throughput (intents/sec) |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of results) {
    lines.push(`| ${r.mode} | ${r.status} | ${r.elapsedSec} | ${r.peakRssMb} | ${r.peakExternalMb} | ${r.flushCount} | ${r.meanFlushIntervalMs ?? 'n/a'} | ${r.dbGrowthRateMbPerMin} | ${r.leaseRenewWritesPerSec} | ${r.mutationThroughputPerSec} |`);
  }
  lines.push('');
  lines.push('## Failure Reasons');
  lines.push('');
  for (const r of results) {
    lines.push(`- ${r.mode}: ${r.failureReason ?? 'none'}`);
  }
  lines.push('');
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`);
}

function main() {
  const runLabel = process.argv[2] ?? 'baseline';
  ensureOutDir();
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const stamp = nowStamp();

  const safe = runOne('safe', {
    REPRO_TIMEOUT_SEC: process.env.REPRO_TIMEOUT_SEC ?? '20',
    REPRO_MAX_DB_MB: process.env.REPRO_MAX_DB_MB ?? '220',
  });
  const sandbox = runOne('sandbox', {
    REPRO_DOCKER_MEMORY: process.env.REPRO_DOCKER_MEMORY ?? '768m',
    REPRO_NODE_HEAP_MB: process.env.REPRO_NODE_HEAP_MB ?? '256',
    REPRO_TIMEOUT_SEC: process.env.REPRO_TIMEOUT_SEC ?? '20',
  });

  const results = [safe.metrics, sandbox.metrics];
  const base = `${stamp}-${runLabel}`;
  const jsonPath = path.join(OUT_DIR, `${base}.json`);
  const mdPath = path.join(OUT_DIR, `${base}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify({ runLabel, commit, results }, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT_DIR, `${base}-safe.log`), safe.log);
  fs.writeFileSync(path.join(OUT_DIR, `${base}-sandbox.log`), sandbox.log);
  writeMarkdown(mdPath, runLabel, commit, results);
  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);
}

main();
