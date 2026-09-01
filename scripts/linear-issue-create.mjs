#!/usr/bin/env node
/**
 * Create a Linear issue from a plan-to-invoker-shaped ticket body.
 *
 * Never adds invoker-ready. Steal tickets stay unlabeled; skip/bad tickets
 * get the idea-skip label when requested.
 *
 * Env:
 *   LINEAR_API_KEY / INVOKER_LINEAR_API_KEY  required unless dry-run/fixture
 *   INVOKER_LINEAR_TEAM_ID                   Linear team id (required to create)
 *   INVOKER_LINEAR_DRY_RUN=1                 print payload, no network
 *   INVOKER_LINEAR_CREATE_CMD                stub: receives JSON on stdin
 *   INVOKER_LINEAR_LABEL_NAMES               comma list (default empty; use idea-skip for skips)
 *
 * Usage:
 *   node scripts/linear-issue-create.mjs --title "..." --body-file path.md
 *   node scripts/linear-issue-create.mjs --artifact path.json
 *
 * Artifact JSON fields (preferred):
 *   title, verdict (steal|skip), repo, goal, motivation, safetyInvariant,
 *   verify, reviewClaim, reviewLane, sliceRationale, architecturalEffect,
 *   alternatives, implementationDetails, nonGoals, files, changeTypes,
 *   acceptanceCriteria, layer, featureState, evidence,
 *   peerLandscape, alternateImplementations, adversarialAnalysis,
 *   effectivenessMeasurement (required: { leadingSignals, laggingSignals })
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LABEL_READY = 'invoker-ready';
const LABEL_SKIP = 'idea-skip';

function env(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[linear-issue-create ${ts}] ${msg}`);
}

function parseArgs(argv) {
  const out = { title: '', bodyFile: '', artifact: '', labelNames: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--title') out.title = argv[++i] ?? '';
    else if (arg === '--body-file') out.bodyFile = argv[++i] ?? '';
    else if (arg === '--artifact') out.artifact = argv[++i] ?? '';
    else if (arg === '--label') out.labelNames.push(argv[++i] ?? '');
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  const fromEnv = env('INVOKER_LINEAR_LABEL_NAMES')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  out.labelNames = [...out.labelNames, ...fromEnv];
  return out;
}

function assertNoReadyLabel(labels) {
  if (labels.some((name) => name === LABEL_READY)) {
    throw new Error(`Refusing to create Linear issues with ${LABEL_READY}`);
  }
}

function heading(name, value) {
  const text = String(value ?? '').trim();
  return text ? `${name}: ${text}` : '';
}

function formatBulletList(items, formatter) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items.map((item) => `- ${formatter(item)}`).join('\n');
}

function formatPeerLandscape(list) {
  return formatBulletList(list, (p) => `${p.repo ?? '?'}: ${p.approach ?? ''} -> ${p.outcome ?? ''}`);
}

function formatAlternateImplementations(list) {
  return formatBulletList(list, (a) => `${a.approach ?? ''} (tradeoffs: ${a.tradeoffs ?? ''})`);
}

function formatAdversarialAnalysis(list) {
  return formatBulletList(list, (a) => `${a.objection ?? ''} (strength: ${a.strength ?? ''})`);
}

function formatEffectivenessMeasurement(measurement) {
  if (!measurement || typeof measurement !== 'object') return '';
  const leading = Array.isArray(measurement.leadingSignals) ? measurement.leadingSignals : [];
  const lagging = Array.isArray(measurement.laggingSignals) ? measurement.laggingSignals : [];
  const sections = [];
  if (leading.length > 0) sections.push(`Leading signals:\n${leading.map((s) => `- ${s}`).join('\n')}`);
  if (lagging.length > 0) sections.push(`Lagging signals:\n${lagging.map((s) => `- ${s}`).join('\n')}`);
  return sections.join('\n');
}

function buildBodyFromArtifact(artifact) {
  const lines = [
    heading('Repo', artifact.repo ?? artifact.repoUrl),
    heading('Goal', artifact.goal),
    heading('Motivation', artifact.motivation),
    heading('Safety invariant', artifact.safetyInvariant ?? artifact.safety),
    heading('Verify', artifact.verify),
    heading('Review claim', artifact.reviewClaim),
    heading('Review lane', artifact.reviewLane),
    heading('Slice rationale', artifact.sliceRationale),
    heading('Architectural effect', artifact.architecturalEffect),
    heading('Alternative considerations', artifact.alternatives ?? artifact.alternativeConsiderations),
    heading('Implementation details', artifact.implementationDetails ?? artifact.implementation),
    heading('Peer landscape', formatPeerLandscape(artifact.peerLandscape)),
    heading('Alternate implementations', formatAlternateImplementations(artifact.alternateImplementations)),
    heading('Adversarial analysis', formatAdversarialAnalysis(artifact.adversarialAnalysis)),
    heading('Effectiveness measurement', formatEffectivenessMeasurement(artifact.effectivenessMeasurement)),
    heading('Non-goals', artifact.nonGoals),
    heading('Files', Array.isArray(artifact.files) ? artifact.files.join(', ') : artifact.files),
    heading('Change types', Array.isArray(artifact.changeTypes) ? artifact.changeTypes.join(', ') : artifact.changeTypes),
    heading('Acceptance criteria', Array.isArray(artifact.acceptanceCriteria)
      ? artifact.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
      : artifact.acceptanceCriteria),
    heading('Layer', artifact.layer),
    heading('Feature state', artifact.featureState),
    heading('Verdict', artifact.verdict),
    heading('Evidence', artifact.evidence),
  ].filter(Boolean);
  return `${lines.join('\n\n')}\n`;
}

function requireField(body, name) {
  const re = new RegExp(`^\\s*${name}\\s*:\\s*.+`, 'im');
  if (!re.test(body)) {
    throw new Error(`Ticket body missing required field: ${name}`);
  }
}

function validateBody(body) {
  for (const field of ['Repo', 'Goal', 'Motivation', 'Safety invariant', 'Verify', 'Effectiveness measurement']) {
    requireField(body, field);
  }
  if (/\binvoker-ready\b/i.test(body)) {
    throw new Error('Ticket body must not mention invoker-ready');
  }
}

async function linearGraphql(apiKey, query, variables = {}) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors?.length) {
    throw new Error(`Linear GraphQL failed: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

async function resolveLabelIds(apiKey, names) {
  if (names.length === 0) return [];
  const data = await linearGraphql(apiKey, `query { issueLabels(first: 250) { nodes { id name } } }`);
  const byName = new Map((data?.issueLabels?.nodes ?? []).map((n) => [n.name, n.id]));
  const ids = [];
  for (const name of names) {
    const id = byName.get(name);
    if (!id) throw new Error(`Linear label not found: ${name}`);
    ids.push(id);
  }
  return ids;
}

async function createIssue({ apiKey, teamId, title, body, labelIds, dryRun, createCmd }) {
  const payload = { teamId, title, description: body, labelIds };
  if (dryRun) {
    log(`dry-run create: ${JSON.stringify({ ...payload, description: body.slice(0, 200) })}`);
    return { id: 'dry-run', identifier: 'DRY-0' };
  }
  if (createCmd) {
    const result = spawnSync('bash', ['-lc', createCmd], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      input: JSON.stringify(payload),
    });
    if (result.status !== 0) {
      throw new Error(`create cmd failed: ${result.stderr || result.stdout}`);
    }
    try {
      return JSON.parse((result.stdout || '{}').trim() || '{}');
    } catch {
      return { id: 'stub', identifier: 'STUB-0', stdout: result.stdout };
    }
  }
  if (!apiKey) throw new Error('LINEAR_API_KEY / INVOKER_LINEAR_API_KEY required');
  if (!teamId) throw new Error('INVOKER_LINEAR_TEAM_ID required');
  const data = await linearGraphql(
    apiKey,
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }`,
    {
      input: {
        teamId,
        title,
        description: body,
        ...(labelIds.length > 0 ? { labelIds } : {}),
      },
    },
  );
  if (!data?.issueCreate?.success) {
    throw new Error(`issueCreate failed: ${JSON.stringify(data)}`);
  }
  return data.issueCreate.issue;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/linear-issue-create.mjs --artifact path.json | --title t --body-file f.md');
    process.exit(0);
  }

  let title = args.title;
  let body = '';
  let labels = [...args.labelNames];
  let verdict = '';

  if (args.artifact) {
    if (!existsSync(args.artifact)) throw new Error(`artifact not found: ${args.artifact}`);
    const artifact = JSON.parse(readFileSync(args.artifact, 'utf8'));
    title = title || artifact.title || '';
    verdict = String(artifact.verdict ?? '').toLowerCase();
    body = buildBodyFromArtifact(artifact);
    if (verdict === 'skip' && !labels.includes(LABEL_SKIP)) {
      labels.push(LABEL_SKIP);
    }
  } else if (args.bodyFile) {
    if (!existsSync(args.bodyFile)) throw new Error(`body file not found: ${args.bodyFile}`);
    body = readFileSync(args.bodyFile, 'utf8');
  } else {
    throw new Error('Provide --artifact or --body-file');
  }

  if (!title.trim()) throw new Error('title is required');
  assertNoReadyLabel(labels);
  validateBody(body);

  const apiKey = env('INVOKER_LINEAR_API_KEY') || env('LINEAR_API_KEY');
  const teamId = env('INVOKER_LINEAR_TEAM_ID');
  const dryRun = env('INVOKER_LINEAR_DRY_RUN', '0') === '1';
  const createCmd = env('INVOKER_LINEAR_CREATE_CMD');

  let labelIds = [];
  if (!dryRun && !createCmd && labels.length > 0) {
    labelIds = await resolveLabelIds(apiKey, labels);
  }

  const issue = await createIssue({
    apiKey,
    teamId,
    title: title.trim(),
    body,
    labelIds,
    dryRun,
    createCmd,
  });
  log(`created ${issue.identifier ?? issue.id} labels=${labels.join(',') || '(none)'} verdict=${verdict || 'n/a'}`);
  console.log(JSON.stringify({ ok: true, issue, labels }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
