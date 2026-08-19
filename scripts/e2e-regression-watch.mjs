#!/usr/bin/env node
// Watches default-branch `ci.yml` push runs and files one Invoker repair plan
// per active (first-bad SHA, CI job) failure. Local state records observed HEAD
// SHAs and job outcomes; live Invoker workflow state remains the dedup source
// for repairs in flight.
import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldRetry, isStale } from './retry-ledger.mjs';
import { insertRepairFiling, releaseRepairFiling } from './repair-filing-ledger.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));

function resolveYamlModulePath() {
  const localYamlPath = resolve(REPO_ROOT, 'packages/app/node_modules/yaml/dist/index.js');
  if (existsSync(localYamlPath)) return localYamlPath;
  return 'yaml';
}
const { parse: parseYaml } = await import(resolveYamlModulePath());

export const TARGET_REPO = process.env.INVOKER_GITHUB_TARGET_REPO ?? 'Neko-Catpital-Labs/Invoker';
export const WORKFLOW_FILE = process.env.INVOKER_CI_WATCH_WORKFLOW_FILE
  ?? process.env.INVOKER_E2E_WATCH_WORKFLOW_FILE
  ?? 'ci.yml';
export const WATCH_BRANCHES = (process.env.INVOKER_CI_WATCH_BRANCHES ?? 'master,main')
  .split(',')
  .map((branch) => branch.trim())
  .filter(Boolean);
export const RUN_LIST_LIMIT = Number(process.env.INVOKER_CI_WATCH_RUN_LIMIT ?? '50');
export const CAP_PER_SWEEP = Number(process.env.INVOKER_CI_WATCH_CAP
  ?? process.env.INVOKER_E2E_WATCH_CAP
  ?? '0');
export const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'failed', 'closed', 'cancelled', 'stale']);
export const BROKEN_JOB_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required']);
export const IGNORED_JOB_CONCLUSIONS = new Set(['cancelled', 'skipped', 'neutral']);
export const MARKER_PREFIX = 'invoker-ci-regression-watch: first-bad-sha=';
export const CI_REGRESSION_REFLECT_ENV = 'INVOKER_CI_REGRESSION_REFLECT';
export const CATSTACK_REPO_URL = 'https://github.com/EdbertChan/catstack.git';
export const STATE_SCHEMA_VERSION = 4;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const MAX_ATTEMPTS = parseNonNegativeInteger(
  process.env.INVOKER_CI_WATCH_MAX_ATTEMPTS,
  DEFAULT_MAX_ATTEMPTS,
);
export const FLEET_EVENT_THRESHOLD = parsePositiveInteger(
  process.env.INVOKER_CI_WATCH_FLEET_THRESHOLD,
  3,
);
export const ATTEMPT_BACKOFF_BASE_MS = 30 * 60 * 1000;
/**
 * How long a job's attempt/backoff/occurrence history survives after CI
 * reports it green, before a later red observation is treated as a brand
 * new regression. Without this, one green run on a flaky job (one that
 * flaps pass/fail on the same underlying defect) wipes `attempts` back to
 * 0, handing it a fresh attempt budget every flap and defeating the cap
 * in `shouldFileFailure`.
 */
export const RECOVERY_COOLDOWN_MS = parseNonNegativeInteger(
  process.env.INVOKER_CI_WATCH_RECOVERY_COOLDOWN_MS,
  24 * 60 * 60 * 1000,
);
/**
 * A job CI hasn't reported on (green or red) in this long is presumed
 * renamed, removed, or otherwise no longer produced by the current
 * workflow -- most concretely, a job kept "mapped" only by a
 * LEGACY_PLAYWRIGHT_JOB_ALIASES-style compatibility shim after a shard
 * rename. Such a job can never again resolve itself via a real 'ok'
 * observation in reconcileCiRun, so the filing sweep retires it instead of
 * re-filing repairs against it forever.
 */
export const STALE_OBSERVATION_MS = parseNonNegativeInteger(
  process.env.INVOKER_CI_WATCH_STALE_OBSERVATION_MS,
  3 * 24 * 60 * 60 * 1000,
);

export function isObservationStale(failure, nowMs, staleMs = STALE_OBSERVATION_MS) {
  return isStale({ lastObservedAt: failure?.lastObservedAt, nowMs, staleMs });
}

const STATE_DIR = process.env.INVOKER_CI_WATCH_STATE_DIR
  ?? process.env.INVOKER_E2E_WATCH_STATE_DIR
  ?? join(homedir(), '.invoker', 'e2e-regression-watch');
const STATE_FILE = join(STATE_DIR, 'state.json');
const SWEEP_LOG_FILE = join(STATE_DIR, 'sweep-log.jsonl');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', WORKFLOW_FILE);
/**
 * Shared fleet-wide auto-fix pause flag, same file and format written by
 * packages/execution-engine/src/auto-fix-circuit-breaker.ts. One usage-limit
 * failure anywhere in Invoker (not just here) pauses this watcher's filing
 * too, since a filed repair here dispatches the same rate-limited agent.
 */
const AUTO_FIX_PAUSE_FILE = process.env.INVOKER_AUTO_FIX_PAUSE_FILE
  ?? join(homedir(), '.invoker', 'auto-fix-pause.json');

export function isAutoFixCircuitBreakerPaused(nowMs = Date.now(), path = AUTO_FIX_PAUSE_FILE) {
  if (!existsSync(path)) return false;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw?.pausedUntil) return false;
    const untilMs = new Date(raw.pausedUntil).getTime();
    return Number.isFinite(untilMs) && nowMs < untilMs;
  } catch {
    return false;
  }
}
const BUILD_APP_COMMAND = [
  'pnpm --filter @invoker/ui build',
  'pnpm --filter @invoker/surfaces build',
  'pnpm --filter @invoker/app build',
].join(' && ');

const LEGACY_PLAYWRIGHT_JOB_ALIASES = new Map([
  [
    'playwright / launch-dispatch-stuck-lease',
    {
      name: 'launch-dispatch-stuck-lease',
      files: [
        'e2e/launch-dispatch-stuck-lease-cap.spec.ts',
        'e2e/launch-dispatch-stuck-lease-storm.spec.ts',
      ].join(' '),
    },
  ],
]);

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

export function shortSha(sha) {
  return String(sha).slice(0, 7);
}

export function slugify(value, maxLength = 72) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return (slug || 'ci-job').slice(0, maxLength).replace(/-+$/g, '') || 'ci-job';
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function buildMarker(sha, jobName) {
  return `${MARKER_PREFIX}${sha}; job=${jobName}`;
}

export function buildMarkerComment(sha, jobName) {
  return `<!-- ${buildMarker(sha, jobName)} -->`;
}

export function loadEmptyState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    lastProcessedRunId: 0,
    heads: {},
    activeFailures: {},
  };
}

function normalizeActiveFailure(failure, fallbackJobName) {
  if (!failure || typeof failure !== 'object') return null;
  const jobName = typeof failure.jobName === 'string' && failure.jobName
    ? failure.jobName
    : fallbackJobName;
  if (typeof jobName !== 'string' || !jobName) return null;
  return {
    ...failure,
    jobName,
    attempts: Number.isFinite(Number(failure.attempts))
      ? Math.max(0, Number(failure.attempts))
      : 0,
    lastFiledAt: typeof failure.lastFiledAt === 'string' && failure.lastFiledAt
      ? failure.lastFiledAt
      : null,
    needsHuman: Boolean(failure.needsHuman),
    retired: Boolean(failure.retired),
  };
}

function normalizeActiveFailures(activeFailures) {
  if (!activeFailures || typeof activeFailures !== 'object') return {};
  return Object.fromEntries(
    Object.entries(activeFailures)
      .map(([jobName, failure]) => [jobName, normalizeActiveFailure(failure, jobName)])
      .filter(([, failure]) => failure !== null),
  );
}

function normalizeStateForMutation(state) {
  const normalized = normalizeState(state);
  if (state && typeof state === 'object') {
    Object.assign(state, normalized);
    return state;
  }
  return normalized;
}

export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') {
    return loadEmptyState();
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    lastProcessedRunId: Number(raw.lastProcessedRunId ?? 0),
    heads: raw.heads && typeof raw.heads === 'object' ? raw.heads : {},
    activeFailures: normalizeActiveFailures(raw.activeFailures),
  };
}

export function classifyJobConclusion(job) {
  if (!job || job.status !== 'completed') return 'pending';
  const conclusion = String(job.conclusion ?? '');
  if (conclusion === 'success') return 'ok';
  if (BROKEN_JOB_CONCLUSIONS.has(conclusion)) return 'broken';
  if (IGNORED_JOB_CONCLUSIONS.has(conclusion)) return 'ignored';
  return 'ignored';
}

export function reconcileCiRun(state, run) {
  const normalized = normalizeStateForMutation(state);
  const sha = String(run.headSha ?? '').trim();
  if (!sha) return { state: normalized, processedJobs: 0, brokenJobs: 0, okJobs: 0, ignoredJobs: 0 };

  const headRecord = normalized.heads[sha] ?? {
    sha,
    branch: run.headBranch ?? '',
    firstRunId: run.databaseId,
    lastRunId: run.databaseId,
    createdAt: run.createdAt ?? '',
    jobs: {},
  };
  headRecord.branch = run.headBranch ?? headRecord.branch;
  headRecord.lastRunId = run.databaseId ?? headRecord.lastRunId;
  headRecord.updatedAt = new Date().toISOString();
  normalized.heads[sha] = headRecord;

  let processedJobs = 0;
  let brokenJobs = 0;
  let okJobs = 0;
  let ignoredJobs = 0;

  for (const job of run.jobs ?? []) {
    const jobName = typeof job.name === 'string' ? job.name.trim() : '';
    if (!jobName) continue;
    const classification = classifyJobConclusion(job);
    if (classification === 'pending') continue;
    processedJobs += 1;

    const baseObservation = {
      jobName,
      conclusion: job.conclusion ?? '',
      runId: run.databaseId,
      jobDatabaseId: job.databaseId,
      url: job.url ?? '',
      observedAt: job.completedAt ?? job.startedAt ?? run.createdAt ?? '',
    };

    if (classification === 'ok') {
      okJobs += 1;
      headRecord.jobs[jobName] = { ...baseObservation, state: 'ok' };
      const existing = normalized.activeFailures[jobName];
      const lastFiledMs = existing?.lastFiledAt ? new Date(existing.lastFiledAt).getTime() : NaN;
      const observedAtMs = baseObservation.observedAt ? new Date(baseObservation.observedAt).getTime() : NaN;
      const withinRecoveryCooldown = existing
        && Number.isFinite(lastFiledMs)
        && Number.isFinite(observedAtMs)
        && (observedAtMs - lastFiledMs) < RECOVERY_COOLDOWN_MS;
      // A flaky job can report green once and then red again shortly after
      // on the same underlying defect. Keep attempts/occurrences/lastFiledAt
      // through the cooldown so that flap resumes the existing backoff
      // instead of starting over; getActionableFailures excludes it via
      // lastObservedState while it reads as currently green.
      if (withinRecoveryCooldown) {
        normalized.activeFailures[jobName] = {
          ...existing,
          ...normalizeActiveFailure(existing, jobName),
          lastObservedState: 'ok',
        };
      } else {
        delete normalized.activeFailures[jobName];
      }
      continue;
    }

    if (classification === 'broken') {
      brokenJobs += 1;
      headRecord.jobs[jobName] = { ...baseObservation, state: 'broken' };
      const existing = normalized.activeFailures[jobName];
      if (existing) {
        normalized.activeFailures[jobName] = {
          ...existing,
          ...normalizeActiveFailure(existing, jobName),
          lastBadSha: sha,
          lastBadRunId: run.databaseId,
          lastJobDatabaseId: job.databaseId,
          lastJobUrl: job.url ?? '',
          lastObservedAt: baseObservation.observedAt,
          occurrences: Number(existing.occurrences ?? 1) + 1,
          lastObservedState: 'broken',
        };
      } else {
        normalized.activeFailures[jobName] = {
          jobName,
          firstBadSha: sha,
          firstBadRunId: run.databaseId,
          firstBadRunCreatedAt: run.createdAt ?? '',
          firstJobDatabaseId: job.databaseId,
          firstJobUrl: job.url ?? '',
          lastBadSha: sha,
          lastBadRunId: run.databaseId,
          lastJobDatabaseId: job.databaseId,
          lastJobUrl: job.url ?? '',
          lastObservedAt: baseObservation.observedAt,
          occurrences: 1,
          attempts: 0,
          lastFiledAt: null,
          needsHuman: false,
          lastObservedState: 'broken',
        };
      }
      continue;
    }

    ignoredJobs += 1;
    if (!headRecord.jobs[jobName]) {
      headRecord.jobs[jobName] = { ...baseObservation, state: 'ignored' };
    }
  }

  return { state: normalized, processedJobs, brokenJobs, okJobs, ignoredJobs };
}

export function getActionableFailures(state) {
  const normalized = normalizeState(state);
  return Object.values(normalized.activeFailures)
    .filter((failure) => failure && typeof failure.jobName === 'string' && typeof failure.firstBadSha === 'string')
    // Retained during the post-recovery cooldown (see reconcileCiRun) purely
    // to preserve attempt/backoff history for a possible flap back to red;
    // CI currently reports it passing, so it is not actionable right now.
    .filter((failure) => failure.lastObservedState !== 'ok')
    .sort((a, b) => {
      const runDelta = Number(a.firstBadRunId ?? 0) - Number(b.firstBadRunId ?? 0);
      if (runDelta !== 0) return runDelta;
      return a.jobName.localeCompare(b.jobName);
    });
}

function isFleetEventFailure(failure) {
  return Boolean(failure?.isFleetEvent) || failure?.markerJobName === 'fleet';
}

export function groupFailuresBySha(failures) {
  const groups = new Map();
  for (const failure of failures ?? []) {
    if (isFleetEventFailure(failure)) continue;
    const sha = typeof failure?.firstBadSha === 'string' ? failure.firstBadSha.trim() : '';
    if (!sha) continue;
    const group = groups.get(sha) ?? [];
    group.push(failure);
    groups.set(sha, group);
  }
  return groups;
}

export function shouldFileFailure(failure, {
  nowMs = Date.now(),
  maxAttempts = MAX_ATTEMPTS,
  backoffBaseMs = ATTEMPT_BACKOFF_BASE_MS,
} = {}) {
  return shouldRetry({
    attempts: failure?.attempts,
    lastAttemptAt: failure?.lastFiledAt,
    nowMs,
    maxAttempts,
    backoffBaseMs,
  });
}

export function markFailureNeedsHuman(state, failure) {
  const normalized = normalizeStateForMutation(state);
  const jobName = failure.jobName;
  const existing = normalized.activeFailures[jobName];
  if (!existing) return normalized;
  normalized.activeFailures[jobName] = {
    ...existing,
    needsHuman: true,
  };
  return normalized;
}

export function markFailureRetired(state, failure, retired = true) {
  const normalized = normalizeStateForMutation(state);
  const jobName = failure.jobName;
  const existing = normalized.activeFailures[jobName];
  if (!existing) return normalized;
  normalized.activeFailures[jobName] = {
    ...existing,
    retired: Boolean(retired),
  };
  return normalized;
}

export function recordFailureFiled(state, failure, filedAt = new Date()) {
  const normalized = normalizeStateForMutation(state);
  const jobName = failure.jobName;
  const existing = normalized.activeFailures[jobName];
  if (!existing) return normalized;
  normalized.activeFailures[jobName] = {
    ...existing,
    attempts: Number(existing.attempts ?? 0) + 1,
    lastFiledAt: filedAt.toISOString(),
    needsHuman: false,
    retired: false,
  };
  return normalized;
}

function getVerifyCommandForFailure(failure, jobDefinitions) {
  if (typeof failure?.verifyCommand === 'string' && failure.verifyCommand.trim()) {
    return failure.verifyCommand.trim();
  }
  const definition = jobDefinitions?.get(failure?.jobName);
  return definition?.verifyCommand?.trim() ?? '';
}

function failureIsMapped(failure, jobDefinitions) {
  return Boolean(getVerifyCommandForFailure(failure, jobDefinitions));
}

// Deliberately does NOT embed the member-job count: membership can change
// between sweeps (a 4th co-failing job joins, or one flips back to green)
// without that being a *different* fleet event for dedup purposes. The
// member list belongs in the failure description/metadata, not the key --
// see buildFleetFailureDescription and REPAIR_FILING_KIND_FLEET's stateSha.
function buildFleetJobName(sha) {
  return `fleet / ${shortSha(sha)}`;
}

function buildFleetFailureDescription(sha, members) {
  const memberLines = members.map((member) => {
    const url = typeof member.firstJobUrl === 'string' && member.firstJobUrl
      ? member.firstJobUrl
      : '(no first job URL recorded)';
    return `- ${member.jobName}: ${url}`;
  });
  return [
    `Fleet-correlated CI event: ${members.length} jobs first failed on default-branch push commit ${sha}.`,
    'Member jobs:',
    ...memberLines,
  ].join('\n');
}

function pickFleetVerifyCommand(members, jobDefinitions) {
  return members
    .map((member) => ({
      jobName: member.jobName,
      verifyCommand: getVerifyCommandForFailure(member, jobDefinitions),
    }))
    .filter((entry) => entry.verifyCommand)
    .sort((a, b) => {
      const lengthDelta = a.verifyCommand.length - b.verifyCommand.length;
      if (lengthDelta !== 0) return lengthDelta;
      return a.jobName.localeCompare(b.jobName);
    })
    .at(0)?.verifyCommand ?? '';
}

function synthesizeFleetFailure(state, sha, members, jobDefinitions) {
  const verifyCommand = pickFleetVerifyCommand(members, jobDefinitions);
  if (!verifyCommand) return null;

  const existing = Object.values(state.activeFailures ?? {})
    .find((failure) => isFleetEventFailure(failure) && failure.firstBadSha === sha);
  const sortedMembers = [...members].sort((a, b) => a.jobName.localeCompare(b.jobName));
  const firstMember = [...members].sort((a, b) => {
    const runDelta = Number(a.firstBadRunId ?? 0) - Number(b.firstBadRunId ?? 0);
    if (runDelta !== 0) return runDelta;
    return a.jobName.localeCompare(b.jobName);
  }).at(0);
  const lastMember = [...members].sort((a, b) => {
    const runDelta = Number(b.lastBadRunId ?? b.firstBadRunId ?? 0) - Number(a.lastBadRunId ?? a.firstBadRunId ?? 0);
    if (runDelta !== 0) return runDelta;
    return a.jobName.localeCompare(b.jobName);
  }).at(0);
  const jobName = buildFleetJobName(sha);
  return {
    ...(existing ?? {}),
    jobName,
    markerJobName: 'fleet',
    isFleetEvent: true,
    firstBadSha: sha,
    firstBadRunId: firstMember?.firstBadRunId ?? '',
    firstBadRunCreatedAt: firstMember?.firstBadRunCreatedAt ?? '',
    firstJobDatabaseId: firstMember?.firstJobDatabaseId ?? '',
    firstJobUrl: firstMember?.firstJobUrl ?? '',
    lastBadSha: lastMember?.lastBadSha ?? sha,
    lastBadRunId: lastMember?.lastBadRunId ?? firstMember?.firstBadRunId ?? '',
    lastJobDatabaseId: lastMember?.lastJobDatabaseId ?? firstMember?.firstJobDatabaseId ?? '',
    lastJobUrl: lastMember?.lastJobUrl ?? firstMember?.firstJobUrl ?? '',
    lastObservedAt: lastMember?.lastObservedAt ?? firstMember?.lastObservedAt ?? '',
    occurrences: members.reduce((sum, member) => sum + Number(member.occurrences ?? 1), 0),
    attempts: Number(existing?.attempts ?? 0),
    lastFiledAt: existing?.lastFiledAt ?? null,
    needsHuman: Boolean(existing?.needsHuman),
    retired: Boolean(existing?.retired),
    verifyCommand,
    description: buildFleetFailureDescription(sha, sortedMembers),
    memberJobNames: sortedMembers.map((member) => member.jobName),
  };
}

function prepareFleetCorrelatedFailures(state, failures, {
  threshold = FLEET_EVENT_THRESHOLD,
  jobDefinitions = null,
  maxAttempts = MAX_ATTEMPTS,
  nowMs = Date.now(),
} = {}) {
  const normalized = normalizeStateForMutation(state);
  const groups = groupFailuresBySha(failures);
  const correlated = new Set();
  const fleetFailures = [];
  const retiredFleetMembers = [];
  let stateChanged = false;
  let groupsNeedingHuman = 0;
  const existingFleetBySha = new Map(
    Object.values(normalized.activeFailures)
      .filter((failure) => isFleetEventFailure(failure) && typeof failure.firstBadSha === 'string')
      .map((failure) => [failure.firstBadSha, failure]),
  );

  for (const [sha, members] of groups) {
    if (members.length < threshold && !existingFleetBySha.has(sha)) continue;
    const fleetFailure = synthesizeFleetFailure(normalized, sha, members, jobDefinitions);
    if (!fleetFailure) {
      if (existingFleetBySha.has(sha)) {
        const existingFleetEntry = existingFleetBySha.get(sha);
        if (normalized.activeFailures[existingFleetEntry.jobName]) {
          normalized.activeFailures[existingFleetEntry.jobName] = {
            ...normalized.activeFailures[existingFleetEntry.jobName],
            retired: true,
          };
          stateChanged = true;
        }
      }
      for (const member of members) {
        const existing = normalized.activeFailures[member.jobName];
        if (!existing) continue;
        normalized.activeFailures[member.jobName] = {
          ...existing,
          memberOfFleetEvent: sha,
          retired: true,
        };
        retiredFleetMembers.push(normalized.activeFailures[member.jobName]);
        correlated.add(member.jobName);
        stateChanged = true;
      }
      continue;
    }

    const existingFleet = Object.values(normalized.activeFailures)
      .find((failure) => isFleetEventFailure(failure) && failure.firstBadSha === sha);
    if (existingFleet?.jobName && existingFleet.jobName !== fleetFailure.jobName) {
      delete normalized.activeFailures[existingFleet.jobName];
    }

    // When the consolidated fleet key has exhausted its attempt budget,
    // keep the fleet record as needs-human but stop swallowing members —
    // otherwise those jobs sit forever at attempts:0 with no repair queued.
    const fleetGate = shouldFileFailure(fleetFailure, { nowMs, maxAttempts });
    if (fleetGate.action === 'needs-human') {
      normalized.activeFailures[fleetFailure.jobName] = {
        ...fleetFailure,
        needsHuman: true,
      };
      groupsNeedingHuman += 1;
      stateChanged = true;
      continue;
    }

    normalized.activeFailures[fleetFailure.jobName] = fleetFailure;
    fleetFailures.push(fleetFailure);
    stateChanged = true;

    for (const member of members) {
      const existing = normalized.activeFailures[member.jobName];
      if (!existing) continue;
      normalized.activeFailures[member.jobName] = {
        ...existing,
        memberOfFleetEvent: sha,
      };
      correlated.add(member.jobName);
      stateChanged = true;
    }
  }

  for (const [sha, existingFleet] of existingFleetBySha) {
    if (!groups.has(sha) && existingFleet?.jobName && normalized.activeFailures[existingFleet.jobName]) {
      delete normalized.activeFailures[existingFleet.jobName];
      stateChanged = true;
    }
  }

  const prepared = [
    ...fleetFailures,
    ...failures.filter((failure) => {
      if (isFleetEventFailure(failure)) return false;
      return !correlated.has(failure.jobName);
    }),
  ].sort((a, b) => {
    const runDelta = Number(a.firstBadRunId ?? 0) - Number(b.firstBadRunId ?? 0);
    if (runDelta !== 0) return runDelta;
    return a.jobName.localeCompare(b.jobName);
  });

  for (const failure of failures) {
    if (correlated.has(failure.jobName)) continue;
    const existing = normalized.activeFailures[failure.jobName];
    if (existing?.memberOfFleetEvent) {
      const { memberOfFleetEvent, ...withoutFleetMembership } = existing;
      normalized.activeFailures[failure.jobName] = withoutFleetMembership;
      stateChanged = true;
    }
  }

  return {
    failures: prepared,
    groupsCorrelated: fleetFailures.length,
    groupsNeedingHuman,
    retiredFleetMembers,
    stateChanged,
  };
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function collapseShellLines(value) {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' && ');
}

function renderGithubTemplate(value, matrix = {}) {
  return String(value).replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g, (_match, key) => {
    const rendered = matrix[key];
    return rendered == null ? '' : String(rendered);
  });
}

function cartesianProduct(entries) {
  return entries.reduce((acc, [key, values]) => {
    const out = [];
    for (const item of acc) {
      for (const value of values) out.push({ ...item, [key]: value });
    }
    return out;
  }, [{}]);
}

export function expandMatrix(matrix) {
  if (!matrix || typeof matrix !== 'object') return [{}];
  if (Array.isArray(matrix.include) && matrix.include.length > 0) {
    return matrix.include.map((entry) => ({ ...entry }));
  }
  const axes = Object.entries(matrix)
    .filter(([key, value]) => key !== 'include' && Array.isArray(value))
    .map(([key, value]) => [key, value]);
  if (axes.length === 0) return [{}];
  return cartesianProduct(axes);
}

function jobDownloadsBuildArtifacts(job) {
  return (job.steps ?? []).some((step) => {
    const uses = typeof step.uses === 'string' ? step.uses : '';
    return uses.includes('actions/download-artifact');
  });
}

function withBuildPrefix(command, needsBuild) {
  return needsBuild ? `${BUILD_APP_COMMAND} && ${command}` : command;
}

function commandForJob(jobId, job, matrix) {
  const needsBuild = jobDownloadsBuildArtifacts(job);
  if (jobId === 'build-artifacts') return BUILD_APP_COMMAND;
  if (jobId === 'ui-vitest') return 'pnpm --filter @invoker/ui test';
  if (jobId === 'playwright' || jobId === 'playwright-nightly-perf') {
    const labelPrefix = jobId === 'playwright' ? 'ci-playwright' : 'ci-playwright-nightly-perf';
    const command = [
      'env',
      `INVOKER_PLAYWRIGHT_RUN_LABEL=${shellSingleQuote(`${labelPrefix}-${matrix.name}`)}`,
      'INVOKER_PLAYWRIGHT_WORKERS=1',
      `INVOKER_PLAYWRIGHT_FILES=${shellSingleQuote(String(matrix.files ?? '').trim().replace(/\s+/g, ' '))}`,
      `INVOKER_PLAYWRIGHT_ARGS=${shellSingleQuote('--reporter=line')}`,
      'bash scripts/test-suites/optional/40-playwright-app.sh',
    ].join(' ');
    return withBuildPrefix(command, true);
  }
  if (jobId === 'e2e-proof') {
    const command = [
      'env',
      'INVOKER_TEST_ALL_PROOF=1',
      `INVOKER_TEST_ALL_SHARD_INDEX=${shellSingleQuote(String(matrix.shard))}`,
      'INVOKER_TEST_ALL_SHARD_TOTAL=4',
      'INVOKER_TEST_ALL_STATE_FILE=/tmp/invoker-ci-watch-proof-state.tsv',
      'TMPDIR=/tmp/invoker-tmp',
      'bash scripts/run-all-tests.sh',
    ].join(' ');
    return withBuildPrefix(command, true);
  }
  if (jobId === 'e2e-proof-aggregate') {
    return withBuildPrefix(
      'env INVOKER_TEST_ALL_PROOF=1 INVOKER_TEST_ALL_AGGREGATE=1 '
        + 'INVOKER_TEST_ALL_STATE_FILE=/tmp/invoker-ci-watch-merged-proof-state.tsv bash scripts/run-all-tests.sh',
      true,
    );
  }
  if (jobId === 'ssh') return withBuildPrefix(`bash ${shellSingleQuote(matrix.suite)}`, true);
  if (jobId === 'reset-rulebook-repro') {
    return withBuildPrefix('bash scripts/test-suites/required/26-reset-rulebook-proof.sh', true);
  }
  if (jobId === 'scheduled-repros') {
    return withBuildPrefix(
      'bash scripts/test-suites/required/23-fix-intent-repros.sh '
        + '&& pnpm --filter @invoker/app test --run src/__tests__/dispatch-capacity-invariants.test.ts',
      true,
    );
  }
  if (jobId === 'docker') {
    return withBuildPrefix(
      'bash scripts/build-agent-base-image.sh '
        + '&& docker build -t invoker-agent:latest scripts/fixtures/hello-world-agent '
        + '&& bash scripts/test-suites/dangerous/10-docker-comprehensive.sh',
      true,
    );
  }
  if (typeof matrix.command === 'string') return withBuildPrefix(collapseShellLines(matrix.command), needsBuild);

  const runSteps = (job.steps ?? [])
    .map((step) => (typeof step.run === 'string' ? renderGithubTemplate(step.run, matrix) : ''))
    .map(collapseShellLines)
    .filter(Boolean);
  const lastRun = runSteps.at(-1);
  if (lastRun) return withBuildPrefix(lastRun, needsBuild);
  return '';
}

export function buildCiJobDefinitions(workflow = parseYaml(readFileSync(WORKFLOW_PATH, 'utf8'))) {
  const definitions = new Map();
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    for (const matrix of expandMatrix(job.strategy?.matrix)) {
      const jobName = renderGithubTemplate(job.name ?? jobId, matrix).trim();
      if (!jobName) continue;
      definitions.set(jobName, {
        jobId,
        jobName,
        matrix,
        verifyCommand: commandForJob(jobId, job, matrix),
      });
    }
  }
  const playwrightJob = workflow.jobs?.playwright;
  if (playwrightJob) {
    for (const [jobName, matrix] of LEGACY_PLAYWRIGHT_JOB_ALIASES) {
      if (definitions.has(jobName)) continue;
      definitions.set(jobName, {
        jobId: 'playwright',
        jobName,
        matrix,
        verifyCommand: commandForJob('playwright', playwrightJob, matrix),
      });
    }
  }
  return definitions;
}

export function jobNameIsMapped(jobName, jobDefinitions) {
  const definition = jobDefinitions?.get(jobName);
  return Boolean(definition?.verifyCommand?.trim());
}

export function fallbackVerifyCommand(jobName) {
  return `bash -lc ${shellSingleQuote(`echo "No local verify command is mapped for CI job: ${jobName}" >&2; exit 1`)}`;
}

export function buildPlanVars(failure, repoUrl, jobDefinitions = buildCiJobDefinitions()) {
  const short = shortSha(failure.firstBadSha);
  const jobSlug = `${short}-${slugify(failure.jobName)}`;
  const verifyCommand = getVerifyCommandForFailure(failure, jobDefinitions) || fallbackVerifyCommand(failure.jobName);
  const markerJobName = failure.markerJobName ?? failure.jobName;
  const failureDescription = typeof failure.description === 'string' && failure.description.trim()
    ? failure.description.trim()
    : [
      `CI job \`${failure.jobName}\` first failed on default-branch push commit ${failure.firstBadSha}`,
      `in run ${failure.firstBadRunId ?? ''}. It was most recently still red at ${failure.lastBadSha ?? failure.firstBadSha}`,
      `in run ${failure.lastBadRunId ?? failure.firstBadRunId ?? ''}.`,
      '',
      `First bad job: ${failure.firstJobUrl ?? ''}`,
    ].join('\n');
  return {
    repo_url: repoUrl,
    base_branch: 'master',
    sha: failure.firstBadSha,
    short_sha: short,
    job_name: failure.jobName,
    job_slug: jobSlug,
    run_id: String(failure.firstBadRunId ?? ''),
    job_database_id: String(failure.firstJobDatabaseId ?? ''),
    job_url: failure.firstJobUrl ?? '',
    last_bad_sha: failure.lastBadSha ?? failure.firstBadSha,
    last_bad_run_id: String(failure.lastBadRunId ?? failure.firstBadRunId ?? ''),
    verify_command: verifyCommand,
    marker: buildMarkerComment(failure.firstBadSha, markerJobName),
    failure_description: failureDescription.split(/\r?\n/).join('\n  '),
  };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function runCommand(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT, ...opts });
}

function ghJson(args) {
  const raw = execFileSync('gh', args, { encoding: 'utf8', cwd: REPO_ROOT });
  return JSON.parse(raw);
}

export function getRepoUrl() {
  return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', cwd: REPO_ROOT }).trim();
}

export function listUnprocessedDefaultBranchRuns(
  lastProcessedRunId,
  { branches = WATCH_BRANCHES, limit = RUN_LIST_LIMIT } = {},
) {
  const byId = new Map();
  for (const branch of branches) {
    const runs = ghJson([
      'run', 'list', '--repo', TARGET_REPO, '--workflow', WORKFLOW_FILE,
      '--branch', branch, '--event', 'push', '--status', 'completed',
      '--json', 'databaseId,headSha,headBranch,event,status,conclusion,createdAt,updatedAt',
      '--limit', String(limit),
    ]);
    for (const run of runs) {
      if (Number(run.databaseId) > Number(lastProcessedRunId)) byId.set(run.databaseId, run);
    }
  }
  return Array.from(byId.values()).sort((a, b) => Number(a.databaseId) - Number(b.databaseId));
}

export function getCiRun(runId) {
  return ghJson([
    'run', 'view', String(runId), '--repo', TARGET_REPO,
    '--json', 'databaseId,headSha,headBranch,event,status,conclusion,createdAt,jobs',
  ]);
}

function headlessQueryWorkflowsJson() {
  return execSync(
    `source "${join(REPO_ROOT, 'scripts', 'headless-lib.sh')}" && headless_query query workflows --output json`,
    {
      shell: '/bin/bash',
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 90_000,
      killSignal: 'SIGKILL',
    },
  );
}

export function liveQueryHasNonTerminalWork(failureOrSha, jobName, queryFn = headlessQueryWorkflowsJson) {
  const sha = typeof failureOrSha === 'object' ? failureOrSha.firstBadSha : failureOrSha;
  const job = typeof failureOrSha === 'object'
    ? (failureOrSha.markerJobName ?? failureOrSha.jobName)
    : jobName;
  const marker = buildMarker(sha, job);
  let workflows;
  try {
    workflows = JSON.parse(queryFn());
  } catch (err) {
    // A bad query response (truncated output, transient CLI failure, ...)
    // must not crash the whole sweep and must not risk filing a duplicate
    // fix for work that may already be running -- fail closed by assuming
    // non-terminal work exists, so this one failure is skipped this round
    // and picked back up on the next sweep once the query is healthy again.
    console.error(`ci-regression-watch: liveQueryHasNonTerminalWork query failed for marker "${marker}", assuming non-terminal work exists: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
  const items = Array.isArray(workflows)
    ? workflows
    : Array.isArray(workflows?.items)
      ? workflows.items
      : null;
  if (items === null) {
    // Valid JSON that isn't the expected shape (e.g. `null`, a bare object
    // without an `items` array) -- fail closed the same way a parse error
    // does, instead of throwing past this function's own try/catch.
    console.error(`ci-regression-watch: liveQueryHasNonTerminalWork received an invalid response shape for marker "${marker}", assuming non-terminal work exists`);
    return true;
  }
  return items.some(
    (w) => !TERMINAL_WORKFLOW_STATUSES.has(w.status)
      && typeof w.description === 'string'
      && w.description.includes(marker),
  );
}

// ---------------------------------------------------------------------------
// repair_filings ledger gate (replaces liveQueryHasNonTerminalWork as the
// default dedup gate; see scripts/repair-filing-ledger.mjs)
// ---------------------------------------------------------------------------

/**
 * kind is namespaced per CI job and deliberately excludes the sha (that's
 * stateSha) and, for fleet events, excludes the member-job count (that's
 * metadata only) -- see buildFleetJobName.
 */
export function repairFilingKind(failure) {
  const job = failure.markerJobName ?? failure.jobName;
  return `ci-regression:${slugify(job)}`;
}

export function buildRepairFilingMetadata(failure) {
  const metadata = { jobName: failure.jobName };
  if (Array.isArray(failure.memberJobNames)) metadata.memberJobNames = failure.memberJobNames;
  return metadata;
}

/**
 * Atomically claims the (kind, subject='master', stateSha) key for this
 * failure. Returns true when the caller should SKIP filing -- either because
 * another filer already holds this exact claim, or because the ledger call
 * itself failed and we fail closed (same philosophy as the old
 * liveQueryHasNonTerminalWork: a broken dedup check must never risk a
 * duplicate fix PR). Returns false when this call created the claim and the
 * caller should proceed to file -- on failure to actually file, the caller
 * MUST call releaseRepairFilingClaim(failure) to undo the claim, or this key
 * would be permanently blocked from ever being retried.
 */
export function claimRepairFiling(failure, insert = insertRepairFiling) {
  try {
    const result = insert({
      kind: repairFilingKind(failure),
      subject: 'master',
      stateSha: failure.firstBadSha,
      metadata: buildRepairFilingMetadata(failure),
    });
    return !result.inserted;
  } catch (err) {
    console.error(`ci-regression-watch: claimRepairFiling failed for kind="${repairFilingKind(failure)}" sha="${failure.firstBadSha}", assuming already claimed: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

/**
 * Releases a claim made by claimRepairFiling when the subsequent fileFailure
 * call throws, so a later sweep can retry the same (kind, subject, stateSha)
 * instead of being permanently blocked. Never throws -- a failed release
 * must not crash the sweep; it just means this key stays claimed until a
 * human clears it or the sha changes.
 */
export function releaseRepairFilingClaim(failure, release = releaseRepairFiling) {
  try {
    release({ kind: repairFilingKind(failure), subject: 'master', stateSha: failure.firstBadSha });
  } catch (err) {
    console.error(`ci-regression-watch: releaseRepairFilingClaim failed for kind="${repairFilingKind(failure)}" sha="${failure.firstBadSha}"; this key stays claimed until manually cleared: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function isCiRegressionReflectEnabled(env = process.env) {
  return env[CI_REGRESSION_REFLECT_ENV] === '1';
}

export function renderOptionalReflectTaskYaml(vars) {
  const slug = vars.job_slug;
  const jobName = vars.job_name;
  const sha = vars.sha;
  return `
  - id: reflect-ci-${slug}
    executionAgent: claude
    description: |
      Optional personal /reflect pass. Clone ${CATSTACK_REPO_URL} and draft
      skill edits there only — never edit Invoker.
      Review claim: Any skill edit is a catstack PR traceable to a cited
      finding from this repair's own transcript, not a speculative rewrite.
      Review lane: docs
      Safety invariant: This task never edits Invoker files and never merges
      a catstack PR on its own authority. If /reflect finds nothing durable,
      it makes no changes and exits 0.
      Slice rationale: Opt-in personal worker, downstream of verify, so
      default CI repair stays fix+verify only.
      Architectural effect: None to Invoker product code; accepted edits land
      only in catstack.
      Goal: Reduce the odds that the same class of regression escapes again.
      Motivation: CI job \`${jobName}\` first failed at ${sha}.
      Alternative considerations: Shipping /reflect inside Invoker was
      rejected — the skill is personal and lives in catstack.
      Implementation details: Clone ${CATSTACK_REPO_URL}, follow its
      \`skills/reflect/SKILL.md\` against this workflow's fix/verify
      transcripts, and open any Accepted skill PR against catstack.
      Non-goals: No Invoker file edits; no auto-merge.
      Layer: e2e_regression
      Feature state: active
      Files:
      - Unknown at filing time; determined by what /reflect finds Accepted
        in catstack.
      Change types:
      - Unknown at filing time; determined during the reflect pass.
      Acceptance criteria:
      - The task summary states "no durable finding" or records each
        Accepted finding with its catstack PR URL.
      - \`git diff --name-only\` in the Invoker checkout is empty.
    prompt: |
      Goal: Run /reflect from ${CATSTACK_REPO_URL} against the repair for
      CI job \`${jobName}\` (first observed failing at ${sha}).
      Review claim: Any drafted skill edit is a catstack PR traceable to a
      cited finding from this repair's own transcript.
      Review lane: docs
      Safety invariant: Never edit Invoker files. Never merge a catstack PR
      on this task's own authority. If there is no durable finding, make no
      changes.
      Slice rationale: Keep reflection opt-in and out of Invoker.
      Architectural effect: Invoker product architecture is unchanged.
      Motivation: Durable lessons belong in catstack, not this repo.
      Alternative considerations: Vendoring /reflect into Invoker was
      rejected.
      Implementation details:
      Assume no prior context beyond this workflow and its task transcripts.
      1. Clone ${CATSTACK_REPO_URL} to a scratch directory.
      2. Read that clone's \`skills/reflect/SKILL.md\` and follow it against
         this workflow's fix/verify transcripts (or git artifacts if the
         transcripts are gone).
      3. For each Accepted finding, open a PR against catstack with
         \`gh pr create\`. Record the URL in the task summary.
      4. Do not apply Backlog/Rejected findings; summarize them as prose.
      5. If nothing durable was found, make no file changes and say so.
      Acceptance criteria: Summary says "no durable finding" or lists each
      Accepted finding and its catstack PR. Invoker \`git diff --name-only\`
      is empty.
      Pass condition: Exit 0 only when those acceptance criteria hold.
      Non-goals: Do not edit Invoker. Do not retry the fix/verify tasks.
    dependencies:
      - verify-ci-${slug}
`;
}

export function appendOptionalReflectTask(planPath, vars) {
  const planText = readFileSync(planPath, 'utf8');
  if (planText.includes(`id: reflect-ci-${vars.job_slug}`)) return;
  const waiver = `
  Standalone workflow waiver: Optional personal reflect stays in this
  workflow so it can read the repair transcripts; accepted edits go only
  to catstack.
`;
  let next = planText;
  if (!next.includes('Standalone workflow waiver:')) {
    next = next.replace(
      /^description: \|(\n(?:  .*\n)*)/m,
      (match) => `${match.replace(/\n$/, '')}${waiver}`,
    );
  }
  writeFileSync(planPath, `${next.trimEnd()}\n${renderOptionalReflectTaskYaml(vars)}`);
}

export function fileBugfixPlan(failure, opts = {}) {
  const repoUrl = opts.repoUrl ?? getRepoUrl();
  const jobDefinitions = opts.jobDefinitions ?? buildCiJobDefinitions();
  if (!failureIsMapped(failure, jobDefinitions)) {
    throw new Error(`Cannot file CI regression repair plan for unmapped CI job: ${failure.jobName}`);
  }
  const vars = buildPlanVars(failure, repoUrl, jobDefinitions);
  const outDir = join(opts.outRoot ?? join(REPO_ROOT, 'plans', 'rendered'), vars.job_slug);
  const varArgs = Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}=${v}`]);
  const run = opts.runCommand ?? runCommand;
  run('bash', [join(REPO_ROOT, 'skills/plan-to-invoker/scripts/render-formula.sh'), 'ci-regression-watch', ...varArgs, '--out', outDir]);
  const planPath = join(outDir, 'ci-regression-watch.yaml');
  const enableReflect = opts.enableReflect ?? isCiRegressionReflectEnabled(opts.env);
  if (enableReflect && existsSync(planPath)) appendOptionalReflectTask(planPath, vars);
  run('bash', [join(REPO_ROOT, 'skills/plan-to-invoker/scripts/skill-doctor.sh'), planPath]);
  if (!opts.dryRun) run('bash', [join(REPO_ROOT, 'submit-plan.sh'), planPath, '--no-track']);
  return { planPath, vars, submitted: !opts.dryRun, reflectEnabled: Boolean(enableReflect) };
}

export function processFailureFilingSweep(state, {
  failures = getActionableFailures(state),
  now = new Date(),
  maxAttempts = MAX_ATTEMPTS,
  capPerSweep = CAP_PER_SWEEP,
  jobDefinitions = null,
  liveQuery = claimRepairFiling,
  releaseFiling = releaseRepairFilingClaim,
  fileFailure = () => {},
  save = () => {},
  onNeedsHuman = () => {},
  onRetired = () => {},
  onFileError = () => {},
  fleetEventThreshold = FLEET_EVENT_THRESHOLD,
  isPaused = isAutoFixCircuitBreakerPaused,
} = {}) {
  const filedAt = now instanceof Date ? now : new Date(now);
  const nowMs = filedAt.getTime();

  if (isPaused(nowMs)) {
    return {
      groupsFound: failures.length,
      groupsFiled: 0,
      groupsSkippedAlreadyAddressed: 0,
      groupsDeferredByCap: 0,
      groupsNeedingHuman: 0,
      groupsInBackoff: 0,
      groupsRetired: 0,
      groupsRetiredStale: 0,
      groupsCorrelated: 0,
      pausedByCircuitBreaker: true,
    };
  }

  const prepared = prepareFleetCorrelatedFailures(state, failures, {
    threshold: fleetEventThreshold,
    jobDefinitions,
    maxAttempts,
    nowMs,
  });
  if (prepared.stateChanged) save(state);
  for (const retired of prepared.retiredFleetMembers) onRetired(retired);
  const counts = {
    groupsFound: failures.length,
    groupsFiled: 0,
    groupsSkippedAlreadyAddressed: 0,
    groupsDeferredByCap: 0,
    groupsNeedingHuman: prepared.groupsNeedingHuman ?? 0,
    groupsInBackoff: 0,
    groupsRetired: prepared.retiredFleetMembers.length,
    groupsRetiredStale: 0,
    groupsCorrelated: prepared.groupsCorrelated,
    groupsFailedToFile: 0,
  };

  for (const failure of prepared.failures) {
    if (jobDefinitions && !failureIsMapped(failure, jobDefinitions)) {
      counts.groupsRetired += 1;
      markFailureRetired(state, failure, true);
      save(state);
      onRetired(failure, 'unmapped');
      continue;
    }
    if (isObservationStale(failure, nowMs)) {
      counts.groupsRetired += 1;
      counts.groupsRetiredStale += 1;
      markFailureRetired(state, failure, true);
      save(state);
      onRetired(failure, 'stale-observation');
      continue;
    }
    const attemptGate = shouldFileFailure(failure, { nowMs, maxAttempts });
    if (attemptGate.action === 'needs-human') {
      counts.groupsNeedingHuman += 1;
      markFailureNeedsHuman(state, failure);
      save(state);
      onNeedsHuman(failure, attemptGate);
      continue;
    }
    if (attemptGate.action === 'backoff') {
      counts.groupsInBackoff += 1;
      continue;
    }
    // Cap check must run BEFORE the ledger claim below: liveQuery (default
    // claimRepairFiling) now has a side effect -- it inserts the dedup row
    // -- so deferring a failure by the per-sweep cap after already claiming
    // it would leak a permanently-unfileable claim (no fileFailure call ever
    // follows to either succeed or release it).
    if (capPerSweep > 0 && counts.groupsFiled >= capPerSweep) {
      counts.groupsDeferredByCap += 1;
      continue;
    }
    if (liveQuery(failure)) {
      counts.groupsSkippedAlreadyAddressed += 1;
      continue;
    }

    // One failure's own render/lint/submit (fileFailure) throwing must never
    // stop the whole sweep -- confirmed live: a CI job whose name happened to
    // contain a review-unit keyword ("optional / Visual Proof Validate")
    // tripped skill-doctor.sh's lint and killed the entire process, so every
    // other actionable failure in this sweep silently got zero filing
    // attempts. recordFailureFiled still runs so this failure's attempt
    // count advances toward the existing needs-human cap instead of
    // retry-crashing forever on the same poison-pill job every sweep.
    try {
      fileFailure(failure);
    } catch (error) {
      counts.groupsFailedToFile += 1;
      onFileError(failure, error);
      // The liveQuery call above already claimed this (kind, subject,
      // stateSha) in the repair_filings ledger; the filing attempt itself
      // never got submitted, so release the claim or this key would be
      // permanently blocked from every future retry.
      releaseFiling(failure);
      recordFailureFiled(state, failure, filedAt);
      save(state);
      continue;
    }
    recordFailureFiled(state, failure, filedAt);
    save(state);
    counts.groupsFiled += 1;
  }

  return counts;
}

export function loadState() {
  if (!existsSync(STATE_FILE)) return loadEmptyState();
  return normalizeState(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
}

export function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(normalizeState(state), null, 2));
}

export function appendSweepLog(entry) {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(SWEEP_LOG_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function main() {
  const state = loadState();
  const repoUrl = getRepoUrl();
  const jobDefinitions = buildCiJobDefinitions();
  const dryRun = process.env.INVOKER_CI_WATCH_DRY_RUN === '1'
    || process.env.INVOKER_E2E_WATCH_DRY_RUN === '1';

  const runs = listUnprocessedDefaultBranchRuns(state.lastProcessedRunId);
  let runsProcessed = 0;
  let jobsProcessed = 0;
  let jobsBroken = 0;
  let jobsOk = 0;
  let jobsIgnored = 0;
  for (const runSummary of runs) {
    const run = getCiRun(runSummary.databaseId);
    const result = reconcileCiRun(state, run);
    runsProcessed += 1;
    jobsProcessed += result.processedJobs;
    jobsBroken += result.brokenJobs;
    jobsOk += result.okJobs;
    jobsIgnored += result.ignoredJobs;
    state.lastProcessedRunId = Math.max(Number(state.lastProcessedRunId), Number(run.databaseId));
    saveState(state);
  }

  const failures = getActionableFailures(state);
  const filingCounts = processFailureFilingSweep(state, {
    failures,
    jobDefinitions,
    fileFailure: (failure) => fileBugfixPlan(failure, { repoUrl, jobDefinitions, dryRun }),
    save: saveState,
    onNeedsHuman: (failure, attemptGate) => {
      console.error(`ci-regression-watch: failure key "${buildMarker(failure.firstBadSha, failure.jobName)}" reached attempt cap (${attemptGate.attempts}); needs human review`);
    },
    onRetired: (failure, reason) => {
      const detail = reason === 'stale-observation'
        ? `CI has not reported this job in either direction for over ${Math.round(STALE_OBSERVATION_MS / 86_400_000)}d (last observed ${failure.lastObservedAt}); presumed renamed or removed`
        : 'has no mapped local verify command';
      console.error(`ci-regression-watch: failure key "${buildMarker(failure.firstBadSha, failure.jobName)}" ${detail}; marking retired and skipping filing`);
    },
    onFileError: (failure, error) => {
      console.error(`ci-regression-watch: failed to render/lint/submit a repair plan for "${buildMarker(failure.firstBadSha, failure.jobName)}": ${error.message}; continuing with the rest of the sweep`);
    },
  });

  if (filingCounts.pausedByCircuitBreaker) {
    console.error('ci-regression-watch: auto-fix circuit breaker is paused; skipped filing this sweep');
  }

  appendSweepLog({
    runsProcessed,
    jobsProcessed,
    jobsBroken,
    jobsOk,
    jobsIgnored,
    ...filingCounts,
    dryRun,
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error('ci-regression-watch: fatal error', err);
    process.exitCode = 1;
  });
}
