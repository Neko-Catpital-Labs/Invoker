#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Locate the Invoker checkout that owns this doctor script. Checked in order:
 * 1. `INVOKER_REPO_ROOT` (explicit override, same convention used elsewhere
 *    in the app, e.g. packages/contracts/src/repo-root.ts).
 * 2. The local relative path (this script running from inside a live
 *    Invoker checkout or worktree).
 * 3. The shared checkout behind a linked git worktree's common dir.
 * 4. `sourceRepoRoot` recorded in ~/.invoker/bundled-skills.json by the last
 *    `scripts/setup-agent-skills.sh` install — needed when this script is
 *    running from a machine-level skill install (e.g.
 *    ~/.claude/skills/invoker-plan-to-invoker/scripts), which ships outside
 *    any git repository and can't resolve steps 2-3.
 */
function resolveInvokerRepoRoot(scriptDir) {
  const hasWorkspaceMarker = (dir) => existsSync(resolve(dir, 'pnpm-workspace.yaml'));

  const envRoot = process.env.INVOKER_REPO_ROOT;
  if (envRoot && hasWorkspaceMarker(envRoot)) return resolve(envRoot);

  const localRepoRoot = resolve(scriptDir, '../../..');
  if (hasWorkspaceMarker(localRepoRoot)) return localRepoRoot;

  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd: scriptDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const sharedRepoRoot = resolve(scriptDir, gitCommonDir, '..');
    if (hasWorkspaceMarker(sharedRepoRoot)) return sharedRepoRoot;
  } catch {
    // Fall through to the manifest-based lookup below.
  }

  try {
    const invokerHome = process.env.INVOKER_DB_DIR ?? resolve(homedir(), '.invoker');
    const manifestPath = resolve(invokerHome, 'bundled-skills.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.sourceRepoRoot === 'string' && hasWorkspaceMarker(manifest.sourceRepoRoot)) {
      return resolve(manifest.sourceRepoRoot);
    }
  } catch {
    // Fall through to the explicit error at the call site.
  }

  return null;
}

const invokerRepoRoot = resolveInvokerRepoRoot(__dirname);
if (!invokerRepoRoot) {
  throw new Error(
    'Unable to resolve the Invoker checkout for this doctor script (checked INVOKER_REPO_ROOT, the local '
    + 'worktree, the shared git checkout, and ~/.invoker/bundled-skills.json). Set INVOKER_REPO_ROOT to an '
    + "Invoker checkout, or reinstall skills with 'bash scripts/setup-agent-skills.sh' so "
    + '~/.invoker/bundled-skills.json records the source checkout.',
  );
}

const yamlModulePath = resolve(invokerRepoRoot, 'packages/app/node_modules/yaml/dist/index.js');
if (!existsSync(yamlModulePath)) {
  throw new Error(`Unable to resolve yaml runtime. Expected it at ${yamlModulePath}.`);
}
const { parse: parseYaml } = await import(yamlModulePath);

const reviewUnitRulesPath = resolve(invokerRepoRoot, 'scripts/review-unit-rules.mjs');
if (!existsSync(reviewUnitRulesPath)) {
  throw new Error(`Unable to resolve review-unit-rules.mjs. Expected it at ${reviewUnitRulesPath}.`);
}
const {
  getLabelSection,
  validateChangeTypeItems,
  validateSingleReviewUnitFocus,
} = await import(reviewUnitRulesPath);

function reviewFocusTexts(text) {
  return [
    getLabelSection(text, 'Review claim'),
    getLabelSection(text, 'Slice rationale'),
    getLabelSection(text, 'Implementation details'),
    getLabelSection(text, 'Implementation'),
  ].filter(Boolean);
}

function validateTask(task, enforceReviewUnits) {
  const errors = [];
  if (!enforceReviewUnits) return errors;

  const taskId = typeof task.id === 'string' && task.id.trim() ? task.id : '<unknown>';
  const context = `Task "${taskId}"`;
  const description = typeof task.description === 'string' ? task.description : '';
  const prompt = typeof task.prompt === 'string' ? task.prompt : '';

  errors.push(...validateSingleReviewUnitFocus({
    context: `${context} description`,
    texts: reviewFocusTexts(description),
  }));
  errors.push(...validateChangeTypeItems(getLabelSection(description, 'Change types'), `${context} description`));

  if (prompt) {
    errors.push(...validateSingleReviewUnitFocus({
      context: `${context} prompt`,
      texts: reviewFocusTexts(prompt),
    }));
  }

  return errors;
}

function lintPlan(planPath) {
  const content = readFileSync(planPath, 'utf8');
  const raw = parseYaml(content);
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return ['Plan must be a YAML object.'];
  }

  const enforceReviewUnits = String(raw.onFinish ?? 'pull_request').toLowerCase() !== 'none';
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  for (const task of tasks) {
    errors.push(...validateTask(task, enforceReviewUnits));
  }
  return errors;
}

function usage() {
  console.error('Usage: node lint-review-units.mjs <plan.yaml>');
  process.exit(2);
}

const planPath = process.argv[2];
if (!planPath) usage();

try {
  const errors = lintPlan(planPath);
  if (errors.length > 0) {
    console.error('Review unit lint FAILED:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log(`Review unit lint passed: ${planPath}`);
} catch (error) {
  console.error(`Review unit lint ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
