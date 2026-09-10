#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const UPSTREAM_TOKEN = '__UPSTREAM_WORKFLOW_ID__';

function usage(code) {
  process.stderr.write(
    'Usage: node skills/plan-to-invoker/scripts/submit-chain.mjs \\\n' +
    '         [--gate-policy completed|review_ready] [--onto-workflow <id>] \\\n' +
    '         <plan1.yaml> [plan2.yaml ...]\n\n' +
    'Submits an ordered workflow stack through the live Invoker owner via invoker-cli.\n' +
    'Each submission is read back with a separate query before the next one is wired.\n');
  process.exit(code);
}

function cli(args, { allowFail = false } = {}) {
  try {
    return execFileSync('invoker-cli', args, { encoding: 'utf8', timeout: 120_000 });
  } catch (err) {
    if (allowFail) return '';
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`invoker-cli ${args.join(' ')} failed (${err.status ?? 'no exit code'})` +
      (detail ? `:\n${detail}` : ' with no output'));
  }
}

function listWorkflows() {
  const raw = cli(['query', 'workflows', '--output', 'json']);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`live owner returned unparseable workflow JSON:\n${raw.slice(0, 400)}`);
  }
}

function requireLiveOwner() {
  const before = listWorkflows();
  if (!Array.isArray(before)) throw new Error('live owner did not return a workflow array');
  return before;
}

function planName(text) {
  const m = text.match(/^name:\s*"?(.+?)"?\s*$/m);
  if (!m) throw new Error('plan has no top-level name:');
  return m[1];
}

function findByName(workflows, name) {
  const hits = workflows.filter((w) => w.name === name);
  if (hits.length > 1) throw new Error(`ambiguous: ${hits.length} workflows named ${JSON.stringify(name)}`);
  return hits[0];
}

function wire(text, upstreamId, upstreamBranch, gatePolicy) {
  if (!text.includes(UPSTREAM_TOKEN)) {
    throw new Error(`stacked plan is missing ${UPSTREAM_TOKEN}; it cannot be chained`);
  }
  let out = text.replaceAll(UPSTREAM_TOKEN, upstreamId);
  out = out.replace(/^baseBranch:.*$/m, `baseBranch: ${upstreamBranch}`);
  out = out.replace(
    new RegExp(`(- workflowId: "?${upstreamId}"?\\n)(\\s*)requiredStatus: completed`),
    (_all, head, indent) =>
      `${head}${indent}taskId: "__merge__"\n${indent}requiredStatus: completed\n${indent}gatePolicy: ${gatePolicy}`);
  return out;
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help')) usage(argv.length === 0 ? 2 : 0);

let gatePolicy = 'review_ready';
let ontoWorkflow = null;
const plans = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--gate-policy') { gatePolicy = argv[++i]; continue; }
  if (argv[i] === '--onto-workflow') { ontoWorkflow = argv[++i]; continue; }
  if (argv[i].startsWith('--')) usage(2);
  plans.push(argv[i]);
}
if (!['completed', 'review_ready'].includes(gatePolicy)) {
  process.stderr.write(`unknown --gate-policy ${gatePolicy}\n`); process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), 'invoker-chain-'));
let submitted = [];

try {
  requireLiveOwner();

  let upstreamId = ontoWorkflow;
  let upstreamBranch = null;
  if (upstreamId) {
    const found = listWorkflows().find((w) => w.id === upstreamId);
    if (!found) throw new Error(`--onto-workflow ${upstreamId} is not known to the live owner`);
    upstreamBranch = found.featureBranch;
    if (!upstreamBranch) throw new Error(`upstream ${upstreamId} has no featureBranch yet`);
  }

  for (const [index, planPath] of plans.entries()) {
    let text = readFileSync(planPath, 'utf8');
    const stacked = index > 0 || Boolean(ontoWorkflow);
    if (stacked) text = wire(text, upstreamId, upstreamBranch, gatePolicy);
    else if (text.includes(UPSTREAM_TOKEN)) {
      throw new Error(`${planPath} is the chain head but still contains ${UPSTREAM_TOKEN}`);
    }

    const staged = join(scratch, basename(planPath));
    writeFileSync(staged, text);

    const name = planName(text);
    const before = listWorkflows();
    if (findByName(before, name)) {
      throw new Error(`a workflow named ${JSON.stringify(name)} already exists on the owner; refusing to submit a duplicate`);
    }

    process.stderr.write(`[submit-chain] submitting ${basename(planPath)} -> ${name}\n`);
    cli(['run', staged, '--live']);

    const after = listWorkflows();
    const created = findByName(after, name);
    if (!created) {
      throw new Error(
        `submitted ${basename(planPath)} but the live owner does not list a workflow named ${JSON.stringify(name)}.\n` +
        'The submission did not reach the owner. Nothing further was submitted.');
    }
    if (!created.featureBranch) {
      throw new Error(`owner created ${created.id} but reported no featureBranch; cannot stack the next step on it`);
    }

    process.stderr.write(`[submit-chain] ok ${created.id} base=${stacked ? upstreamBranch : 'trunk'} feature=${created.featureBranch}\n`);
    submitted.push({ id: created.id, name, feature: created.featureBranch, plan: planPath });
    upstreamId = created.id;
    upstreamBranch = created.featureBranch;
  }
} catch (err) {
  process.stderr.write(`\n[submit-chain] ABORTED: ${err.message}\n`);
  if (submitted.length) {
    process.stderr.write('[submit-chain] already submitted and left running:\n');
    for (const s of submitted) process.stderr.write(`  ${s.id}  ${s.name}\n`);
  } else {
    process.stderr.write('[submit-chain] nothing was submitted.\n');
  }
  process.exit(1);
}

process.stdout.write('\nWorkflow chain submitted and confirmed on the live owner.\n');
process.stdout.write(`GATE_POLICY=${gatePolicy}\n`);
submitted.forEach((s, i) => {
  process.stdout.write(`WF${i + 1}=${s.id} feature=${s.feature} plan=${s.plan}\n`);
});
