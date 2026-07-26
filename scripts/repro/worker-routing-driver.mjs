// Worker-routing battle driver: boots the four REAL PR-maintenance workers
// (the same createXWorker factories the Invoker owner uses) and manually
// ticks each one against a fake-GitHub scenario exhibiting exactly the issue
// class that worker owns. Proves the wiring end-to-end per kind:
//   worker tick -> spawns its cron entrypoint -> entrypoint detects the issue
//   -> takes the right action (recorded via node-shim / fake-gh calls.log).
//
// Run via scripts/repro/repro-pr-maintenance-worker-routing.sh (which bundles
// this file with esbuild so the TS worker sources resolve without vitest).
//
// Env contract (set by the wrapper):
//   ROUTING_REPO_ROOT   - Invoker repo root
//   ROUTING_TMP         - scratch dir owned by the wrapper (cleaned by it)
//   FAKE_GH_REQUIRED_CHECKS - required-check names for the landing scenario
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  createCoderabbitAddressWorker,
  createPrConflictRebaseWorker,
  createPrCiFailureScanWorker,
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
  // node shim: records headless-ipc dispatches instead of booting an owner.
  writeFileSync(
    join(bin, 'node'),
    `#!/usr/bin/env bash\nprintf 'node %s\\n' "$*" >> ${JSON.stringify(nodeLog)}\nexit 0\n`,
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

const has = (leg, needle) => leg.lines.some((l) => l.includes(needle));
const nodeLogText = (leg) => readFileSync(leg.nodeLog, 'utf8');
const callsLog = (leg) => readFileSync(join(leg.state, 'calls.log'), 'utf8');

// ---------------------------------------------------------------------------
// Leg 1: merge conflict -> pr-conflict-rebase worker
// ---------------------------------------------------------------------------
{
  const leg = makeLeg('pr-conflict-rebase');
  const reviewGate = join(leg.legDir, 'review-gate.sh');
  writeFileSync(
    reviewGate,
    '#!/usr/bin/env bash\nprintf \'{"workflowId":"wf-routing-1","workflowGeneration":0,"baseBranch":"master"}\\n\'\n',
    { mode: 0o755 },
  );
  console.log('\n=== leg 1: conflicted PR (pr-dirty.json) -> pr-conflict-rebase ===');
  const err = await tickWorker(leg, createPrConflictRebaseWorker, {
    INVOKER_PR_CONFLICT_STATE_FILE: join(leg.legDir, 'ledger.tsv'),
    INVOKER_PR_CRON_REVIEW_GATE_CMD: reviewGate,
    INVOKER_PR_REBASE_MAX_ATTEMPTS: '3',
    INVOKER_PR_REBASE_CONFIRM_TIMEOUT: '0',
  }, 'pr-dirty.json');
  assert(leg, !err, `entrypoint completed cleanly${err ? ` (got: ${err.message})` : ''}`);
  assert(leg, has(leg, '[worker:pr-conflict-rebase] spawning scripts/cron-pr-conflict-rebase.sh'),
    'worker spawned its own cron entrypoint');
  assert(leg, nodeLogText(leg).includes('rebase-recreate wf-routing-1'),
    'conflicted PR triggered a rebase-recreate dispatch');
}

// ---------------------------------------------------------------------------
// Leg 2: failed CI -> pr-ci-failure-scan worker
// ---------------------------------------------------------------------------
{
  const leg = makeLeg('pr-ci-failure-scan');
  // The scanned PRs model MAPPED workflows (unmapped ones belong to the
  // orphan-repair worker), so the review-gate stub reports a hit.
  const reviewGate = join(leg.legDir, 'review-gate.sh');
  writeFileSync(
    reviewGate,
    '#!/usr/bin/env bash\nprintf \'{"workflowId":"wf-ci-mapped","workflowGeneration":0,"baseBranch":"master"}\\n\'\n',
    { mode: 0o755 },
  );
  console.log('\n=== leg 2: CI-failed PR (pr-ci-failed.json) -> pr-ci-failure-scan ===');
  const err = await tickWorker(leg, createPrCiFailureScanWorker, {
    INVOKER_PR_CRON_REVIEW_GATE_CMD: reviewGate,
  }, 'pr-ci-failed.json');
  assert(leg, has(leg, '[worker:pr-ci-failure-scan] spawning packages/execution-engine/scripts/cron-pr-ci-failure.sh'),
    'worker spawned its own cron entrypoint');
  assert(leg, !err, `entrypoint completed cleanly${err ? ` (got: ${err.message})` : ''}`);
  assert(leg, nodeLogText(leg).includes('repair-review-gate-ci 601'),
    'CI-failed PR #601 triggered a repair-review-gate-ci dispatch');
  assert(leg, !nodeLogText(leg).includes('repair-review-gate-ci 602'),
    'conflicted PR #602 was left to the conflict worker (no CI dispatch)');
}

// ---------------------------------------------------------------------------
// Leg 3: landable stack -> pr-admin-bypass-land worker (dry-run)
// ---------------------------------------------------------------------------
{
  const leg = makeLeg('pr-admin-bypass-land');
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
  assert(leg, !/^gh (pr comment|api --method)/m.test(callsLog(leg)),
    'dry-run made no mutating gh calls');
}

// ---------------------------------------------------------------------------
// Leg 4: CodeRabbit review sweep -> coderabbit-address worker
// (behavioral dedup/action coverage lives in repro-coderabbit-address-dedup.sh;
// this leg proves the worker->entrypoint routing and a clean fake-gh sweep.)
// ---------------------------------------------------------------------------
{
  const leg = makeLeg('coderabbit-address');
  console.log('\n=== leg 4: review sweep (pr-dirty.json) -> coderabbit-address ===');
  const err = await tickWorker(leg, createCoderabbitAddressWorker, {}, 'pr-dirty.json');
  assert(leg, has(leg, '[worker:coderabbit-address] spawning scripts/cron-coderabbit-address.sh'),
    'worker spawned its own cron entrypoint');
  assert(leg, !err, `entrypoint completed cleanly${err ? ` (got: ${err.message})` : ''}`);
  assert(leg, callsLog(leg).length > 0, 'sweep queried the fake GitHub');
}

// ---------------------------------------------------------------------------
// Leg 5: unmapped broken PR -> pr-orphan-repair worker (combined repair task)
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
    'mapped PR #803 was left to the existing workers');
}

console.log('');
if (failures.length > 0) {
  console.log(`[worker-routing] FAILED (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('[worker-routing] all five workers routed their issue class correctly');
