#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MINER = join(__dirname, 'worker-session-mine.mjs');
const FIXTURES_DIR = join(__dirname, 'fixtures', 'agentic-context-score');

const root = mkdtempSync(join(tmpdir(), 'session-mine-rollup-'));

function fixturePath(name) {
  return join(FIXTURES_DIR, name);
}

function check(label, condition, detail) {
  if (!condition) {
    throw new Error(`${label}: ${detail}`);
  }
}

try {
  const inventoryPath = join(root, 'inventory.json');
  const metricsPath = join(root, 'agentic-context', 'metrics.jsonl');
  mkdirSync(dirname(metricsPath), { recursive: true });
  writeFileSync(inventoryPath, JSON.stringify([
    {
      workflowName: 'CI regression: fixture claude explore',
      sessionId: 'claude-explore-first',
      agentName: 'claude',
      status: 'failed',
      path: fixturePath('claude-explore-first.jsonl'),
    },
    {
      workflowName: 'CI regression: fixture claude oriented',
      sessionId: 'claude-oriented-edit',
      agentName: 'claude',
      status: 'failed',
      path: fixturePath('claude-oriented-edit.jsonl'),
    },
    {
      workflowName: 'CI regression: fixture codex explore',
      sessionId: 'codex-explore-first',
      agentName: 'codex',
      status: 'failed',
      path: fixturePath('codex-explore-first.jsonl'),
    },
    {
      workflowName: 'CI regression: fixture codex oriented',
      sessionId: 'codex-oriented-edit',
      agentName: 'codex',
      status: 'failed',
      path: fixturePath('codex-oriented-edit.jsonl'),
    },
  ], null, 2));

  const result = spawnSync('node', [MINER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INVOKER_SESSION_MINE_INVENTORY_JSON: inventoryPath,
      INVOKER_SESSION_MINE_STATE_DIR: join(root, 'state'),
      INVOKER_AGENTIC_CONTEXT_METRICS_PATH: metricsPath,
      CATSTACK_ROOT: '',
    },
  });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  check('miner-exit', result.status === 0, `expected exit 0, got ${result.status}\n${out}`);
  check('miner-scanned-fixtures', /agentic-context metrics scanned 4\/4 jsonl/.test(out), `expected metrics scan log, got:\n${out}`);
  check('miner-did-not-file-followups', /session-mine: filed 0/.test(out), `expected no thrash follow-ups for scorer fixtures, got:\n${out}`);
  check('metrics-written', existsSync(metricsPath), `expected ${metricsPath}`);

  const lines = readFileSync(metricsPath, 'utf8').split(/\r?\n/).filter(Boolean);
  check('one-metrics-line', lines.length === 1, `expected one metrics line, got ${lines.length}`);
  const metric = JSON.parse(lines[0]);

  check('metric-type', metric.type === 'agentic-context-discovery-tax-rollup', `got ${metric.type}`);
  check('metric-candidates', metric.candidates === 4, `got ${metric.candidates}`);
  check('metric-scanned-jsonl', metric.scannedJsonl === 4, `got ${metric.scannedJsonl}`);
  check('metric-discovery-tax-count', metric.totals.discoveryTax === 2, `got ${metric.totals.discoveryTax}`);
  check('metric-terminal-failure-count', metric.totals.terminalFailure === 2, `got ${metric.totals.terminalFailure}`);
  check('metric-class-search-count', metric.totals.classSearchInPrompt === 2, `got ${metric.totals.classSearchInPrompt}`);
  check('metric-baseline-loaded', metric.baseline?.path?.endsWith('baseline.json'), `got ${JSON.stringify(metric.baseline)}`);
  check('metric-agent-breakdown', metric.byAgent.claude?.sessions === 2 && metric.byAgent.codex?.sessions === 2, `got ${JSON.stringify(metric.byAgent)}`);

  console.log(JSON.stringify({ ok: true, metricsPath, metric }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
