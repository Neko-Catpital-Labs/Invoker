#!/usr/bin/env node

/**
 * Safely land a Mergify-managed PR stack.
 *
 * The hard rule this enforces: never act on a PR identified by branch name.
 * You pass explicit PR numbers, bottom-of-stack first. Every PR is verified
 * before any write happens:
 *   - its head commit SHA exists in the local clone (so it is the code you reviewed),
 *   - its head branch is a real `stack/` branch (refuses raw workflow branches),
 *   - the PRs form a proper stack (each PR's base is the previous PR's head branch;
 *     the bottom PR's base is the trunk),
 *   - every PR is OPEN.
 *
 * Only after ALL checks pass does `--execute` add the `admin-bypass` label to the
 * bottom-most open PR (the one whose base is the trunk) to trigger the Mergify
 * merge queue. Re-run after that PR merges and the next one re-targets the trunk.
 *
 * Background: a raw workflow branch PR (#505) once shared a branch name with the
 * intended stack (#2174/#2175). Landing "the PR on this branch" queued the wrong
 * PR. This guard makes that class of mistake impossible to commit by accident.
 *
 * Usage:
 *   node scripts/land-stack.mjs <pr> [<pr> ...]              # verify only (safe default)
 *   node scripts/land-stack.mjs <pr> [<pr> ...] --execute    # verify, then queue the bottom PR
 *   node scripts/land-stack.mjs <pr> ... --base main         # trunk branch (default: master)
 *   node scripts/land-stack.mjs <pr> ... --stack-prefix s/   # required head-branch prefix
 *   node scripts/land-stack.mjs --help
 *
 * Exit code: 0 when all checks pass (and the queue step, if requested, succeeds);
 * non-zero on any verification failure or bad input.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TRUNK_DEFAULT = 'master';
export const STACK_PREFIX_DEFAULT = 'stack/';

// ----------------------------- pure verification -----------------------------
// Kept side-effect free so scripts/test-land-stack.mjs can exercise every branch
// without touching gh or git.

/**
 * @param {object} input
 * @param {Array<{number:number, headRefOid:string, headRefName:string, baseRefName:string, state:string}>} input.prs
 *   ordered bottom -> top of the stack
 * @param {(sha:string)=>boolean} input.hasLocalCommit
 * @param {string} [input.trunk]
 * @param {string} [input.stackPrefix]
 * @returns {{ok:boolean, checks:Array<{pr:number,name:string,ok:boolean,detail:string}>}}
 */
export function analyzeStack({ prs, hasLocalCommit, trunk = TRUNK_DEFAULT, stackPrefix = STACK_PREFIX_DEFAULT }) {
  const checks = [];
  const add = (pr, name, ok, detail) => checks.push({ pr, name, ok, detail });

  if (!Array.isArray(prs) || prs.length === 0) {
    add(0, 'input', false, 'no PR numbers provided — pass explicit PR numbers, bottom of stack first');
    return { ok: false, checks };
  }

  prs.forEach((pr, i) => {
    const n = pr.number;

    add(n, 'open', pr.state === 'OPEN', `state=${pr.state}`);

    const shaOk = !!pr.headRefOid && hasLocalCommit(pr.headRefOid);
    add(n, 'sha-local', shaOk,
      `head ${short(pr.headRefOid)} ${shaOk ? 'present in local clone' : 'NOT found locally — refusing a PR whose code you do not have'}`);

    const branchOk = typeof pr.headRefName === 'string' && pr.headRefName.startsWith(stackPrefix);
    add(n, 'stack-branch', branchOk,
      `head branch '${pr.headRefName}' ${branchOk ? 'is' : `is NOT`} a '${stackPrefix}' branch`);

    const expectedBase = i === 0 ? trunk : prs[i - 1].headRefName;
    const baseOk = pr.baseRefName === expectedBase;
    add(n, 'base-linkage', baseOk,
      `base '${pr.baseRefName}' ${baseOk ? '==' : '!='} expected '${expectedBase}'`);
  });

  return { ok: checks.every((c) => c.ok), checks };
}

export function short(sha) {
  return sha ? String(sha).slice(0, 9) : '(none)';
}

// --------------------------------- CLI glue ----------------------------------

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function fetchPr(num) {
  const out = gh(['pr', 'view', String(num), '--json',
    'number,headRefOid,headRefName,baseRefName,state,mergeStateStatus,reviewDecision']);
  return JSON.parse(out);
}

function localCommitChecker() {
  return (sha) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
}

function parseArgs(argv) {
  const prs = [];
  let execute = false;
  let trunk = TRUNK_DEFAULT;
  let stackPrefix = STACK_PREFIX_DEFAULT;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--execute') execute = true;
    else if (a === '--base') trunk = argv[++i];
    else if (a === '--stack-prefix') stackPrefix = argv[++i];
    else if (/^\d+$/.test(a)) prs.push(Number(a));
    else throw new Error(`unrecognized argument: ${a}`);
  }
  return { prs, execute, trunk, stackPrefix, help };
}

const HELP = `land-stack — verify and land a Mergify PR stack by explicit PR number

  node scripts/land-stack.mjs <pr> [<pr> ...]              verify only (safe default)
  node scripts/land-stack.mjs <pr> [<pr> ...] --execute    verify, then queue the bottom PR
  node scripts/land-stack.mjs <pr> ... --base <branch>     trunk branch (default: master)
  node scripts/land-stack.mjs <pr> ... --stack-prefix <p>  required head-branch prefix (default: stack/)

Pass PR numbers bottom-of-stack first. Verification must pass before anything is
queued. --execute adds the admin-bypass label to the bottom PR (base == trunk).`;

function printReport(result) {
  const byPr = new Map();
  for (const c of result.checks) {
    if (!byPr.has(c.pr)) byPr.set(c.pr, []);
    byPr.get(c.pr).push(c);
  }
  for (const [pr, checks] of byPr) {
    console.log(`\nPR #${pr}`);
    for (const c of checks) {
      console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(13)} ${c.detail}`);
    }
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}\n`);
    console.error(HELP);
    process.exit(2);
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.prs.length === 0) {
    console.error('error: no PR numbers provided.\n');
    console.error(HELP);
    process.exit(2);
  }

  let prData;
  try {
    prData = args.prs.map(fetchPr);
  } catch (e) {
    console.error(`error: failed to read PR via gh: ${e.message}`);
    process.exit(2);
  }

  const result = analyzeStack({
    prs: prData,
    hasLocalCommit: localCommitChecker(),
    trunk: args.trunk,
    stackPrefix: args.stackPrefix,
  });
  printReport(result);

  // Informational only — Mergify itself blocks the actual merge on these.
  for (const pr of prData) {
    if (pr.reviewDecision && pr.reviewDecision !== 'APPROVED') {
      console.log(`\nnote: PR #${pr.number} reviewDecision=${pr.reviewDecision}, mergeState=${pr.mergeStateStatus}`);
    }
  }

  if (!result.ok) {
    console.error('\nRESULT: FAILED — not touching any PR. Fix the failures above (or confirm you passed the right PR numbers).');
    process.exit(1);
  }
  console.log('\nRESULT: verification passed.');

  if (!args.execute) {
    console.log('Re-run with --execute to queue the bottom PR (base == trunk) via admin-bypass.');
    return;
  }

  const bottom = prData.find((p) => p.state === 'OPEN' && p.baseRefName === args.trunk);
  if (!bottom) {
    console.error(`\nerror: no open PR with base '${args.trunk}' to queue. After the bottom PR merges, re-run with the remaining PR numbers.`);
    process.exit(1);
  }
  console.log(`\nExecuting: adding 'admin-bypass' to bottom PR #${bottom.number} (head ${short(bottom.headRefOid)}, base ${bottom.baseRefName}).`);
  gh(['pr', 'edit', String(bottom.number), '--add-label', 'admin-bypass']);
  console.log(`Queued PR #${bottom.number}. Once it merges, the next PR re-targets '${args.trunk}'; re-run land-stack with the remaining PR numbers and --execute.`);
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
