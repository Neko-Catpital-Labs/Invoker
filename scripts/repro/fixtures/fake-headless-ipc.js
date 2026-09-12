#!/usr/bin/env node
// Reusable fake for scripts/headless-ipc.js, scoped to the one command every
// mergify_admin_requeue/pr-maintenance-worker repro needs: the repair_filings
// dedup ledger's `repair-filing insert`/`repair-filing release` mutation
// (see scripts/repair_filing_ledger.py, scripts/repair-filing-ledger.mjs).
//
// scripts/headless-lib.sh's headless_mutation() always delegates through the
// real scripts/headless-ipc.js unless INVOKER_HEADLESS_STANDALONE=1, which
// requires a live Invoker owner process (IPC) or a built headless-client.js
// (standalone) neither of which a hermetic repro provides. Point
// INVOKER_HEADLESS_IPC_HELPER at this file so headless_mutation resolves the
// ledger claim without either, matching the ledger-free behavior every one
// of these repros had before scripts/mergify_admin_requeue_plan.py wired the
// real entrypoint to the shared claim/release primitive (#9474).
//
// Any other headless_mutation command (e.g. `run <plan.yaml>` for submitting
// an actual repair workflow) is not this fixture's concern -- forward it
// unchanged to the real scripts/headless-ipc.js, which already has its own
// no-owner-available fallback (standalone mode via a built headless-client.js).
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
const sepIndex = args.indexOf('--');
const headlessArgs = sepIndex >= 0 ? args.slice(sepIndex + 1) : [];
const [command, subcommand] = headlessArgs;

if (args[0] === 'exec' && command === 'repair-filing' && subcommand === 'insert') {
  process.stdout.write(`${JSON.stringify({ inserted: true, row: {} })}\n`);
  process.exit(0);
}

if (args[0] === 'exec' && command === 'repair-filing' && subcommand === 'release') {
  process.stdout.write(`${JSON.stringify({ released: true })}\n`);
  process.exit(0);
}

const REAL_IPC_HELPER = path.join(__dirname, '..', '..', 'headless-ipc.js');
const result = spawnSync(process.execPath, [REAL_IPC_HELPER, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
