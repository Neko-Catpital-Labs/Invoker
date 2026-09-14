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
    ask: 'Assess product/architectural fit: does the target repo already solve this, partially solve it, or genuinely need it? Grep the target checkout for existing coverage.',
    field: 'fitAnalysis',
  },
  {
    id: 'peers',
    label: 'Peers',
    ask: 'Survey peer/competitor repos and prior art for this idea beyond the source repo. Record entries as peerLandscape: [{ repo, approach, outcome }].',
    field: 'peerLandscape',
  },
  {
    id: 'implementations',
    label: 'Implementations',
    ask: 'Enumerate at least two alternate implementation approaches for this idea inside the target repo, with tradeoffs. Record entries as alternateImplementations: [{ approach, tradeoffs }].',
    field: 'alternateImplementations',
  },
  {
    id: 'adversarial',
    label: 'Adversarial',
    ask: 'Argue against stealing this idea: redundancy, maintenance cost, safety risk, scope creep. Record entries as adversarialAnalysis: [{ objection, strength }].',
    field: 'adversarialAnalysis',
  },
  {
    id: 'effectiveness',
    label: 'Effectiveness',
    ask: 'Define effectivenessMeasurement: { leadingSignals: [...], laggingSignals: [...] } — concrete, observable signals beyond the fixture e2e test that show the idea worked once implemented. Leading signals are fast proxies; lagging signals are slower outcome measures.',
    field: 'effectivenessMeasurement',
  },
];

function lensArtifactPath(artifactDir, slotIndex, lensId) {
  return `${artifactDir}/lens-${slotIndex}-${lensId}.json`;
}

function lensTaskId(slotIndex, lensId) {
  return `research-${slotIndex}-${lensId}`;
}

function synthesisTaskId(slotIndex) {
  return `research-${slotIndex}-synthesis`;
}

function lensPrompt(lens, slot, targetRepoUrl, sourceRepoUrl, artifactDir) {
  const candidate = slot.candidate;
  const noop = !candidate;
  return [
    `You are the ${lens.label} lens in a parallel research swarm evaluating whether a source-repo idea should be stolen into the target repo.`,
    'Do not implement product code. Do not open PRs. Do not label Linear tickets invoker-ready.',
    noop
      ? 'No candidate was assigned to this slot. Write a JSON artifact with lensId, verdict "skip", and an empty findings field, then exit.'
      : `Candidate: ${candidate.title}`,
    `Source: ${sourceRepoUrl}`,
    `Target checkout: ${targetRepoUrl}`,
    candidate ? `Evidence URL: ${candidate.url}` : '',
    candidate ? `Source snippet: ${String(candidate.body).slice(0, 800)}` : '',
    `Lens task: ${lens.ask}`,
    `Write artifact JSON to ${lensArtifactPath(artifactDir, slot.index, lens.id)} with fields: lensId ("${lens.id}"), ${lens.field}.`,
    'This lens only writes its own artifact file; do not write research-N.json.',
  ].filter(Boolean).join('\n');
}

function synthesisPrompt(slot, targetRepoUrl, sourceRepoUrl, artifactDir) {
  const candidate = slot.candidate;
  const noop = !candidate;
  const lensPaths = RESEARCH_LENSES
    .map((lens) => `${lens.field} from ${lensArtifactPath(artifactDir, slot.index, lens.id)}`)
    .join(', ');
  return [
    'You are synthesizing five parallel research lenses (Fit, Peers, Implementations, Adversarial, Effectiveness) into one verdict.',
    'Do not implement product code. Do not open PRs. Do not label Linear tickets invoker-ready.',
    noop
      ? 'No candidate was assigned to this slot. Write a JSON artifact with verdict skip and title "noop-slot", then exit.'
      : `Candidate: ${candidate.title}`,
    `Source: ${sourceRepoUrl}`,
    `Target checkout: ${targetRepoUrl}`,
    `Read each lens artifact and fold in its field: ${lensPaths}.`,
    `Write artifact JSON to ${artifactDir}/research-${slot.index}.json with fields:`,
    'title, verdict (steal|skip), repo, goal, motivation, safetyInvariant, verify,',
    'reviewClaim, reviewLane, sliceRationale, architecturalEffect, alternatives,',
    'implementationDetails, nonGoals, files, changeTypes, acceptanceCriteria,',
    'layer, featureState, evidence,',
    'peerLandscape, adversarialAnalysis, alternateImplementations, effectivenessMeasurement.',
    'effectivenessMeasurement is required and must include leadingSignals and laggingSignals',
    'beyond the fixture e2e test alone.',
    'repo must be the target repo URL. verify must be a runnable command.',
    'Justify good vs bad with target greps and the adversarial lens objections. Skip ideas the target already owns.',
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

function buildLensTask(lens, slot, targetRepoUrl, sourceRepoUrl, artifactDir) {
  const id = lensTaskId(slot.index, lens.id);
  const artifactPath = lensArtifactPath(artifactDir, slot.index, lens.id);
  return `  - id: ${id}
    description: |
      ${lens.label} lens for research candidate slot ${slot.index}.
      Goal: Produce ${lens.field} for candidate slot ${slot.index} via the ${lens.label} lens.
      Motivation: Peer, adversarial, and effectiveness analysis must run in parallel before synthesis.
      Safety invariant: No product commits; artifact write only under ${artifactDir}.
      Review claim: The lens artifact records ${lens.field} for this candidate.
      Review lane: docs
      Slice rationale: One lens per parallel research task; five lenses per candidate.
      Architectural effect: None; research-only.
      Alternative considerations: A single combined research prompt was rejected in favor of parallel lenses.
      Implementation details: Grep the target checkout; write the lens artifact JSON.
      Non-goals: No Linear create here; no product implementation; no research-N.json write.
      Files: ${artifactPath}
      Change types: docs
      Acceptance criteria:
      - Artifact JSON exists at ${artifactPath} with lensId and ${lens.field}
      Layer: docs
      Feature state: active
    prompt: |
${lensPrompt(lens, slot, targetRepoUrl, sourceRepoUrl, artifactDir).split('\n').map((l) => `      ${l}`).join('\n')}
    dependencies: []
`;
}

function buildSynthesisTask(slot, targetRepoUrl, sourceRepoUrl, artifactDir) {
  const deps = RESEARCH_LENSES.map((lens) => lensTaskId(slot.index, lens.id));
  return `  - id: ${synthesisTaskId(slot.index)}
    description: |
      Synthesize the five research lenses for candidate slot ${slot.index} into a steal/skip verdict.
      Goal: Produce research-${slot.index}.json with plan-to-invoker fields plus lens findings.
      Motivation: Human triage needs full Goal/Motivation/Safety/Verify before invoker-ready.
      Safety invariant: No product commits; artifact write only under ${artifactDir}.
      Review claim: The artifact records a justified steal or skip verdict backed by all five lenses.
      Review lane: docs
      Slice rationale: One synthesis task per candidate, gated on its five lens tasks.
      Architectural effect: None; research-only.
      Alternative considerations: In-process classification was rejected; swarm research is required.
      Implementation details: Read each lens artifact; write the synthesized research artifact JSON.
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
    dependencies: ${JSON.stringify(deps)}
`;
}

function buildResearchWorkflow({
  targetRepoUrl,
  sourceRepoUrl,
  artifactDir,
  slots,
  upstreamToken,
}) {
  const tasks = slots.map((slot) => [
    ...RESEARCH_LENSES.map((lens) => buildLensTask(lens, slot, targetRepoUrl, sourceRepoUrl, artifactDir)),
    buildSynthesisTask(slot, targetRepoUrl, sourceRepoUrl, artifactDir),
  ].join('\n')).join('\n');

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
  - id: scrub-handoff-artifacts
    description: |
      Check for ephemeral inter-task handoff files (candidates.json, research-*.json,
      lens-*.json) in the git worktree before merge.
      Goal: Report any worktree-leaked handoff JSON after filing.
      Motivation: Handoff state stays in the external run directory and must never ship in a PR diff.
      Safety invariant: Changes no repository or home Invoker state.
      Review claim: Worktree has no candidates.json/research-*.json/lens-*.json left.
      Review lane: proof
      Slice rationale: Required leaf after file-linear-tickets, before merge.
      Architectural effect: None; read-only check only.
      Alternative considerations: Mutating cleanup at the terminal gate was rejected.
      Implementation details: Run scripts/scrub-handoff-artifacts.sh without --apply.
      Non-goals: No feature edits, repository mutations, or ledger.json changes.
      Files: (none)
      Change types: none
      Acceptance criteria:
      - \`bash scripts/scrub-handoff-artifacts.sh\` exits 0 with no handoff paths remaining
      Layer: e2e_regression
      Feature state: active
    command: "bash scripts/scrub-handoff-artifacts.sh"
    dependencies:
      - file-linear-tickets
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
