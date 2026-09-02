#!/usr/bin/env node
/**
 * Fail-closed planning completeness gate.
 * Rejects plans that still have placeholder Goal/Motivation/Safety invariant,
 * missing repoUrl (unless scratch), non-runnable Verify, or leftover REPLACE_ME.
 *
 * Usage: node check-planning-completeness.mjs <plan.yaml>
 * Exit 0 = complete; exit 1 = gaps (printed as JSON to stdout, human lines on stderr)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function importYaml(scriptDir) {
  try {
    return await import('yaml');
  } catch {}
  const candidates = [
    process.env.INVOKER_REPO_ROOT,
    resolve(scriptDir, '../../..'),
  ].filter(Boolean);
  try {
    const manifest = join(homedir(), '.invoker', 'bundled-skills.json');
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
      if (parsed.sourceRepoRoot) candidates.push(parsed.sourceRepoRoot);
    }
  } catch {
    // ignore
  }
  for (const root of candidates) {
    const repoYamlPath = resolve(root, 'packages/app/node_modules/yaml/dist/index.js');
    if (existsSync(repoYamlPath)) return import(repoYamlPath);
  }
  throw new Error('Unable to resolve yaml runtime for check-planning-completeness.');
}

const { parse: parseYaml } = await importYaml(__dirname);

const PLACEHOLDER_RE = /\bREPLACE_ME\b|\bTODO\b|\bTBD\b|\bFIXME\b/i;
const MANUAL_VERIFY_RE = /\bmanually\s+check\b|\bcheck\s+manually\b|\bby\s+hand\b/i;
const GIT_URL_RE = /^(?:git@|https?:\/\/|ssh:\/\/).+\..+/i;
const GREEN_BASELINE_RE = /\b(?:existing\s+)?(?:green\s+)?(?:baseline|suite|tests?|checks?)\b[^.\n]*(?:\bis\b|\bare\b|\bremains?\b)[^.\n]*\bgreen\b/i;
const UNVERIFIED_RE = new RegExp('^\\s*UNVERIFIED:\\s*', 'i');
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const HEADING_LABELS = [
  'Goal',
  'Motivation',
  'Safety invariant',
  'Effectiveness measurement',
  'Review claim',
  'Review lane',
  'Slice rationale',
  'Architectural effect',
  'Alternative considerations',
  'Alternatives',
  'Implementation details',
  'Implementation',
  'Acceptance criteria',
  'Non-goals',
  'Layer',
  'Feature state',
  'Files',
  'Change types',
];

function buildHeadingRegex(label) {
  const stops = HEADING_LABELS.filter((candidate) => candidate !== label).join('|');
  return new RegExp(`\\b${label}:\\s*(.+?)(?=\\s+(?:${stops}):|$)`, 'is');
}

const HEADING_RE = {
  goal: buildHeadingRegex('Goal'),
  motivation: buildHeadingRegex('Motivation'),
  safety: buildHeadingRegex('Safety invariant'),
  effectiveness: buildHeadingRegex('Effectiveness measurement'),
};

const SAFETY_LABEL_PRESENT_RE = /\bSafety invariant:/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectTasks(plan) {
  const tasks = [];
  if (Array.isArray(plan.tasks)) {
    for (const task of plan.tasks) tasks.push({ workflow: null, task });
  }
  if (Array.isArray(plan.workflows)) {
    for (const workflow of plan.workflows) {
      if (!isRecord(workflow) || !Array.isArray(workflow.tasks)) continue;
      for (const task of workflow.tasks) tasks.push({ workflow: workflow.name ?? null, task });
    }
  }
  return tasks;
}

function headingValue(text, kind) {
  const match = text.match(HEADING_RE[kind]);
  return match?.[1]?.trim() ?? '';
}

function isPlaceholder(value) {
  if (!value || !value.trim()) return true;
  if (PLACEHOLDER_RE.test(value)) return true;
  if (/^REPLACE_ME\b/i.test(value.trim())) return true;
  return false;
}

function extractVerifyCandidates(plan, tasks) {
  const candidates = [];
  const desc = typeof plan.description === 'string' ? plan.description : '';
  const verifyLine = desc.match(/\bVerify:\s*(.+)$/im)?.[1]?.trim();
  if (verifyLine) candidates.push({ source: 'description', value: verifyLine });

  for (const { task } of tasks) {
    if (!isRecord(task)) continue;
    if (typeof task.command === 'string' && task.command.trim()) {
      candidates.push({ source: `task:${task.id ?? '?'}.command`, value: task.command.trim() });
    }
    const text = [task.description, task.prompt].filter((v) => typeof v === 'string').join('\n');
    const acceptance = text.match(/Acceptance criteria:[\s\S]*?`([^`]+)`/);
    if (acceptance?.[1]) {
      candidates.push({ source: `task:${task.id ?? '?'}.acceptance`, value: acceptance[1].trim() });
    }
  }
  return candidates;
}

function planTextWithoutUnverifiedClaims(plan, tasks) {
  const parts = [typeof plan.description === 'string' ? plan.description : ''];
  for (const { task } of tasks) {
    if (!isRecord(task)) continue;
    parts.push(task.description, task.prompt);
  }
  return parts
    .filter((value) => typeof value === 'string')
    .map((value) => value.split(/\r?\n/).filter((line) => !UNVERIFIED_RE.test(line)).join('\n'))
    .join('\n');
}

function receiptCandidates(plan) {
  if (!Array.isArray(plan.verificationEvidence)) return [];
  return plan.verificationEvidence
    .map((record) => {
      if (!isRecord(record)) return null;
      if (record.version !== 2 || record.trust !== 'trusted' || !isRecord(record.attestation)) {
        return null;
      }
      return isRecord(record.receipt) ? record.receipt : null;
    })
    .filter(Boolean);
}

function hasFreshGreenBaselineReceipt(plan) {
  const targetCommit = typeof plan.baseCommitSha === 'string'
    ? plan.baseCommitSha.trim().toLowerCase()
    : typeof plan.commitSha === 'string' ? plan.commitSha.trim().toLowerCase() : '';
  if (!targetCommit) return false;
  const now = Date.now();
  return receiptCandidates(plan).some((receipt) => {
    if (receipt.kind !== 'deterministic_command' || receipt.status !== 'passed') return false;
    if (typeof receipt.commitSha !== 'string' || receipt.commitSha.trim().toLowerCase() !== targetCommit) return false;
    if (typeof receipt.recordedAt !== 'string') return false;
    const recordedAt = Date.parse(receipt.recordedAt);
    if (!Number.isFinite(recordedAt) || now - recordedAt < 0 || now - recordedAt > RECEIPT_MAX_AGE_MS) return false;
    return typeof receipt.command === 'string' && receipt.command.trim()
      && receipt.exitCode === 0
      && typeof receipt.output === 'string' && receipt.output.trim();
  });
}

function hasUnsupportedGreenBaselineClaim(plan, tasks) {
  return planTextWithoutUnverifiedClaims(plan, tasks)
    .split(/[.!?\n]+/)
    .some((sentence) => GREEN_BASELINE_RE.test(sentence));
}

function checkPlan(plan) {
  const gaps = [];

  if (!isRecord(plan)) {
    return [{ field: 'plan', message: 'Plan did not parse as a YAML object.' }];
  }

  const scratch = plan.scratch === true;
  const repoUrl = typeof plan.repoUrl === 'string' ? plan.repoUrl.trim() : '';
  if (!scratch) {
    if (!repoUrl) {
      gaps.push({ field: 'repoUrl', message: 'Missing repoUrl (or set scratch: true for no-repo plans).' });
    } else if (!GIT_URL_RE.test(repoUrl) && repoUrl !== '.') {
      gaps.push({ field: 'repoUrl', message: `repoUrl is not a git URL: ${repoUrl}` });
    }
  }

  const planText = JSON.stringify(plan);
  if (PLACEHOLDER_RE.test(planText)) {
    gaps.push({ field: 'REPLACE_ME', message: 'Plan still contains REPLACE_ME / TODO / TBD / FIXME placeholders.' });
  }

  const tasks = collectTasks(plan);

  if (hasUnsupportedGreenBaselineClaim(plan, tasks) && !hasFreshGreenBaselineReceipt(plan)) {
    gaps.push({
      field: 'baselineEvidence',
      message: 'Present-tense green-baseline claims require a fresh, commit-bound passed deterministic_command receipt with non-empty output, or must be prefixed with UNVERIFIED:.',
    });
  }

  for (const { task } of tasks) {
    if (!isRecord(task)) continue;
    const text = [task.description, task.prompt].filter((v) => typeof v === 'string').join('\n\n');
    if (!SAFETY_LABEL_PRESENT_RE.test(text)) continue;
    const id = typeof task.id === 'string' ? task.id : '(unnamed)';
    const value = headingValue(text, 'effectiveness');
    if (isPlaceholder(value)) {
      gaps.push({
        field: `${id}.Effectiveness measurement`,
        message: `Task "${id}" is missing a real Effectiveness measurement: (empty or placeholder).`,
      });
    }
  }

  const implementationTasks = tasks.filter(({ task }) => {
    if (!isRecord(task)) return false;
    const hasPrompt = typeof task.prompt === 'string' && task.prompt.trim();
    const hasCommand = typeof task.command === 'string' && task.command.trim();
    // Proof-only command tasks still need Goal/Motivation when onFinish != none,
    // but allow command-only verify plans with onFinish none to skip heading depth.
    if (plan.onFinish === 'none' && hasCommand && !hasPrompt) return false;
    return hasPrompt || hasCommand || typeof task.description === 'string';
  });

  if (plan.onFinish && plan.onFinish !== 'none') {
    for (const { task } of implementationTasks) {
      if (!isRecord(task)) continue;
      const id = typeof task.id === 'string' ? task.id : '(unnamed)';
      const text = [task.description, task.prompt].filter((v) => typeof v === 'string').join('\n\n');
      for (const [kind, label] of [
        ['goal', 'Goal'],
        ['motivation', 'Motivation'],
        ['safety', 'Safety invariant'],
      ]) {
        const value = headingValue(text, kind);
        if (isPlaceholder(value)) {
          gaps.push({
            field: `${id}.${label}`,
            message: `Task "${id}" is missing a real ${label}: (empty or placeholder).`,
          });
        }
      }
    }

    const verifies = extractVerifyCandidates(plan, tasks);
    if (verifies.length === 0) {
      gaps.push({
        field: 'Verify',
        message: 'No runnable Verify command found (description Verify:, task command:, or acceptance backtick command).',
      });
    } else if (verifies.every((v) => MANUAL_VERIFY_RE.test(v.value) || isPlaceholder(v.value))) {
      gaps.push({
        field: 'Verify',
        message: `Verify is not runnable: ${verifies.map((v) => v.value).join(' | ')}`,
      });
    }
  }

  return gaps;
}

const planPath = process.argv[2];
if (!planPath) {
  console.error('Usage: node check-planning-completeness.mjs <plan.yaml>');
  process.exit(2);
}
if (!existsSync(planPath)) {
  console.error(`Plan file not found: ${planPath}`);
  process.exit(2);
}

let plan;
try {
  plan = parseYaml(readFileSync(planPath, 'utf8'));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Failed to parse YAML: ${message}`);
  process.exit(1);
}

const gaps = checkPlan(plan);
const result = {
  planFile: planPath,
  complete: gaps.length === 0,
  gaps,
};

console.log(JSON.stringify(result, null, 2));
if (gaps.length > 0) {
  for (const gap of gaps) {
    console.error(`GAP ${gap.field}: ${gap.message}`);
  }
  process.exit(1);
}
process.exit(0);
