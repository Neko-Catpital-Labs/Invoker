#!/usr/bin/env node
/**
 * Mergify queue research watch: for each configured target→sources map, mine
 * Mergify/admin-bypass ledger events (and optional Mergify bot comments) in the
 * per-source lookback window and submit a 3-workflow Invoker chain
 * (discover → research-swarm → file-linear). Does not classify in-process and
 * never labels tickets invoker-ready.
 *
 * Env:
 *   INVOKER_MERGIFY_QUEUE_RESEARCH_CONFIG_JSON   inline MergifyQueueResearchConfig (tests)
 *   INVOKER_MERGIFY_QUEUE_RESEARCH_ACTIVITY_FIXTURE  JSON activity by source repoUrl
 *   INVOKER_MERGIFY_QUEUE_RESEARCH_LEDGER_PATH   JSONL ledger path (default ~/.invoker/mergify-admin-requeue-state.jsonl)
 *   INVOKER_MERGIFY_QUEUE_RESEARCH_DRY_RUN=1     generate chain only; do not submit
 *   INVOKER_MERGIFY_QUEUE_RESEARCH_SUBMIT_CMD    override submit-workflow-chain.sh
 *   INVOKER_MERGIFY_QUEUE_RESEARCH_WORK_DIR      ledger + generated plans (default ~/.invoker/mergify-queue-research)
 *   INVOKER_MERGIFY_QUEUE_RESEARCH_GENERATE_ONLY=1  write chain YAML and exit 0 (tests)
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MAX_CANDIDATES = 5;
const INTERESTING_KINDS = new Set([
  'requeue',
  'repair_check',
  'comment_blocked',
  'queue-only-requeue',
  'refresh_stale_queue',
]);

function env(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[mergify-queue-research ${ts}] ${msg}`);
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'event';
}

function yamlQuote(value) {
  return JSON.stringify(String(value ?? ''));
}

function loadOwnerConfig() {
  const inline = env('INVOKER_MERGIFY_QUEUE_RESEARCH_CONFIG_JSON');
  if (inline) return JSON.parse(inline);
  const configPath = env('INVOKER_REPO_CONFIG_PATH')
    || join(homedir(), '.invoker', 'config.json');
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

function normalizeSource(entry) {
  if (typeof entry === 'string') {
    return { repoUrl: entry.trim(), lookbackDays: DEFAULT_LOOKBACK_DAYS };
  }
  return {
    repoUrl: String(entry.repoUrl).trim(),
    lookbackDays: entry.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
  };
}

function normalizeMaps(mergifyQueueResearch) {
  const maps = mergifyQueueResearch?.maps ?? {};
  return Object.entries(maps).map(([targetRepoUrl, sources]) => ({
    targetRepoUrl,
    sources: (sources ?? []).map(normalizeSource),
  }));
}

function fingerprint(text) {
  return createHash('sha256').update(String(text).trim().toLowerCase()).digest('hex').slice(0, 16);
}

function sourceOwnerRepo(repoUrl) {
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

function readLedger(workDir) {
  const path = join(workDir, 'ledger.json');
  if (!existsSync(path)) return { fingerprints: {}, watermarks: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { fingerprints: {}, watermarks: {} };
  }
}

function writeLedger(workDir, ledger) {
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);
}

function loadActivityFixture() {
  const path = env('INVOKER_MERGIFY_QUEUE_RESEARCH_ACTIVITY_FIXTURE');
  if (!path) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function defaultAdminBypassLedgerPath() {
  return env('INVOKER_MERGIFY_QUEUE_RESEARCH_LEDGER_PATH')
    || join(homedir(), '.invoker', 'mergify-admin-requeue-state.jsonl');
}

function rowToActivity(row) {
  const kind = String(row.kind ?? '').trim();
  if (!kind) return null;
  const baseKind = kind.endsWith('-settled') ? kind.slice(0, -'-settled'.length) : kind;
  if (!INTERESTING_KINDS.has(baseKind) && !kind.includes('infra') && !kind.includes('repair')) {
    return null;
  }
  const pr = row.pr ?? row.pr_number ?? '';
  const key = row.key ?? '';
  const title = `${baseKind} PR #${pr} ${key}`.trim();
  const epoch = Number(row.epoch ?? 0);
  const date = epoch > 0
    ? new Date(epoch * 1000).toISOString().slice(0, 10)
    : (row.date ?? '');
  return {
    date,
    kind: baseKind,
    title,
    url: row.url ?? (pr ? `https://github.com/pull/${pr}` : ''),
    body: JSON.stringify({
      kind,
      pr,
      headSha: row.headSha ?? '',
      key,
      meta: row.meta ?? null,
    }).slice(0, 1200),
  };
}

function readJsonlLedgerActivity(ledgerPath, sinceIso) {
  if (!existsSync(ledgerPath)) return [];
  const sinceEpoch = Math.floor(new Date(sinceIso).getTime() / 1000);
  const out = [];
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const epoch = Number(row.epoch ?? 0);
    if (epoch > 0 && epoch < sinceEpoch) continue;
    const activity = rowToActivity(row);
    if (activity) out.push(activity);
  }
  return out;
}

function fetchMergifyComments(ownerRepo, sinceIso) {
  const result = spawnSync(
    'gh',
    [
      'api',
      `repos/${ownerRepo}/issues/comments?since=${encodeURIComponent(sinceIso)}&per_page=100`,
      '--jq',
      '[.[] | select(.user.login == "mergify[bot]" or .user.login == "mergify")'
      + ' | select(.body | contains("-*- Mergify Payload -*-"))'
      + ' | {date: .created_at[0:10], kind: "mergify_dequeue",'
      + ' title: ("mergify event " + (.html_url // "")),'
      + ' url: (.html_url // ""), body: (.body // "")[0:1200]}]',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    log(`gh mergify comment fetch warning: ${(result.stderr || result.stdout || '').slice(0, 200)}`);
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function fetchSourceActivity(source, sinceIso) {
  const fixture = loadActivityFixture();
  if (fixture) {
    const rows = fixture[source.repoUrl] ?? fixture[sourceOwnerRepo(source.repoUrl) ?? ''] ?? [];
    return rows.filter((row) => !row.date || row.date >= sinceIso.slice(0, 10));
  }

  const ownerRepo = sourceOwnerRepo(source.repoUrl);
  const out = [];
  out.push(...readJsonlLedgerActivity(defaultAdminBypassLedgerPath(), sinceIso));
  if (ownerRepo) {
    out.push(...fetchMergifyComments(ownerRepo, sinceIso));
  } else {
    log(`skip unparseable source url for gh comments: ${source.repoUrl}`);
  }
  return out;
}

function selectCandidates(activity, { maxCandidates, ledger }) {
  const selected = [];
  const seenThisTick = new Set();
  for (const row of activity) {
    const title = String(row.title ?? '').trim();
    if (!title) continue;
    const fp = fingerprint(`${row.kind ?? ''}:${title}`);
    if (ledger.fingerprints[fp] || seenThisTick.has(fp)) continue;
    seenThisTick.add(fp);
    selected.push({
      id: `c${selected.length + 1}`,
      fingerprint: fp,
      kind: row.kind ?? 'event',
      title,
      url: row.url ?? '',
      date: row.date ?? '',
      body: row.body ?? '',
    });
    if (selected.length >= maxCandidates) break;
  }
  return selected;
}

function researchPrompt(slot, targetRepoUrl, sourceRepoUrl, artifactDir) {
  const candidate = slot.candidate;
  const noop = !candidate;
  return [
    'You are researching whether a Mergify/admin-bypass queue event warrants a durable improvement in the target repo.',
    'Do not implement product code. Do not open PRs. Do not mutate the merge queue. Do not label Linear tickets invoker-ready.',
    noop
      ? 'No candidate was assigned to this slot. Write a JSON artifact with verdict skip and title "noop-slot", then exit.'
      : `Candidate: ${candidate.title}`,
    `Source queue/ledger: ${sourceRepoUrl}`,
    `Target checkout: ${targetRepoUrl}`,
    candidate ? `Evidence URL: ${candidate.url}` : '',
    candidate ? `Event snippet: ${String(candidate.body).slice(0, 800)}` : '',
    'Judge steal vs skip:',
    '- steal = durable throughput/correctness/less-thrash improvement (flake quarantine, batch-vs-individual failure, repair looping on the alarm not the gate, missing test coverage of the repair subsystem, etc.).',
    '- skip = noise, already fixed, or already handled correctly by pr-admin-bypass-land.',
    `Write artifact JSON to ${artifactDir}/research-${slot.index}.json with fields:`,
    'title, verdict (steal|skip), repo, goal, motivation, safetyInvariant, verify,',
    'reviewClaim, reviewLane, sliceRationale, architecturalEffect, alternatives,',
    'implementationDetails, nonGoals, files, changeTypes, acceptanceCriteria,',
    'layer, featureState, evidence.',
    'repo must be the target repo URL. verify must be a runnable command.',
    'Justify good vs bad with target greps of scripts/mergify_admin_requeue*.py, .mergify.yml, and related workers.',
  ].filter(Boolean).join('\n');
}

function buildDiscoverWorkflow({ targetRepoUrl, sourceRepoUrl, candidatesPath, lookbackDays }) {
  return `name: "mergify-queue-research discover ${slugify(sourceOwnerRepo(sourceRepoUrl) ?? sourceRepoUrl)}"
onFinish: none
mergeMode: no_op
repoUrl: ${yamlQuote(targetRepoUrl)}

tasks:
  - id: discover-candidates
    description: |
      Persist mined Mergify queue candidates for the research swarm.
      Goal: Write candidates.json for ${sourceRepoUrl} lookback ${lookbackDays}d.
      Motivation: Downstream research tasks need a stable candidate list.
      Safety invariant: This task only writes planning artifacts under ${candidatesPath}; no product code.
    command: "test -f ${candidatesPath} && python3 -c \\"import json; d=json.load(open('${candidatesPath}')); assert isinstance(d.get('candidates'), list)\\""
    dependencies: []
`;
}

function buildResearchWorkflow({
  targetRepoUrl,
  sourceRepoUrl,
  artifactDir,
  slots,
  upstreamToken,
}) {
  const tasks = slots.map((slot) => {
    const deps = [];
    return `  - id: research-${slot.index}
    description: |
      Research Mergify queue candidate slot ${slot.index} for steal vs skip.
      Goal: Produce research-${slot.index}.json with plan-to-invoker fields.
      Motivation: Human triage needs full Goal/Motivation/Safety/Verify before invoker-ready.
      Safety invariant: No product commits; artifact write only under ${artifactDir}; no queue mutation.
      Review claim: The artifact records a justified steal or skip verdict for this queue event.
      Review lane: docs
      Slice rationale: One candidate per parallel research slot.
      Architectural effect: None; research-only.
      Alternative considerations: In-process classification was rejected; swarm research is required.
      Implementation details: Grep mergify scripts and workers; write the artifact JSON.
      Non-goals: No Linear create here; no product implementation; no requeue/merge.
      Files: ${artifactDir}/research-${slot.index}.json
      Change types: docs
      Acceptance criteria:
      - Artifact JSON exists with Goal, Motivation, Safety invariant, Verify, Verdict
      Layer: docs
      Feature state: active
    prompt: |
${researchPrompt(slot, targetRepoUrl, sourceRepoUrl, artifactDir).split('\n').map((l) => `      ${l}`).join('\n')}
    dependencies: ${JSON.stringify(deps)}
`;
  }).join('\n');

  return `name: "mergify-queue-research research ${slugify(sourceOwnerRepo(sourceRepoUrl) ?? sourceRepoUrl)}"
onFinish: none
mergeMode: no_op
repoUrl: ${yamlQuote(targetRepoUrl)}
externalDependencies:
  - workflowId: "${upstreamToken}"
    taskId: "__merge__"
    requiredStatus: completed
    gatePolicy: completed

tasks:
${tasks}
`;
}

function buildFileLinearWorkflow({
  targetRepoUrl,
  artifactDir,
  slotCount,
  upstreamToken,
}) {
  const fileCommands = [];
  for (let i = 1; i <= slotCount; i += 1) {
    fileCommands.push(
      `if [ -f ${artifactDir}/research-${i}.json ]; then `
      + `node scripts/linear-issue-create.mjs --artifact ${artifactDir}/research-${i}.json; `
      + 'fi',
    );
  }
  const command = fileCommands.join(' && ');

  return `name: "mergify-queue-research file-linear ${slugify(artifactDir)}"
onFinish: none
mergeMode: no_op
repoUrl: ${yamlQuote(targetRepoUrl)}
externalDependencies:
  - workflowId: "${upstreamToken}"
    taskId: "__merge__"
    requiredStatus: completed
    gatePolicy: completed

tasks:
  - id: file-linear-tickets
    description: |
      Create Linear tickets from Mergify queue research artifacts.
      Goal: File one Linear issue per research artifact (unlabeled steal, idea-skip for skip).
      Motivation: Tickets must be triage-ready with plan-to-invoker fields.
      Safety invariant: Never adds invoker-ready; Linear key stays in env/secrets only.
    command: ${yamlQuote(command)}
    dependencies: []
`;
}

export function generateChainForPair({
  targetRepoUrl,
  source,
  candidates,
  workDir,
  teamId,
  maxCandidates,
}) {
  const ownerRepo = sourceOwnerRepo(source.repoUrl) ?? slugify(source.repoUrl);
  const watermark = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(workDir, 'runs', slugify(ownerRepo), watermark);
  mkdirSync(runDir, { recursive: true });

  const candidatesPath = join(runDir, 'candidates.json');
  const capped = candidates.slice(0, maxCandidates);
  writeFileSync(candidatesPath, `${JSON.stringify({
    targetRepoUrl,
    sourceRepoUrl: source.repoUrl,
    lookbackDays: source.lookbackDays,
    candidates: capped,
  }, null, 2)}\n`);

  const slots = [];
  for (let i = 1; i <= maxCandidates; i += 1) {
    slots.push({ index: i, candidate: capped[i - 1] ?? null });
  }

  const discoverPath = join(runDir, '01-discover.yaml');
  const researchPath = join(runDir, '02-research.template.yaml');
  const filePath = join(runDir, '03-file-linear.template.yaml');

  writeFileSync(discoverPath, buildDiscoverWorkflow({
    targetRepoUrl,
    sourceRepoUrl: source.repoUrl,
    candidatesPath,
    lookbackDays: source.lookbackDays,
  }));
  writeFileSync(researchPath, buildResearchWorkflow({
    targetRepoUrl,
    sourceRepoUrl: source.repoUrl,
    artifactDir: runDir,
    slots,
    upstreamToken: '__UPSTREAM_WORKFLOW_ID__',
  }));
  writeFileSync(filePath, buildFileLinearWorkflow({
    targetRepoUrl,
    artifactDir: runDir,
    slotCount: maxCandidates,
    upstreamToken: '__UPSTREAM_WORKFLOW_ID__',
  }));

  return {
    runDir,
    candidatesPath,
    plans: [discoverPath, researchPath, filePath],
    fingerprints: capped.map((c) => c.fingerprint),
  };
}

function submitChain(plans, { dryRun, submitCmd }) {
  if (dryRun || env('INVOKER_MERGIFY_QUEUE_RESEARCH_GENERATE_ONLY') === '1') {
    log(`dry-run/generate-only chain: ${plans.join(' ')}`);
    return { status: 0, stdout: plans.join('\n') };
  }
  const cmd = submitCmd || join(REPO_ROOT, 'scripts/submit-workflow-chain.sh');
  const result = spawnSync('bash', [cmd, '--gate-policy', 'completed', ...plans], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  if (result.status !== 0) {
    throw new Error(`submit chain failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

export function runMergifyQueueResearchWatch(options = {}) {
  const config = options.config ?? loadOwnerConfig();
  const mergifyQueueResearch = config.mergifyQueueResearch ?? {};
  const pairs = normalizeMaps(mergifyQueueResearch);
  const workDir = options.workDir
    ?? env('INVOKER_MERGIFY_QUEUE_RESEARCH_WORK_DIR')
    ?? join(homedir(), '.invoker', 'mergify-queue-research');
  const dryRun = options.dryRun ?? env('INVOKER_MERGIFY_QUEUE_RESEARCH_DRY_RUN', '0') === '1';
  const maxCandidates = mergifyQueueResearch.maxCandidatesPerSource ?? DEFAULT_MAX_CANDIDATES;
  const teamId = mergifyQueueResearch.linearTeamId ?? env('INVOKER_LINEAR_TEAM_ID');
  const ledger = readLedger(workDir);

  if (pairs.length === 0) {
    log('no mergifyQueueResearch.maps configured; no-op');
    return { submitted: 0, pairs: 0 };
  }
  if (!teamId) {
    throw new Error('mergifyQueueResearch.linearTeamId (or INVOKER_LINEAR_TEAM_ID) is required');
  }

  let submitted = 0;
  for (const pair of pairs) {
    for (const source of pair.sources) {
      const since = new Date(Date.now() - source.lookbackDays * 86400000).toISOString();
      const activity = fetchSourceActivity(source, since);
      const candidates = selectCandidates(activity, { maxCandidates, ledger });
      if (candidates.length === 0) {
        log(`no new candidates for ${source.repoUrl} (lookback ${source.lookbackDays}d)`);
        ledger.watermarks[source.repoUrl] = since;
        continue;
      }
      log(`mining ${candidates.length} candidate(s) from ${source.repoUrl} → ${pair.targetRepoUrl}`);
      const chain = generateChainForPair({
        targetRepoUrl: pair.targetRepoUrl,
        source,
        candidates,
        workDir,
        teamId,
        maxCandidates,
      });
      submitChain(chain.plans, {
        dryRun,
        submitCmd: options.submitCmd ?? env('INVOKER_MERGIFY_QUEUE_RESEARCH_SUBMIT_CMD'),
      });
      for (const fp of chain.fingerprints) {
        ledger.fingerprints[fp] = {
          at: new Date().toISOString(),
          source: source.repoUrl,
          target: pair.targetRepoUrl,
        };
      }
      ledger.watermarks[source.repoUrl] = since;
      submitted += 1;
    }
  }

  writeLedger(workDir, ledger);
  return { submitted, pairs: pairs.length };
}

function main() {
  const result = runMergifyQueueResearchWatch();
  log(`done submitted=${result.submitted} pairs=${result.pairs}`);
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

const isDirect = Boolean(process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url)));
if (isDirect) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
