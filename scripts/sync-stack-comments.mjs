#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STACK_COMMENT_MARKER = '<!-- invoker-stack-comment -->';

function runGh(args, options = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

function ghApiJson(path, { method = 'GET', payload, dryRun = false } = {}) {
  if (dryRun) return null;
  const args = ['api', path];
  if (method !== 'GET') {
    args.push('--method', method);
  }
  if (payload !== undefined) {
    args.push('--input', '-');
  }
  const raw = runGh(args, payload === undefined ? {} : { input: JSON.stringify(payload) });
  return JSON.parse(raw);
}

function getRepoNwo() {
  return runGh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
}

function getSourceBranchRef(headRef) {
  if (!headRef.startsWith('stack/')) return headRef;
  const parts = headRef.split('/');
  if (parts.length < 4) return headRef;
  const originalBranch = parts.slice(2).join('/');
  const localBranch = dirname(originalBranch);
  return localBranch === '.' ? headRef : localBranch;
}

function findCurrentStack(openPrs, currentPrNumber) {
  const decorated = openPrs.map((pr) => ({
    number: Number(pr.number),
    title: String(pr.title ?? ''),
    url: String(pr.html_url ?? ''),
    baseRef: String(pr.base?.ref ?? ''),
    headRef: String(pr.head?.ref ?? ''),
    localBranchRef: getSourceBranchRef(String(pr.head?.ref ?? '')),
  }));
  const byNumber = new Map(decorated.map((pr) => [pr.number, pr]));

  function findByLocalBranch(localBranchRef) {
    return decorated.filter((pr) => pr.localBranchRef === localBranchRef);
  }

  const current = byNumber.get(Number(currentPrNumber));
  if (!current) {
    throw new Error(`Current PR #${currentPrNumber} is not open, so its stack cannot be resolved.`);
  }

  const chain = [current];
  const seen = new Set([current.number]);

  let parentCandidates = findByLocalBranch(current.baseRef);
  while (parentCandidates.length > 0) {
    if (parentCandidates.length > 1) {
      throw new Error(`Multiple parent PRs publish local branch ${current.baseRef}.`);
    }
    const parent = parentCandidates[0];
    if (seen.has(parent.number)) {
      throw new Error(`Cycle detected while walking stack ancestors from PR #${currentPrNumber}.`);
    }
    chain.unshift(parent);
    seen.add(parent.number);
    parentCandidates = findByLocalBranch(parent.baseRef);
  }

  let cursor = current;
  while (true) {
    const children = decorated.filter((pr) => pr.baseRef === cursor.localBranchRef);
    if (children.length === 0) break;
    if (children.length > 1) {
      throw new Error(`Multiple child PRs depend on local branch ${cursor.localBranchRef}.`);
    }
    const child = children[0];
    if (seen.has(child.number)) {
      throw new Error(`Cycle detected while walking stack descendants from PR #${currentPrNumber}.`);
    }
    chain.push(child);
    seen.add(child.number);
    cursor = child;
  }

  return chain;
}

function formatStackComment(stack, targetPrNumber) {
  const lines = [
    STACK_COMMENT_MARKER,
    'Full stack for this PR series (bottom → top):',
    '',
  ];

  for (const pr of stack) {
    const suffix = pr.number === targetPrNumber ? ' ← this PR' : '';
    lines.push(`${pr.number}. #${pr.number} — ${pr.title}${suffix}`);
    lines.push(`   Base: ${pr.baseRef}`);
    lines.push(`   Link: ${pr.url}`);
  }

  return `${lines.join('\n')}\n`;
}

function listOpenPullRequests(nwo, dryRun = false) {
  if (dryRun) return [];
  const data = ghApiJson(`repos/${nwo}/pulls?state=open&per_page=100`, { dryRun });
  return Array.isArray(data) ? data : [];
}

function listIssueComments(nwo, prNumber, dryRun = false) {
  if (dryRun) return [];
  const data = ghApiJson(`repos/${nwo}/issues/${prNumber}/comments?per_page=100`, { dryRun });
  return Array.isArray(data) ? data : [];
}

function upsertStackComment(nwo, prNumber, body, dryRun = false) {
  const existing = listIssueComments(nwo, prNumber, dryRun).find((comment) => {
    return typeof comment?.body === 'string' && comment.body.includes(STACK_COMMENT_MARKER);
  });
  if (dryRun) return;
  if (existing?.id) {
    ghApiJson(`repos/${nwo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      payload: { body },
    });
    return;
  }
  ghApiJson(`repos/${nwo}/issues/${prNumber}/comments`, {
    method: 'POST',
    payload: { body },
  });
}

export function syncStackCommentsForPr(nwo, currentPrNumber, { dryRun = false } = {}) {
  const stack = findCurrentStack(listOpenPullRequests(nwo, dryRun), currentPrNumber);
  for (const pr of stack) {
    upsertStackComment(nwo, pr.number, formatStackComment(stack, pr.number), dryRun);
  }
  return stack;
}

function parseArgs(argv) {
  let repo = '';
  let pr = 0;
  let dryRun = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      repo = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--pr') {
      pr = Number(argv[index + 1] ?? '0');
      index += 1;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!pr) {
    throw new Error('Missing required --pr <number>.');
  }

  return {
    repo: repo || getRepoNwo(),
    pr,
    dryRun,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const stack = syncStackCommentsForPr(args.repo, args.pr, { dryRun: args.dryRun });
  if (args.dryRun) {
    console.error(`Would sync stack comments across ${stack.length} PRs.`);
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] || '')) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
