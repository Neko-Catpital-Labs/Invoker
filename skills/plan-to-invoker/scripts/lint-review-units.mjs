#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Locate the Invoker checkout that owns this doctor script, for the two
 * dependencies (`yaml`, `review-unit-rules.mjs`) not already vendored under
 * ./vendor. This is dev-convenience-only now — see resolveYamlModulePath and
 * resolveReviewUnitRulesModulePath below, which check the vendored copies
 * first and only fall back to this when ./vendor is somehow missing.
 * Checked in order:
 * 1. `INVOKER_REPO_ROOT` (explicit override, same convention used elsewhere
 *    in the app, e.g. packages/contracts/src/repo-root.ts).
 * 2. The local relative path (this script running from inside a live
 *    Invoker checkout or worktree).
 * 3. The shared checkout behind a linked git worktree's common dir.
 * 4. `sourceRepoRoot` recorded in ~/.invoker/bundled-skills.json by the last
 *    `scripts/setup-agent-skills.sh` install.
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

/**
 * Primary path for both dependencies: a copy vendored directly under this
 * script's own directory (./vendor/yaml, ./vendor/review-unit-rules.mjs),
 * checked and re-synced by `bash scripts/vendor-plan-doctor-deps.sh` and
 * drift-tested by scripts/test-plan-to-invoker-skill.sh. This is what makes
 * skill-doctor.sh self-sufficient wherever skills/ ends up copied — the
 * machine-level skill install, and the invoker-cli/invoker-slack release
 * tarballs (scripts/archive-cli-binary.sh, scripts/archive-slack-binary.sh),
 * none of which carry packages/ or a repo-root scripts/ directory.
 */
function resolveVendoredDependency(scriptDir, relativeVendorPath) {
  const vendoredPath = resolve(scriptDir, 'vendor', relativeVendorPath);
  return existsSync(vendoredPath) ? vendoredPath : null;
}

function resolveYamlModulePath(scriptDir) {
  const vendored = resolveVendoredDependency(scriptDir, 'yaml/index.js');
  if (vendored) return vendored;

  const invokerRepoRoot = resolveInvokerRepoRoot(scriptDir);
  if (invokerRepoRoot) {
    const repoYamlPath = resolve(invokerRepoRoot, 'packages/app/node_modules/yaml/dist/index.js');
    if (existsSync(repoYamlPath)) return repoYamlPath;
  }

  throw new Error(
    'Unable to resolve yaml runtime. Checked ./vendor/yaml/index.js (run '
    + "'bash scripts/vendor-plan-doctor-deps.sh' if this checkout is missing it) and "
    + 'packages/app/node_modules/yaml/dist/index.js in a resolvable Invoker checkout.',
  );
}

function resolveReviewUnitRulesModulePath(scriptDir) {
  const vendored = resolveVendoredDependency(scriptDir, 'review-unit-rules.mjs');
  if (vendored) return vendored;

  const invokerRepoRoot = resolveInvokerRepoRoot(scriptDir);
  if (invokerRepoRoot) {
    const repoReviewUnitRulesPath = resolve(invokerRepoRoot, 'scripts/review-unit-rules.mjs');
    if (existsSync(repoReviewUnitRulesPath)) return repoReviewUnitRulesPath;
  }

  throw new Error(
    'Unable to resolve review-unit-rules.mjs. Checked ./vendor/review-unit-rules.mjs (run '
    + "'bash scripts/vendor-plan-doctor-deps.sh' if this checkout is missing it) and "
    + 'scripts/review-unit-rules.mjs in a resolvable Invoker checkout.',
  );
}

const { parse: parseYaml } = await import(resolveYamlModulePath(__dirname));

const {
  getLabelSection,
  validateChangeTypeItems,
  validateSingleReviewUnitFocus,
} = await import(resolveReviewUnitRulesModulePath(__dirname));

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
