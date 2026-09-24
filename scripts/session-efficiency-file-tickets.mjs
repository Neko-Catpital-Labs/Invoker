#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CREATE_SCRIPT = join(REPO_ROOT, 'scripts', 'linear-issue-create.mjs');
const LABEL_READY = 'invoker-ready';
const MARKER_PREFIX = 'token-pattern:';
const MARKER_CHAR = /[a-z0-9-]/;
const CLOSED_STATE_TYPES = new Set(['completed', 'canceled', 'cancelled']);
const DEFAULT_REPO = 'https://github.com/Neko-Catpital-Labs/Invoker.git';
const LINEAR_API_URL = process.env.INVOKER_LINEAR_API_URL || 'https://api.linear.app/graphql';
const ISSUE_PAGE_SIZE = 250;
const SEARCH_TIMEOUT_MS = Number(process.env.INVOKER_LINEAR_SEARCH_TIMEOUT_MS ?? '120000');
const CREATE_TIMEOUT_MS = Number(process.env.INVOKER_LINEAR_CREATE_TIMEOUT_MS ?? '120000');

function env(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function log(message) {
  console.log(`[session-efficiency-tickets] ${message}`);
}

function parseArgs(argv) {
  const out = { findings: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--findings') out.findings = argv[index + 1] ?? '';
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function linearGraphql(apiKey, query, variables = {}) {
  const res = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors?.length) {
    throw new Error(`Linear GraphQL failed: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

async function fetchOpenIssues() {
  const searchCmd = env('INVOKER_LINEAR_SEARCH_CMD');
  if (searchCmd) {
    const result = spawnSync('bash', ['-lc', searchCmd], { encoding: 'utf8', cwd: REPO_ROOT, timeout: SEARCH_TIMEOUT_MS });
    if (result.status !== 0) {
      throw new Error(`search cmd failed: ${result.stderr || result.stdout}`);
    }
    const raw = JSON.parse((result.stdout || '{}').trim() || '{}');
    return Array.isArray(raw) ? raw : raw.issues ?? [];
  }
  const apiKey = env('INVOKER_LINEAR_API_KEY') || env('LINEAR_API_KEY');
  if (!apiKey) {
    throw new Error('LINEAR_API_KEY / INVOKER_LINEAR_API_KEY required (or set INVOKER_LINEAR_SEARCH_CMD)');
  }
  const issues = [];
  let after = null;
  for (;;) {
    const data = await linearGraphql(
      apiKey,
      `query($filter: IssueFilter, $first: Int!, $after: String) {
        issues(filter: $filter, first: $first, after: $after) {
          nodes { id identifier title description state { type } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter: { state: { type: { nin: ['completed', 'canceled'] } } }, first: ISSUE_PAGE_SIZE, after },
    );
    issues.push(...(data?.issues?.nodes ?? []));
    const pageInfo = data?.issues?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return issues;
    after = pageInfo.endCursor;
  }
}

function containsMarker(text, marker) {
  const haystack = String(text ?? '');
  for (let from = 0; from <= haystack.length; ) {
    const at = haystack.indexOf(marker, from);
    if (at < 0) return false;
    const before = haystack[at - 1] ?? '';
    const after = haystack[at + marker.length] ?? '';
    if (!MARKER_CHAR.test(before) && !MARKER_CHAR.test(after)) return true;
    from = at + 1;
  }
  return false;
}

function findOpenIssueWithMarker(issues, marker) {
  return issues.find((issue) => {
    const stateType = String(issue?.state?.type ?? '').toLowerCase();
    if (CLOSED_STATE_TYPES.has(stateType)) return false;
    return containsMarker(`${issue?.title ?? ''}\n${issue?.description ?? ''}`, marker);
  }) ?? null;
}

function measurementFor(finding, marker) {
  const raw = finding.effectivenessMeasurement;
  const leading = Array.isArray(raw?.leadingSignals) && raw.leadingSignals.length > 0
    ? raw.leadingSignals
    : [`The weekly cross-machine token rollup reports fewer sessions matching ${marker}.`];
  const lagging = Array.isArray(raw?.laggingSignals) && raw.laggingSignals.length > 0
    ? raw.laggingSignals
    : ['Total 30-day tokens across all machines fall relative to the week this ticket was filed.'];
  return { leadingSignals: leading, laggingSignals: lagging };
}

function buildArtifact(finding, marker) {
  const motivation = [String(finding.motivation ?? '').trim(), marker].filter(Boolean).join('\n\n');
  return {
    title: String(finding.title ?? '').trim(),
    repo: finding.repo || DEFAULT_REPO,
    goal: finding.goal,
    motivation,
    safetyInvariant: finding.safetyInvariant || 'Analysis-only ticket; no code lands until a human plans it.',
    verify: finding.verify || 'node scripts/test-worker-session-mine-efficiency.mjs',
    reviewClaim: finding.reviewClaim,
    reviewLane: finding.reviewLane,
    sliceRationale: finding.sliceRationale,
    architecturalEffect: finding.architecturalEffect,
    alternatives: finding.alternatives,
    implementationDetails: finding.implementationDetails ?? finding.suggestedFix,
    nonGoals: finding.nonGoals,
    acceptanceCriteria: finding.acceptanceCriteria,
    evidence: finding.evidence,
    effectivenessMeasurement: measurementFor(finding, marker),
  };
}

function createIssue(artifact) {
  const dir = mkdtempSync(join(tmpdir(), 'session-efficiency-ticket-'));
  const artifactPath = join(dir, 'ticket.json');
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const result = spawnSync('node', [CREATE_SCRIPT, '--artifact', artifactPath], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, INVOKER_LINEAR_LABEL_NAMES: '' },
    timeout: CREATE_TIMEOUT_MS,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status === 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/session-efficiency-file-tickets.mjs --findings path/to/findings.json');
    return 0;
  }
  if (!args.findings) throw new Error('--findings <path> is required');
  if (!existsSync(args.findings)) throw new Error(`findings file not found: ${args.findings}`);

  const raw = JSON.parse(readFileSync(args.findings, 'utf8'));
  const findings = Array.isArray(raw) ? raw : raw.findings ?? [];
  if (findings.length === 0) {
    log('no findings to file');
    return 0;
  }

  const issues = await fetchOpenIssues();
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const finding of findings) {
    const slug = slugify(finding.slug || finding.title);
    if (!slug) {
      failed += 1;
      console.error('[session-efficiency-tickets] finding has no slug or title; skipping');
      continue;
    }
    const marker = `${MARKER_PREFIX}${slug}`;
    const existing = findOpenIssueWithMarker(issues, marker);
    if (existing) {
      skipped += 1;
      log(`${marker} already open as ${existing.identifier ?? existing.id}`);
      continue;
    }
    const artifact = buildArtifact(finding, marker);
    if (!artifact.title) {
      failed += 1;
      console.error(`[session-efficiency-tickets] ${marker} has no title; skipping`);
      continue;
    }
    if (JSON.stringify(artifact).includes(LABEL_READY)) {
      failed += 1;
      console.error(`[session-efficiency-tickets] ${marker} names the ready label; refusing to file it`);
      continue;
    }
    if (createIssue(artifact)) created += 1;
    else {
      failed += 1;
      console.error(`[session-efficiency-tickets] create failed for ${marker}`);
    }
  }

  log(`created=${created} skipped=${skipped} failed=${failed}`);
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
