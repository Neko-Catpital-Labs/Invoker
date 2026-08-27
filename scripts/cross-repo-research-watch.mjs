#!/usr/bin/env node
/**
 * Cross-repo research watch: for each configured target→sources map, mine source
 * activity in the per-source lookback window and submit a 3-workflow Invoker
 * chain (discover → research-swarm → file-linear). Does not classify in-process
 * and never labels tickets invoker-ready.
 *
 * Env:
 *   INVOKER_CROSS_REPO_RESEARCH_CONFIG_JSON   inline CrossRepoResearchConfig (tests)
 *   INVOKER_CROSS_REPO_RESEARCH_ACTIVITY_FIXTURE  JSON activity by source repoUrl
 *   INVOKER_CROSS_REPO_RESEARCH_DRY_RUN=1     generate chain only; do not submit
 *   INVOKER_CROSS_REPO_RESEARCH_SUBMIT_CMD    override submit-workflow-chain.sh
 *   INVOKER_CROSS_REPO_RESEARCH_WORK_DIR      ledger + generated plans (default ~/.invoker/cross-repo-research)
 *   INVOKER_CROSS_REPO_RESEARCH_GENERATE_ONLY=1  write chain YAML and exit 0 (tests)
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_INTERVAL_DAYS = 14;
const DEFAULT_MAX_CANDIDATES = 5;

function env(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[cross-repo-research ${ts}] ${msg}`);
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'idea';
}

function yamlQuote(value) {
  return JSON.stringify(String(value ?? ''));
}

function loadOwnerConfig() {
  const inline = env('INVOKER_CROSS_REPO_RESEARCH_CONFIG_JSON');
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

function normalizeMaps(crossRepoResearch) {
  const maps = crossRepoResearch?.maps ?? {};
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
  const path = env('INVOKER_CROSS_REPO_RESEARCH_ACTIVITY_FIXTURE');
  if (!path) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fetchSourceActivity(source, sinceIso) {
  const fixture = loadActivityFixture();
  if (fixture) {
    const rows = fixture[source.repoUrl] ?? fixture[sourceOwnerRepo(source.repoUrl) ?? ''] ?? [];
    return rows.filter((row) => !row.date || row.date >= sinceIso.slice(0, 10));
  }

  const ownerRepo = sourceOwnerRepo(source.repoUrl);
  if (!ownerRepo) {
    log(`skip unparseable source url: ${source.repoUrl}`);
    return [];
  }

  const since = sinceIso;
  const releases = spawnSync(
    'gh',
    ['api', `repos/${ownerRepo}/releases?per_page=30`, '--jq',
      `[.[] | select(.published_at >= ${JSON.stringify(since)}) | {date: .published_at[0:10], kind: "release", title: (.name // .tag_name), url: .html_url, body: (.body // "")[0:1200]}]`],
    { encoding: 'utf8' },
  );
  const commits = spawnSync(
    'gh',
    ['api', `repos/${ownerRepo}/commits?since=${encodeURIComponent(since)}&per_page=100`, '--jq',
      `[.[] | select((.commit.message | split("\\n")[0] | test("^feat"; "i"))) | {date: .commit.author.date[0:10], kind: "feat", title: (.commit.message | split("\\n")[0]), url: .html_url, body: ""}]`],
    { encoding: 'utf8' },
  );

  const out = [];
  for (const result of [releases, commits]) {
    if (result.status !== 0) {
      log(`gh activity fetch warning: ${(result.stderr || result.stdout || '').slice(0, 200)}`);
      continue;
    }
    try {
      const parsed = JSON.parse(result.stdout || '[]');
      if (Array.isArray(parsed)) out.push(...parsed);
    } catch {
      // ignore parse errors; treat as empty
    }
  }
  return out;
}

function selectCandidates(activity, { maxCandidates, ledger }) {
  const selected = [];
  for (const row of activity) {
    const title = String(row.title ?? '').trim();
    if (!title) continue;
    const fp = fingerprint(`${row.kind ?? ''}:${title}`);
    if (ledger.fingerprints[fp]) continue;
    selected.push({
      id: `c${selected.length + 1}`,
      fingerprint: fp,
      kind: row.kind ?? 'feat',
      title,
      url: row.url ?? '',
      date: row.date ?? '',
      body: row.body ?? '',
    });
    if (selected.length >= maxCandidates) break;
  }
  return selected;
}

const RESEARCH_LENSES = [
  {
    id: 'fit',
    label: 'Fit',
    focus: 'Judge whether the candidate fits the target repo\'s architecture, conventions, and roadmap. Grep the target checkout for prior art or conflicting patterns.',
  },
  {
    id: 'peers',
    label: 'Peers',
    focus: 'Survey how peer/competitor tools solve the same problem. Produce a peerLandscape: which peers have it, which don\'t, and how their approach differs.',
  },
  {
    id: 'implementations',
    label: 'Implementations',
    focus: 'Enumerate alternateImplementations: at least two distinct ways the target repo could implement this steal, with tradeoffs for each.',
  },
  {
    id: 'adversarial',
    label: 'Adversarial',
    focus: 'Red-team the candidate. Produce an adversarialAnalysis: the strongest reasons this steal is a bad idea, what could break, and what a naive "fit" reading would miss.',
  },
  {
    id: 'effectiveness',
    label: 'Effectiveness',
    focus: 'Define an effectivenessMeasurement: leadingSignals and laggingSignals that would show this steal is working after it lands, beyond the fixture e2e check the plan will already run.',
  },
];

function lensTaskId(slotIndex, lensId) {
  return `research-${slotIndex}-lens-${lensId}`;
}

function lensArtifactPath(artifactDir, slotIndex, lensId) {
  return `${artifactDir}/lens-${slotIndex}-${lensId}.json`;
}

function lensPrompt(lens, slot, targetRepoUrl, sourceRepoUrl, artifactDir) {
  const candidate = slot.candidate;
  return [
    `You are the ${lens.label} lens researching whether a source-repo idea should be stolen into the target repo.`,
    'Do not implement product code. Do not open PRs. Do not label Linear tickets invoker-ready.',
    `Candidate: ${candidate.title}`,
    `Source: ${sourceRepoUrl}`,
    `Target checkout: ${targetRepoUrl}`,
    `Evidence URL: ${candidate.url}`,
    `Source snippet: ${String(candidate.body).slice(0, 800)}`,
    `Lens focus: ${lens.focus}`,
    `Write artifact JSON to ${lensArtifactPath(artifactDir, slot.index, lens.id)} with fields:`,
    'lensId, candidateTitle, findings, evidence.',
    'This is one of five independent lenses run in parallel; do not read the other lens artifacts.',
  ].filter(Boolean).join('\n');
}

function synthesisPrompt(slot, targetRepoUrl, sourceRepoUrl, artifactDir) {
  const candidate = slot.candidate;
  const noop = !candidate;
  if (noop) {
    return [
      'You are synthesizing research for a candidate slot.',
      'No candidate was assigned to this slot. Write a JSON artifact with verdict skip and title "noop-slot", then exit.',
      `Write artifact JSON to ${artifactDir}/research-${slot.index}.json with fields:`,
      'title, verdict (steal|skip), repo, goal, motivation, safetyInvariant, verify,',
      'reviewClaim, reviewLane, sliceRationale, architecturalEffect, alternatives,',
      'implementationDetails, nonGoals, files, changeTypes, acceptanceCriteria,',
      'layer, featureState, evidence, peerLandscape, adversarialAnalysis,',
      'alternateImplementations, effectivenessMeasurement.',
    ].join('\n');
  }
  const lensArtifacts = RESEARCH_LENSES
    .map((lens) => `${lens.id}: ${lensArtifactPath(artifactDir, slot.index, lens.id)}`)
    .join('\n');
  return [
    'You are synthesizing five parallel research lenses into a single steal/skip verdict.',
    'Do not implement product code. Do not open PRs. Do not label Linear tickets invoker-ready.',
    `Candidate: ${candidate.title}`,
    `Source: ${sourceRepoUrl}`,
    `Target checkout: ${targetRepoUrl}`,
    `Evidence URL: ${candidate.url}`,
    'Read each lens artifact before writing the synthesis:',
    lensArtifacts,
    `Write artifact JSON to ${artifactDir}/research-${slot.index}.json with fields:`,
    'title, verdict (steal|skip), repo, goal, motivation, safetyInvariant, verify,',
    'reviewClaim, reviewLane, sliceRationale, architecturalEffect, alternatives,',
    'implementationDetails, nonGoals, files, changeTypes, acceptanceCriteria,',
    'layer, featureState, evidence,',
    'peerLandscape (from the peers lens), adversarialAnalysis (from the adversarial lens),',
    'alternateImplementations (from the implementations lens),',
    'effectivenessMeasurement (from the effectiveness lens; must include leadingSignals and',
    'laggingSignals arrays, going beyond the fixture e2e check named in verify).',
    'repo must be the target repo URL. verify must be a runnable command.',
    'Weigh the adversarial lens seriously: a strong adversarialAnalysis can flip verdict to skip',
    'even when the fit lens was positive. Skip ideas the target already owns.',
  ].filter(Boolean).join('\n');
}

function buildDiscoverWorkflow({ targetRepoUrl, sourceRepoUrl, candidatesPath, lookbackDays }) {
  return `name: "cross-repo-research discover ${slugify(sourceOwnerRepo(sourceRepoUrl) ?? sourceRepoUrl)}"
onFinish: none
mergeMode: no_op
repoUrl: ${yamlQuote(targetRepoUrl)}

tasks:
  - id: discover-candidates
    description: |
      Persist mined source candidates for the research swarm.
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
    if (!slot.candidate) {
      return `  - id: research-${slot.index}
    description: |
      Research candidate slot ${slot.index} for steal vs skip.
      Goal: Produce research-${slot.index}.json with plan-to-invoker fields.
      Motivation: Human triage needs full Goal/Motivation/Safety/Verify before invoker-ready.
      Safety invariant: No product commits; artifact write only under ${artifactDir}.
      Review claim: The artifact records a justified steal or skip verdict for this candidate.
      Review lane: docs
      Slice rationale: One candidate per parallel research slot.
      Architectural effect: None; research-only.
      Alternative considerations: In-process classification was rejected; swarm research is required.
      Implementation details: Grep the target checkout; write the artifact JSON.
      Non-goals: No Linear create here; no product implementation.
      Files: ${artifactDir}/research-${slot.index}.json
      Change types: docs
      Acceptance criteria:
      - Artifact JSON exists with Goal, Motivation, Safety invariant, Verify, Verdict
      Layer: docs
      Feature state: active
    prompt: |
${synthesisPrompt(slot, targetRepoUrl, sourceRepoUrl, artifactDir).split('\n').map((l) => `      ${l}`).join('\n')}
    dependencies: []
`;
    }

    const lensTasks = RESEARCH_LENSES.map((lens) => `  - id: ${lensTaskId(slot.index, lens.id)}
    description: |
      ${lens.label} lens for candidate slot ${slot.index}.
      Goal: Produce ${lensArtifactPath(artifactDir, slot.index, lens.id)}.
      Motivation: Steal candidates need peer, adversarial, and effectiveness analysis before Linear filing.
      Safety invariant: No product commits; artifact write only under ${artifactDir}.
      Review claim: The lens artifact records ${lens.id}-specific findings for this candidate.
      Review lane: docs
      Slice rationale: One lens per parallel prompt task; five lenses fan out independently.
      Architectural effect: None; research-only.
      Alternative considerations: One combined prompt was rejected in favor of parallel lenses.
      Implementation details: ${lens.focus}
      Non-goals: No Linear create here; no product implementation; no reading sibling lens artifacts.
      Files: ${lensArtifactPath(artifactDir, slot.index, lens.id)}
      Change types: docs
      Acceptance criteria:
      - Artifact JSON exists with lensId "${lens.id}", candidateTitle, findings, evidence
      Layer: docs
      Feature state: active
    prompt: |
${lensPrompt(lens, slot, targetRepoUrl, sourceRepoUrl, artifactDir).split('\n').map((l) => `      ${l}`).join('\n')}
    dependencies: []
`).join('\n');

    const lensDeps = RESEARCH_LENSES.map((lens) => lensTaskId(slot.index, lens.id));
    const synthesisTask = `  - id: research-${slot.index}
    description: |
      Synthesize five research lenses for candidate slot ${slot.index} into a steal/skip verdict.
      Goal: Produce research-${slot.index}.json with plan-to-invoker fields plus lens findings.
      Motivation: Human triage needs full Goal/Motivation/Safety/Verify before invoker-ready.
      Safety invariant: No product commits; artifact write only under ${artifactDir}.
      Review claim: The synthesis artifact records a justified steal or skip verdict backed by all five lenses.
      Review lane: docs
      Slice rationale: One synthesis task per candidate, gated on that candidate's five lens tasks.
      Architectural effect: None; research-only.
      Alternative considerations: One combined prompt was rejected in favor of parallel lenses.
      Implementation details: Read each lens artifact; write the synthesis JSON.
      Non-goals: No Linear create here; no product implementation.
      Files: ${artifactDir}/research-${slot.index}.json
      Change types: docs
      Acceptance criteria:
      - Artifact JSON exists with Goal, Motivation, Safety invariant, Verify, Verdict
      - Artifact JSON includes peerLandscape, adversarialAnalysis, alternateImplementations, effectivenessMeasurement
      Layer: docs
      Feature state: active
    prompt: |
${synthesisPrompt(slot, targetRepoUrl, sourceRepoUrl, artifactDir).split('\n').map((l) => `      ${l}`).join('\n')}
    dependencies: ${JSON.stringify(lensDeps)}
`;

    return `${lensTasks}\n${synthesisTask}`;
  }).join('\n');

  return `name: "cross-repo-research research ${slugify(sourceOwnerRepo(sourceRepoUrl) ?? sourceRepoUrl)}"
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

  return `name: "cross-repo-research file-linear ${slugify(artifactDir)}"
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
      Create Linear tickets from research artifacts.
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
  if (dryRun || env('INVOKER_CROSS_REPO_RESEARCH_GENERATE_ONLY') === '1') {
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

export function runCrossRepoResearchWatch(options = {}) {
  const config = options.config ?? loadOwnerConfig();
  const crossRepoResearch = config.crossRepoResearch ?? {};
  const pairs = normalizeMaps(crossRepoResearch);
  const workDir = options.workDir
    ?? env('INVOKER_CROSS_REPO_RESEARCH_WORK_DIR')
    ?? join(homedir(), '.invoker', 'cross-repo-research');
  const dryRun = options.dryRun ?? env('INVOKER_CROSS_REPO_RESEARCH_DRY_RUN', '0') === '1';
  const maxCandidates = crossRepoResearch.maxCandidatesPerSource ?? DEFAULT_MAX_CANDIDATES;
  const teamId = crossRepoResearch.linearTeamId ?? env('INVOKER_LINEAR_TEAM_ID');
  const ledger = readLedger(workDir);

  if (pairs.length === 0) {
    log('no crossRepoResearch.maps configured; no-op');
    return { submitted: 0, pairs: 0 };
  }
  if (!teamId) {
    throw new Error('crossRepoResearch.linearTeamId (or INVOKER_LINEAR_TEAM_ID) is required');
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
        submitCmd: options.submitCmd ?? env('INVOKER_CROSS_REPO_RESEARCH_SUBMIT_CMD'),
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
  const result = runCrossRepoResearchWatch();
  log(`done submitted=${result.submitted} pairs=${result.pairs}`);
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
