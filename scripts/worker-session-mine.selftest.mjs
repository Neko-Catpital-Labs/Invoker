#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MINER = join(__dirname, 'worker-session-mine.mjs');

const SESSION_ID = '01a082c3-d260-7e90-a870-f4e0a390f604';
const CI_WORKFLOW = 'CI regression: 9fe1d9a-required-fast-vitest-workspace';

function thrashyRollout() {
  const rows = [];
  for (let i = 1; i <= 60; i += 1) {
    rows.push(JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 200_000 * i, cached_input_tokens: 190_000 * i, output_tokens: 500 * i } },
      },
    }));
  }
  return rows.join('\n');
}

function makeFakeCli(dir, { workflows, tasks }) {
  const binDir = join(dir, 'fakebin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(dir, 'workflows.json'), JSON.stringify(workflows));
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify(tasks));
  const cli = join(binDir, 'fake-invoker-cli');
  writeFileSync(cli, `#!/usr/bin/env bash
if [ "$1" = "run" ]; then printf '%s' "$2" > ${join(dir, 'submitted.txt')}; echo "Delegated to live owner - workflow: wf-selftest-1"; exit 0; fi
if [ "$2" = "workflows" ]; then cat ${join(dir, 'workflows.json')}; exit 0; fi
if [ "$2" = "tasks" ]; then cat ${join(dir, 'tasks.json')}; exit 0; fi
echo null
`);
  chmodSync(cli, 0o755);
  return cli;
}

function runMiner(dir, cli, extraEnv = {}) {
  const plansDir = join(dir, 'plans');
  mkdirSync(plansDir, { recursive: true });
  const result = spawnSync('node', [MINER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: plansDir,
      TMP: plansDir,
      TEMP: plansDir,
      INVOKER_SESSION_MINE_DRY_RUN: '1',
      INVOKER_SESSION_MINE_STATE_DIR: join(dir, 'state'),
      INVOKER_SESSION_MINE_CLI: cli,
      INVOKER_DB_DIR: dir,
      CODEX_HOME: join(dir, 'codex'),
      CATSTACK_ROOT: '',
      ...extraEnv,
    },
  });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function seedSession(dir) {
  mkdirSync(join(dir, 'agent-sessions'), { recursive: true });
  writeFileSync(join(dir, 'agent-sessions', `${SESSION_ID}.jsonl`), '{"type":"thread.started"}\n');
  const day = join(dir, 'codex', 'sessions', '2026', '09', '08');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-09-08T20-44-26-${SESSION_ID}.jsonl`), thrashyRollout());
}

const failures = [];
function check(label, condition, detail) {
  if (condition) return;
  failures.push(`${label}: ${detail}`);
}

const roots = [];
function freshRoot() {
  const d = mkdtempSync(join(tmpdir(), 'session-mine-selftest-'));
  roots.push(d);
  seedSession(d);
  return d;
}

try {
  {
    const dir = freshRoot();
    const cli = makeFakeCli(dir, {
      workflows: [{ id: 'wf-1', name: CI_WORKFLOW, status: 'failed' }],
      tasks: [{
        id: 'wf-1/fix-ci',
        status: 'failed',
        execution: { agentSessionId: SESSION_ID, agentName: 'codex' },
      }],
    });
    const out = runMiner(dir, cli);
    check('ci-workflow-is-mined', /filed 1/.test(out), `expected one filing, got:\n${out}`);
    check('ci-workflow-reason', /total_tokens=/.test(out), `expected a total_tokens reason, got:\n${out}`);
  }

  {
    const dir = freshRoot();
    const cli = makeFakeCli(dir, { workflows: [], tasks: [] });
    const out = runMiner(dir, cli, { INVOKER_SESSION_MINE_ALLOW_UNHINTTED: '1' });
    check('empty-inventory-falls-back', /using disk fallback/.test(out), `expected the disk fallback to run, got:\n${out}`);
    check('empty-inventory-still-files', /filed 1/.test(out), `expected the disk fallback to file, got:\n${out}`);
  }

  {
    const dir = freshRoot();
    const cli = makeFakeCli(dir, {
      workflows: [{ id: 'wf-1', name: 'worker-session-mine-abc', status: 'failed' }],
      tasks: [{ id: 'wf-1/x', status: 'failed', execution: { agentSessionId: SESSION_ID, agentName: 'codex' } }],
    });
    const out = runMiner(dir, cli);
    check('self-mining-excluded', /filed 0/.test(out), `expected the miner to skip its own workflows, got:\n${out}`);
  }

  {
    const dir = freshRoot();
    const cli = join(dir, 'fakebin', 'does-not-exist');
    const out = runMiner(dir, cli, { INVOKER_SESSION_MINE_ALLOW_UNHINTTED: '1' });
    check('missing-cli-falls-back', /using disk fallback/.test(out), `expected a missing owner CLI to fall back, got:\n${out}`);
  }

  {
    const dir = freshRoot();
    const cli = makeFakeCli(dir, {
      workflows: [{ id: 'wf-1', name: CI_WORKFLOW, status: 'failed' }],
      tasks: [{ id: 'wf-1/fix-ci', status: 'failed', execution: { agentSessionId: SESSION_ID, agentName: 'codex' } }],
    });
    const out = runMiner(dir, cli, { INVOKER_SESSION_MINE_DRY_RUN: '0' });
    check('real-submit-files', /filed 1/.test(out), `expected a real submission to succeed, got:\n${out}`);
    check('real-submit-uses-owner-cli', /Delegated to live owner/.test(out), `expected the owner CLI to receive the plan, got:\n${out}`);
    const submitted = existsSync(join(dir, 'submitted.txt')) ? readFileSync(join(dir, 'submitted.txt'), 'utf8') : '';
    check('real-submit-passes-a-plan', submitted.endsWith('plan.yaml'), `expected a plan path handed to the owner CLI, got: ${submitted}`);
    const plan = submitted ? readFileSync(submitted, 'utf8') : '';
    check('plan-omits-pool-by-default', plan.length > 0 && !/poolId:/.test(plan), 'expected no poolId line when none is configured');
    check('plan-keeps-required-header', /^name: /m.test(plan) && /onFinish: pull_request/.test(plan), 'expected the plan header to survive');
  }

  {
    const dir = freshRoot();
    const cli = makeFakeCli(dir, {
      workflows: [{ id: 'wf-1', name: CI_WORKFLOW, status: 'failed' }],
      tasks: [{ id: 'wf-1/fix-ci', status: 'failed', execution: { agentSessionId: SESSION_ID, agentName: 'codex' } }],
    });
    runMiner(dir, cli, { INVOKER_SESSION_MINE_DRY_RUN: '0', INVOKER_SESSION_MINE_POOL_ID: 'local-only' });
    const submitted = existsSync(join(dir, 'submitted.txt')) ? readFileSync(join(dir, 'submitted.txt'), 'utf8') : '';
    const plan = submitted ? readFileSync(submitted, 'utf8') : '';
    check('plan-uses-configured-pool', /^poolId: local-only$/m.test(plan), `expected the configured pool in the plan, got:\n${plan.slice(0, 400)}`);
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, checks: 12 }, null, 2));
} finally {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
}
