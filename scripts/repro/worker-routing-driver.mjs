// Worker-routing battle driver: boots the land and orphan PR-maintenance
// workers (the same createXWorker factories the Invoker owner uses) and
// manually ticks them against fake-GitHub scenarios exhibiting their issue
// classes. Proves the wiring end-to-end per owner:
//   worker tick -> spawns its cron entrypoint -> entrypoint detects the issue
//   -> takes the right action (recorded via worker logs or node-shim calls).
//
// Run via scripts/repro/repro-pr-maintenance-worker-routing.sh (which bundles
// this file with esbuild so the TS worker sources resolve without vitest).
//
// Env contract (set by the wrapper):
//   ROUTING_REPO_ROOT        - Invoker repo root
//   ROUTING_TMP              - scratch dir owned by the wrapper (cleaned by it)
//   FAKE_GH_REQUIRED_CHECKS  - required-check names for admin-bypass dry-runs
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  createPrAdminBypassLandWorker,
  createPrOrphanRepairWorker,
} from '../../packages/execution-engine/src/workers/pr-maintenance-workers.ts';

const ROOT = resolve(process.env.ROUTING_REPO_ROOT ?? process.cwd());
const TMP = resolve(process.env.ROUTING_TMP ?? '/tmp/worker-routing');
const FAKE_GH_BIN = join(ROOT, 'scripts/repro/fixtures/fake-gh/bin');
const SCENARIOS = join(ROOT, 'scripts/repro/fixtures/fake-gh/scenarios');

const failures = [];

function makeLeg(kind) {
  const legDir = join(TMP, kind);
  const bin = join(legDir, 'bin');
  const state = join(legDir, 'state');
  const home = join(legDir, 'home');
  for (const d of [bin, state, home]) mkdirSync(d, { recursive: true });
  for (const tool of ['gh', 'omp']) {
    const link = join(bin, tool);
    if (!existsSync(link)) symlinkSync(join(FAKE_GH_BIN, tool), link);
  }
  const nodeLog = join(legDir, 'node-calls.log');
  writeFileSync(nodeLog, '');
  writeFileSync(
    join(bin, 'node'),
    `#!/usr/bin/env bash\nif [[ "$#" -ge 1 && ( "$1" == *"/scripts/retry-ledger.mjs" || ( "$1" == *"/scripts/repro/fixtures/fake-headless-ipc.js" && "$*" == *"repair-filing"* ) ) ]]; then\n  exec ${JSON.stringify(process.execPath)} "$@"\nfi\nprintf 'node %s\\n' "$*" >> ${JSON.stringify(nodeLog)}\nexit 0\n`,
    { mode: 0o755 },
  );
  const lines = [];
  const record = (msg) => {
    lines.push(String(msg));
    process.stdout.write(`  ${msg}\n`);
  };
  const logger = { info: record, warn: record, error: record, debug: () => {} };
  const baseEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    FAKE_GH_STATE_DIR: state,
    INVOKER_GITHUB_TARGET_REPO: 'fake/repo',
    INVOKER_PR_CRON_AUTHOR: 'fake-bot',
    INVOKER_HEADLESS_IPC_HELPER: join(ROOT, 'scripts/repro/fixtures/fake-headless-ipc.js'),
  };
  return { kind, legDir, bin, state, home, nodeLog, lines, logger, baseEnv };
}

function loadScenario(leg, scenario) {
  writeFileSync(join(leg.state, 'state.json'), readFileSync(join(SCENARIOS, scenario)));
  writeFileSync(join(leg.state, 'calls.log'), '');
}

function assert(leg, ok, what) {
  const verdict = ok ? 'PASS' : 'FAIL';
  console.log(`[${leg.kind}] ${verdict}: ${what}`);
  if (!ok) failures.push(`${leg.kind}: ${what}`);
}

async function tickWorker(leg, factory, extraEnv, scenario) {
  loadScenario(leg, scenario);
  const worker = factory({
    logger: leg.logger,
    repoRoot: ROOT,
    env: { ...leg.baseEnv, ...extraEnv },
    lockPath: join(leg.legDir, 'crons.lock'),
    intervalMs: 3_600_000,
    tickOnStart: false,
    installSignalHandlers: false,
  });
  let tickError;
  try {
    await worker.tick('manual');
  } catch (err) {
    tickError = err;
  } finally {
    await worker.stop();
  }
  return tickError;
}

const has = (leg, needle) => leg.lines.some((line) => line.includes(needle));
const nodeLogText = (leg) => readFileSync(leg.nodeLog, 'utf8');

// ---------------------------------------------------------------------------
// Leg 1: merge conflict -> pr-admin-bypass-land worker
// ---------------------------------------------------------------------------
{
  const leg = makeLeg('pr-admin-bypass-land-conflict');
  console.log('\n=== leg 1: conflicted PR (pr-dirty.json) -> pr-admin-bypass-land ===');
  const err = await tickWorker(leg, createPrAdminBypassLandWorker, {
    INVOKER_PR_CRON_DRY_RUN: '1',
    FAKE_GH_REQUIRED_CHECKS: process.env.FAKE_GH_REQUIRED_CHECKS ?? '',
  }, 'pr-dirty.json');
  assert(leg, has(leg, '[worker:pr-admin-bypass-land] spawning scripts/cron-pr-admin-bypass-land.sh'),
    'worker spawned its own cron entrypoint');
  assert(leg, !err, `entrypoint completed cleanly${err ? ` (got: ${err.message})` : ''}`);
  assert(leg, has(leg, 'DRY-RUN repair-conflict PR #501'),
    'conflicted PR triggered the admin-bypass repair-conflict path');
}

// ---------------------------------------------------------------------------
// Leg 2: failed CI -> pr-admin-bypass-land worker
// ---------------------------------------------------------------------------
{
  const leg = makeLeg('pr-admin-bypass-land-failed-ci');
  console.log('\n=== leg 2: CI-failed PR (pr-ci-failed.json) -> pr-admin-bypass-land ===');
  const err = await tickWorker(leg, createPrAdminBypassLandWorker, {
    INVOKER_PR_CRON_DRY_RUN: '1',
    FAKE_GH_REQUIRED_CHECKS: process.env.FAKE_GH_REQUIRED_CHECKS ?? '',
  }, 'pr-ci-failed.json');
  assert(leg, has(leg, '[worker:pr-admin-bypass-land] spawning scripts/cron-pr-admin-bypass-land.sh'),
    'worker spawned its own cron entrypoint');
  assert(leg, !err, `entrypoint completed cleanly${err ? ` (got: ${err.message})` : ''}`);
  assert(leg, has(leg, 'DRY-RUN repair-check PR #601 check="PR Body"'),
    'failed required check triggered the admin-bypass repair-check path');
  assert(leg, !has(leg, 'PR #602'),
    'conflicted non-admin-bypass PR #602 was not actioned by the admin-bypass worker');
}

// ---------------------------------------------------------------------------
// Leg 3: landable stack -> pr-admin-bypass-land worker (dry-run)
// ---------------------------------------------------------------------------
{
  const leg = makeLeg('pr-admin-bypass-land-landable');
  console.log('\n=== leg 3: dequeued landable stack (stack-landable.json) -> pr-admin-bypass-land ===');
  const err = await tickWorker(leg, createPrAdminBypassLandWorker, {
    INVOKER_PR_CRON_DRY_RUN: '1',
    FAKE_GH_REQUIRED_CHECKS: process.env.FAKE_GH_REQUIRED_CHECKS ?? '',
  }, 'stack-landable.json');
  assert(leg, has(leg, '[worker:pr-admin-bypass-land] spawning scripts/cron-pr-admin-bypass-land.sh'),
    'worker spawned its own cron entrypoint');
  assert(leg, !err, `entrypoint completed cleanly${err ? ` (got: ${err.message})` : ''}`);
  assert(leg, has(leg, 'DRY-RUN requeue PR #701'),
    'landing brain planned a requeue for the dequeued bottom PR #701');
  assert(leg, !has(leg, 'DRY-RUN requeue PR #702'),
    'stack top #702 was not actioned before the bottom landed');
}

// ---------------------------------------------------------------------------
// Leg 4: CodeRabbit bot thread -> pr-admin-bypass-land worker
// ---------------------------------------------------------------------------
{
  const leg = makeLeg('pr-admin-bypass-land-bot-thread');
  writeFileSync(join(leg.state, 'state.json'), JSON.stringify({
    prs: [{
      number: 5800,
      title: 'Admin-bypass PR with CodeRabbit thread',
      url: 'https://github.com/fake/repo/pull/5800',
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'master',
      headRefName: 'stack/5800',
      headRefOid: 'ffffffffffffffffffffffffffffffffffffffff',
      mergeStateStatus: 'CLEAN',
      mergeable: 'MERGEABLE',
      labels: ['admin-bypass', 'dequeued'],
      reviewThreads: [{
        id: 'tbot',
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [{
            author: { login: 'coderabbitai[bot]' },
            body: 'Please update this branch',
            url: 'https://github.com/fake/repo/pull/5800#discussion_r1',
          }],
        },
      }],
      checks: { '*': 'SUCCESS' },
    }],
    issue_comments: {
      5800: [{
        id: 'm5800',
        user: { login: 'mergify[bot]' },
        updated_at: '2026-07-20T00:00:00Z',
        html_url: 'https://github.com/fake/repo/pull/5800#m5800',
        body: 'Left the queue `admin-bypass` at `ffffffffffffffffffffffffffffffffffffffff`.\n-*- Mergify Payload -*-\n{"state":"dequeued","queue_rule_name":"admin-bypass"}\n',
      }],
    },
  }, null, 2));
  writeFileSync(join(leg.state, 'calls.log'), '');
  console.log('\n=== leg 4: CodeRabbit bot review thread -> pr-admin-bypass-land ===');
  const worker = createPrAdminBypassLandWorker({
    logger: leg.logger,
    repoRoot: ROOT,
    env: {
      ...leg.baseEnv,
      INVOKER_PR_CRON_DRY_RUN: '1',
      FAKE_GH_REQUIRED_CHECKS: process.env.FAKE_GH_REQUIRED_CHECKS ?? '',
    },
    lockPath: join(leg.legDir, 'crons.lock'),
    intervalMs: 3_600_000,
    tickOnStart: false,
    installSignalHandlers: false,
  });
  let err;
  try {
    await worker.tick('manual');
  } catch (caught) {
    err = caught;
  } finally {
    await worker.stop();
  }
  assert(leg, has(leg, '[worker:pr-admin-bypass-land] spawning scripts/cron-pr-admin-bypass-land.sh'),
    'worker spawned its own cron entrypoint');
  assert(leg, !err, `entrypoint completed cleanly${err ? ` (got: ${err.message})` : ''}`);
  assert(leg, has(leg, 'DRY-RUN repair-check PR #5800 check="tbot"'),
    'bot review thread routed through the admin-bypass repair path');
}

// ---------------------------------------------------------------------------
// Leg 5: unmapped broken PR -> pr-orphan-repair worker
// ---------------------------------------------------------------------------
{
  const leg = makeLeg('pr-orphan-repair');
  const reviewGate = join(leg.legDir, 'review-gate.sh');
  writeFileSync(
    reviewGate,
    '#!/usr/bin/env bash\nif [ "${1:-}" = "803" ]; then\n  printf \'{"workflowId":"wf-mapped-803"}\\n\'\nelse\n  printf \'{}\\n\'\nfi\n',
    { mode: 0o755 },
  );
  console.log('\n=== leg 5: unmapped broken PR (pr-orphan-broken.json) -> pr-orphan-repair ===');
  const err = await tickWorker(leg, createPrOrphanRepairWorker, {
    INVOKER_PR_CRON_REVIEW_GATE_CMD: reviewGate,
    INVOKER_PR_ORPHAN_STATE_FILE: join(leg.legDir, 'ledger.tsv'),
    INVOKER_PR_ORPHAN_PLAN_DIR: join(leg.legDir, 'plans'),
  }, 'pr-orphan-broken.json');
  assert(leg, has(leg, '[worker:pr-orphan-repair] spawning scripts/cron-pr-orphan-repair.sh'),
    'worker spawned its own cron entrypoint');
  assert(leg, !err, `entrypoint completed cleanly${err ? ` (got: ${err.message})` : ''}`);
  assert(leg, /exec -- run .*repair-pr-801\.yaml/.test(nodeLogText(leg)),
    'unmapped broken PR #801 got ONE combined Invoker repair task');
  assert(leg, !nodeLogText(leg).includes('repair-pr-802'),
    'healthy unmapped PR #802 was untouched');
  assert(leg, !nodeLogText(leg).includes('repair-pr-803'),
    'mapped PR #803 was left to the admin-bypass/orphan boundary');
}

console.log('');
if (failures.length > 0) {
  console.log(`[worker-routing] FAILED (${failures.length}):`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('[worker-routing] all five routing legs passed through the targeted PR-maintenance workers');
