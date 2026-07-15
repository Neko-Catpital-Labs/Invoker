#!/usr/bin/env node

/**
 * Safely land a Mergify-managed PR stack.
 *
 * The hard rule this enforces: never act on a PR identified by branch name.
 * You pass confirmed PR numbers, bottom-of-stack first. Every PR is verified
 * before any write happens:
 *   - its head commit SHA exists in the local clone (so it is the code you reviewed),
 *   - its head branch is a real `stack/` branch (refuses raw workflow branches),
 *   - the PRs form a proper stack (each PR's base is the previous PR's head branch;
 *     the bottom PR's base is the trunk),
 *   - the provided PRs are the complete open stack, not a prefix/suffix slice,
 *   - every PR is OPEN.
 *
 * Only after ALL checks pass does `--execute` add the `admin-bypass` label to
 * every PR in the verified stack, bottom-to-top. That lets Mergify land the
 * whole stack as one unit of work instead of one PR per manual re-run.
 *
 * Background: a raw workflow branch PR (#505) once shared a branch name with the
 * intended stack (#2174/#2175). Landing "the PR on this branch" queued the wrong
 * PR. This guard makes that class of mistake impossible to commit by accident.
 *
 * Usage:
 *   node scripts/land-stack.mjs <pr> [<pr> ...]              # verify confirmed numbers (safe default)
 *   node scripts/land-stack.mjs <pr> [<pr> ...] --execute    # re-verify, then queue the whole stack
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

export function analyzeStack({ prs, hasLocalCommit, trunk = TRUNK_DEFAULT, stackPrefix = STACK_PREFIX_DEFAULT }) {
  const checks = [];
  const add = (pr, name, ok, detail) => checks.push({ pr, name, ok, detail });

  if (!Array.isArray(prs) || prs.length === 0) {
    add(0, 'input', false, 'no PR numbers provided — discover/suggest bottom-up PR numbers, confirm them, then rerun');
    return { ok: false, checks };
  }

  prs.forEach((pr, i) => {
    const n = pr.number;
    add(n, 'open', pr.state === 'OPEN', `state=${pr.state}`);

    const shaOk = Boolean(pr.headRefOid) && hasLocalCommit(pr.headRefOid);
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

export function analyzeCompleteOpenStack({ selectedPrs, allOpenPrs, trunk = TRUNK_DEFAULT, stackPrefix = STACK_PREFIX_DEFAULT }) {
  const selectedNumbers = selectedPrs.map((pr) => pr.number);
  const fail = (detail, fullStack = []) => ({
    ok: false,
    fullStack,
    checks: [{ pr: 0, name: 'complete-stack', ok: false, detail }],
  });

  if (selectedPrs.length === 0) return fail('no PR numbers provided');

  const byNumber = new Map();
  for (const pr of allOpenPrs.concat(selectedPrs)) {
    if (pr?.state === 'OPEN' && typeof pr.headRefName === 'string' && pr.headRefName.startsWith(stackPrefix)) {
      byNumber.set(pr.number, pr);
    }
  }
  const openStackPrs = [...byNumber.values()];
  const byHead = new Map(openStackPrs.map((pr) => [pr.headRefName, pr]));
  const childrenByBase = new Map();
  for (const pr of openStackPrs) {
    const children = childrenByBase.get(pr.baseRefName) ?? [];
    children.push(pr);
    childrenByBase.set(pr.baseRefName, children);
  }

  const fullStack = [selectedPrs[0]];
  const seen = new Set([selectedPrs[0].number]);
  let bottom = selectedPrs[0];
  while (bottom.baseRefName !== trunk) {
    const parent = byHead.get(bottom.baseRefName);
    if (!parent) return fail(`missing lower open stack PR whose head branch is '${bottom.baseRefName}'`, fullStack);
    if (seen.has(parent.number)) return fail(`cycle detected while walking lower stack from PR #${selectedPrs[0].number}`, fullStack);
    fullStack.unshift(parent);
    seen.add(parent.number);
    bottom = parent;
  }

  let top = fullStack[fullStack.length - 1];
  while (true) {
    const children = (childrenByBase.get(top.headRefName) ?? []).filter((pr) => pr.number !== top.number);
    if (children.length === 0) break;
    if (children.length > 1) return fail(`ambiguous stack: branch '${top.headRefName}' has ${children.length} open stack children`, fullStack);
    const child = children[0];
    if (seen.has(child.number)) return fail(`cycle detected while walking upper stack from PR #${top.number}`, fullStack);
    fullStack.push(child);
    seen.add(child.number);
    top = child;
  }

  const expectedNumbers = fullStack.map((pr) => pr.number);
  const ok = expectedNumbers.length === selectedNumbers.length
    && expectedNumbers.every((number, index) => number === selectedNumbers[index]);
  return {
    ok,
    fullStack,
    checks: [{
      pr: 0,
      name: 'complete-stack',
      ok,
      detail: ok
        ? `provided complete open stack [${expectedNumbers.join(', ')}]`
        : `provided [${selectedNumbers.join(', ')}], but full open stack is [${expectedNumbers.join(', ')}]`,
    }],
  };
}

export function queueTargets(prs) {
  return prs.filter((pr) => pr.state === 'OPEN');
}

export function short(sha) {
  return sha ? String(sha).slice(0, 9) : '(none)';
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function fetchPr(num) {
  const out = gh(['pr', 'view', String(num), '--json',
    'number,headRefOid,headRefName,baseRefName,state,mergeStateStatus,reviewDecision']);
  return JSON.parse(out);
}

function listOpenPrs() {
  const out = gh(['pr', 'list', '--state', 'open', '--limit', '200', '--json',
    'number,headRefOid,headRefName,baseRefName,state']);
  return JSON.parse(out);
}

function addAdminBypassLabel(prNumber) {
  // Avoid `gh pr edit --add-label`: current gh versions query deprecated Projects
  // Classic fields and can fail before the label mutation is attempted.
  gh(['api', '--silent', '--method', 'POST', `repos/{owner}/{repo}/issues/${prNumber}/labels`, '-f', 'labels[]=admin-bypass']);
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

const HELP = `land-stack — verify and land a Mergify PR stack by confirmed PR number

  node scripts/land-stack.mjs <pr> [<pr> ...]              verify confirmed numbers (safe default)
  node scripts/land-stack.mjs <pr> [<pr> ...] --execute    re-verify, then queue the whole stack
  node scripts/land-stack.mjs <pr> ... --base <branch>     trunk branch (default: master)
  node scripts/land-stack.mjs <pr> ... --stack-prefix <p>  required head-branch prefix (default: stack/)

Pass confirmed PR numbers bottom-of-stack first. If numbers are missing, broadly
list open PRs, filter to stack heads, order by base/head links, ask the user to
confirm the suggested numbers, then run this guard. Verification must pass before
anything is queued. --execute adds the admin-bypass label to every verified PR.`;

function printReport(result) {
  const byPr = new Map();
  for (const c of result.checks) {
    if (!byPr.has(c.pr)) byPr.set(c.pr, []);
    byPr.get(c.pr).push(c);
  }
  for (const [pr, checks] of byPr) {
    console.log(`\n${pr === 0 ? 'Stack' : `PR #${pr}`}`);
    for (const c of checks) {
      console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(14)} ${c.detail}`);
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
  let openPrData;
  try {
    prData = args.prs.map(fetchPr);
    openPrData = listOpenPrs();
  } catch (e) {
    console.error(`error: failed to read PR data via gh: ${e.message}`);
    process.exit(2);
  }

  const structureResult = analyzeStack({
    prs: prData,
    hasLocalCommit: localCommitChecker(),
    trunk: args.trunk,
    stackPrefix: args.stackPrefix,
  });
  const completenessResult = analyzeCompleteOpenStack({
    selectedPrs: prData,
    allOpenPrs: openPrData,
    trunk: args.trunk,
    stackPrefix: args.stackPrefix,
  });
  const result = {
    ok: structureResult.ok && completenessResult.ok,
    checks: structureResult.checks.concat(completenessResult.checks),
  };
  printReport(result);

  for (const pr of prData) {
    if (pr.reviewDecision && pr.reviewDecision !== 'APPROVED') {
      console.log(`\nnote: PR #${pr.number} reviewDecision=${pr.reviewDecision}, mergeState=${pr.mergeStateStatus}`);
    }
  }

  if (!result.ok) {
    console.error('\nRESULT: FAILED — not touching any PR. Fix the failures above (or confirm you passed the full bottom-up PR stack).');
    process.exit(1);
  }
  console.log('\nRESULT: verification passed.');

  if (!args.execute) {
    console.log('Re-run with --execute to queue the whole verified stack via admin-bypass.');
    return;
  }

  const targets = queueTargets(prData);
  if (targets.length === 0) {
    console.error('\nerror: no open PRs to queue.');
    process.exit(1);
  }

  console.log(`\nExecuting: adding 'admin-bypass' to ${targets.length} verified PR(s), bottom-to-top.`);
  for (const pr of targets) {
    console.log(`  PR #${pr.number} (head ${short(pr.headRefOid)}, base ${pr.baseRefName})`);
    addAdminBypassLabel(pr.number);
  }
  console.log(`Queued ${targets.length} PR(s) as one stack unit.`);
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
