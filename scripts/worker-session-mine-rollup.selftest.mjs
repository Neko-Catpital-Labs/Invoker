#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MINER = join(__dirname, 'worker-session-mine.mjs');
const FIXTURES_DIR = join(__dirname, 'fixtures', 'agentic-context-score');

const fixtures = [
  { sessionId: 'claude-explore-first', agentName: 'claude', file: 'claude-explore-first.jsonl' },
  { sessionId: 'claude-oriented-edit', agentName: 'claude', file: 'claude-oriented-edit.jsonl' },
  { sessionId: 'codex-explore-first', agentName: 'codex', file: 'codex-explore-first.jsonl' },
  { sessionId: 'codex-oriented-edit', agentName: 'codex', file: 'codex-oriented-edit.jsonl' },
];

const failures = [];
function check(label, condition, detail) {
  if (condition) return;
  failures.push(`${label}: ${detail}`);
}

const root = mkdtempSync(join(tmpdir(), 'session-mine-rollup-selftest-'));

try {
  const inventoryPath = join(root, 'inventory.json');
  const metricsPath = join(root, 'metrics.jsonl');
  const inventory = fixtures.map((fixture) => ({
    workflowName: 'CI regression: agentic-context-score',
    sessionId: fixture.sessionId,
    agentName: fixture.agentName,
    status: 'failed',
    path: join(FIXTURES_DIR, fixture.file),
  }));
  mkdirSync(join(root, 'home'), { recursive: true });
  writeFileSync(inventoryPath, JSON.stringify({ sessions: inventory }, null, 2));

  const result = spawnSync('node', [MINER], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: join(root, 'home'),
      INVOKER_SESSION_MINE_INVENTORY_JSON: inventoryPath,
      INVOKER_SESSION_MINE_STATE_DIR: join(root, 'state'),
      INVOKER_AGENTIC_CONTEXT_METRICS_PATH: metricsPath,
      CATSTACK_ROOT: '',
    },
  });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  check('miner-exits-0', result.status === 0, `exit=${result.status}\n${out}`);
  check('no-thrash-followups-filed', /session-mine: filed 0/.test(out), `expected no workflow filing, got:\n${out}`);
  check('metrics-file-created', existsSync(metricsPath), 'expected metrics.jsonl to be written');

  const lines = existsSync(metricsPath)
    ? readFileSync(metricsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    : [];
  check('one-metrics-line', lines.length === 1, `expected one metrics line, got ${lines.length}`);

  const rollup = lines[0] ? JSON.parse(lines[0]) : null;
  check('rollup-type', rollup?.type === 'agentic-context.discovery-tax.rollup', `got ${rollup?.type}`);
  check('scored-four-fixtures', rollup?.scoredSessions === 4, `got ${rollup?.scoredSessions}`);
  check('counts-discovery-tax', rollup?.counts?.discoveryTax === 2, `got ${rollup?.counts?.discoveryTax}`);
  check('counts-terminal-failure', rollup?.counts?.terminalFailure === 2, `got ${rollup?.counts?.terminalFailure}`);
  check('counts-class-search', rollup?.counts?.classSearchInPrompt === 2, `got ${rollup?.counts?.classSearchInPrompt}`);
  check('agent-breakdown', rollup?.counts?.byAgent?.claude === 2 && rollup?.counts?.byAgent?.codex === 2, JSON.stringify(rollup?.counts?.byAgent));
  check('baseline-attached', rollup?.baseline?.rates && Object.hasOwn(rollup.baseline.rates, 'discoveryTaxRate'), JSON.stringify(rollup?.baseline));

  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, metricsLines: lines.length, rollup }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
