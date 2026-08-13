#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeStack, analyzeCompleteOpenStack, queueTargets } from './land-stack.mjs';

const TRUNK = 'master';
const ADMIN_BYPASS_LABEL = 'admin-bypass';
const JAILBREAK_MERGED_LABEL = 'jailbreak-merged';

export function planJailbreakActions({ prs, hasLocalCommit }) {
  if (!Array.isArray(prs)) return [];

  const candidates = prs.filter(hasAdminBypassLabel);
  const chains = masterRootedChains(candidates);
  const planned = [];
  const plannedNumbers = new Set();

  for (const chain of chains) {
    const structure = analyzeStack({ prs: chain, hasLocalCommit, trunk: TRUNK });
    const completeness = analyzeCompleteOpenStack({
      selectedPrs: chain,
      allOpenPrs: candidates,
      trunk: TRUNK,
    });
    if (!structure.ok || !completeness.ok) continue;

    for (const pr of queueTargets(chain)) {
      if (isConflict(pr) || plannedNumbers.has(pr.number)) continue;
      planned.push(pr);
      plannedNumbers.add(pr.number);
    }
  }

  return planned;
}

function masterRootedChains(prs) {
  const index = new Map(prs.map((pr, i) => [pr.number, i]));
  const childrenByBase = new Map();
  for (const pr of prs) {
    const children = childrenByBase.get(pr.baseRefName) ?? [];
    children.push(pr);
    childrenByBase.set(pr.baseRefName, children);
  }
  for (const children of childrenByBase.values()) {
    children.sort((a, b) => (index.get(a.number) ?? 0) - (index.get(b.number) ?? 0));
  }

  const bottoms = prs
    .filter((pr) => pr.baseRefName === TRUNK)
    .sort((a, b) => (index.get(a.number) ?? 0) - (index.get(b.number) ?? 0));
  const chains = [];
  const included = new Set();

  for (const bottom of bottoms) {
    if (included.has(bottom.number)) continue;
    const chain = [bottom];
    const seen = new Set([bottom.number]);
    let top = bottom;

    while (true) {
      const children = (childrenByBase.get(top.headRefName) ?? []).filter((pr) => pr.number !== top.number);
      if (children.length !== 1) break;
      const child = children[0];
      if (seen.has(child.number)) break;
      chain.push(child);
      seen.add(child.number);
      top = child;
    }

    chains.push(chain);
    for (const pr of chain) included.add(pr.number);
  }

  return chains;
}

function hasAdminBypassLabel(pr) {
  if (!Object.hasOwn(pr ?? {}, 'labels')) return true;
  const labels = pr.labels;
  if (labels instanceof Set) return labels.has(ADMIN_BYPASS_LABEL);
  if (Array.isArray(labels)) {
    return labels.some((label) => label === ADMIN_BYPASS_LABEL || label?.name === ADMIN_BYPASS_LABEL);
  }
  if (Array.isArray(labels?.nodes)) {
    return labels.nodes.some((label) => label === ADMIN_BYPASS_LABEL || label?.name === ADMIN_BYPASS_LABEL);
  }
  return false;
}

function isConflict(pr) {
  return pr.mergeStateStatus === 'DIRTY' || pr.mergeable === 'CONFLICTING';
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
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

function fetchAdminBypassMasterPrs() {
  const out = gh(['pr', 'list', '--search', 'is:open label:admin-bypass base:master', '--json',
    'number,headRefOid,headRefName,baseRefName,state,mergeStateStatus,mergeable']);
  return JSON.parse(out);
}

function fetchFreshPr(prNumber) {
  const out = gh(['pr', 'view', String(prNumber), '--json', 'headRefOid,mergeStateStatus,mergeable,state']);
  return JSON.parse(out);
}

function addJailbreakMergedLabel(prNumber) {
  gh(['api', '--silent', '--method', 'POST', `repos/{owner}/{repo}/issues/${prNumber}/labels`, '-f', `labels[]=${JAILBREAK_MERGED_LABEL}`]);
}

function appendLedger(pr) {
  const path = `${process.env.TMPDIR || '/tmp'}/invoker-jailbreak-ledger.jsonl`;
  appendFileSync(path, `${JSON.stringify({
    pr: pr.number,
    sha: pr.headRefOid,
    mergedAt: new Date().toISOString(),
    checksSkipped: true,
    reviewSkipped: true,
  })}\n`);
}

function runConcurrencyGate() {
  return spawnSync('node', ['scripts/gh-actions-concurrency-exhausted.mjs'], { stdio: 'inherit' });
}

function main() {
  const gate = runConcurrencyGate();
  if (gate.status !== 0) {
    console.log('not exhausted, nothing to do');
    return;
  }

  let prs;
  try {
    prs = fetchAdminBypassMasterPrs();
  } catch (e) {
    console.error(`error: failed to list admin-bypass PRs: ${e.message}`);
    process.exit(2);
  }

  const planned = planJailbreakActions({ prs, hasLocalCommit: localCommitChecker() });
  if (planned.length === 0) {
    console.log('no jailbreak merge candidates');
    return;
  }

  for (const pr of planned) {
    let freshPr;
    try {
      freshPr = { ...pr, ...fetchFreshPr(pr.number), number: pr.number };
    } catch (e) {
      console.error(`PR #${pr.number}: skip; failed to refresh PR state: ${e.message}`);
      continue;
    }

    const recheck = analyzeStack({ prs: [freshPr], hasLocalCommit: localCommitChecker(), trunk: TRUNK });
    if (!recheck.ok || isConflict(freshPr)) {
      console.log(`PR #${pr.number}: skip; fresh recheck failed`);
      continue;
    }

    if (process.env.INVOKER_JAILBREAK_LIVE !== '1') {
      console.log(`PR #${pr.number}: dry-run would merge head ${freshPr.headRefOid}`);
      continue;
    }

    try {
      gh(['pr', 'merge', String(pr.number), '--squash', '--admin', '--match-head-commit', freshPr.headRefOid]);
      addJailbreakMergedLabel(pr.number);
      appendLedger(freshPr);
      console.log(`PR #${pr.number}: merged head ${freshPr.headRefOid}`);
    } catch (e) {
      console.error(`PR #${pr.number}: merge failed: ${e.message}`);
    }
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
