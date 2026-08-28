#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { collectGuardedBehaviorMarkers } from './validate-pr-body.mjs';

function normalizeReview(review) {
  const login = String(review?.user?.login ?? review?.author?.login ?? '').trim();
  return {
    id: Number(review?.id ?? 0),
    login,
    userType: String(review?.user?.type ?? review?.author?.type ?? ''),
    state: String(review?.state ?? '').toUpperCase(),
    commitId: String(review?.commit_id ?? review?.commitId ?? review?.commit?.oid ?? ''),
    submittedAt: String(review?.submitted_at ?? review?.submittedAt ?? ''),
  };
}

export function isBotReviewer(review) {
  const normalized = normalizeReview(review);
  const login = normalized.login.toLowerCase();
  return normalized.userType.toLowerCase() === 'bot'
    || login.endsWith('[bot]')
    || login.endsWith('-bot')
    || login === 'mergify'
    || login === 'coderabbitai';
}

function latestReviewsByHuman(reviews) {
  const sorted = reviews
    .map(normalizeReview)
    .filter(review => review.login && !isBotReviewer({
      user: { login: review.login, type: review.userType },
    }))
    .sort((left, right) => {
      const timeOrder = left.submittedAt.localeCompare(right.submittedAt);
      return timeOrder !== 0 ? timeOrder : left.id - right.id;
    });
  const latest = new Map();
  for (const review of sorted) latest.set(review.login.toLowerCase(), review);
  return [...latest.values()];
}

export function analyzeGuardedBehaviorApproval({ diffText = '', headSha = '', reviews = [] } = {}) {
  const markers = collectGuardedBehaviorMarkers(diffText);
  if (markers.length === 0) {
    return { eligible: true, guarded: false, markers: [], reason: 'unguarded-diff' };
  }
  if (!headSha) {
    return { eligible: false, guarded: true, markers, reason: 'missing-head-sha', approvingReviewers: [] };
  }

  const latestHumanReviews = latestReviewsByHuman(Array.isArray(reviews) ? reviews : []);
  if (latestHumanReviews.some(review => review.state === 'CHANGES_REQUESTED')) {
    return { eligible: false, guarded: true, markers, reason: 'latest-human-changes-requested', approvingReviewers: [] };
  }

  const approvingReviewers = latestHumanReviews
    .filter(review => review.state === 'APPROVED' && review.commitId === headSha)
    .map(review => review.login)
    .sort();
  if (approvingReviewers.length === 0) {
    const reason = latestHumanReviews.some(review => review.state === 'APPROVED')
      ? 'approval-not-on-current-head'
      : latestHumanReviews.some(review => review.state === 'DISMISSED')
        ? 'approval-dismissed'
        : 'missing-current-head-human-approval';
    return { eligible: false, guarded: true, markers, reason, approvingReviewers: [] };
  }

  return {
    eligible: true,
    guarded: true,
    markers,
    reason: 'current-head-human-approval',
    approvingReviewers,
  };
}

function defaultRunGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function parseReviews(raw) {
  const parsed = JSON.parse(raw || '[]');
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap(value => Array.isArray(value) ? value : [value]);
}

export function checkGuardedBehaviorApprovalForPr({
  prNumber,
  repo,
  headSha,
  runGh = defaultRunGh,
}) {
  if (!Number.isInteger(Number(prNumber)) || Number(prNumber) <= 0) {
    throw new Error(`invalid PR number: ${prNumber}`);
  }
  const prArgs = repo ? ['--repo', repo] : [];
  const resolvedHeadSha = headSha || JSON.parse(runGh([
    'pr', 'view', String(prNumber), ...prArgs, '--json', 'headRefOid',
  ])).headRefOid;
  const diffText = runGh(['pr', 'diff', String(prNumber), ...prArgs]);
  const repoPath = repo || '{owner}/{repo}';
  const reviews = parseReviews(runGh([
    'api', '--paginate', '--slurp', `repos/${repoPath}/pulls/${prNumber}/reviews`,
  ]));
  return analyzeGuardedBehaviorApproval({ diffText, headSha: resolvedHeadSha, reviews });
}

function parseArgs(argv) {
  let prNumber;
  let repo;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pr') prNumber = Number(argv[++index]);
    else if (arg === '--repo') repo = argv[++index];
    else if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  return { prNumber, repo, json, help: false };
}

const HELP = `guarded-behavior-approval — require current-head human approval before admin-bypass

Usage:
  node scripts/guarded-behavior-approval.mjs --pr <number> [--repo owner/repo] [--json]
`;

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}\n${HELP}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!args.prNumber) {
    console.error(`error: --pr is required\n${HELP}`);
    process.exit(2);
  }
  try {
    const result = checkGuardedBehaviorApprovalForPr(args);
    if (args.json) console.log(JSON.stringify(result));
    else console.log(
      result.eligible
        ? `guarded-bypass eligible: ${result.reason}`
        : `guarded-bypass denied: ${result.reason}`,
    );
    if (!result.eligible) process.exit(1);
  } catch (error) {
    console.error(`guarded-bypass check failed: ${error.message}`);
    process.exit(2);
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
