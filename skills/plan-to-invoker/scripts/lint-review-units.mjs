#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getLabelSection,
  validateChangeTypeItems,
  validateSingleReviewUnitFocus,
} from '../../../scripts/review-unit-rules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveYamlModulePath(scriptDir) {
  const localRepoRoot = resolve(scriptDir, '../../..');
  const localYamlPath = resolve(localRepoRoot, 'packages/app/node_modules/yaml/dist/index.js');
  if (existsSync(localYamlPath)) return localYamlPath;

  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd: scriptDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const sharedRepoRoot = resolve(scriptDir, gitCommonDir, '..');
    const sharedYamlPath = resolve(sharedRepoRoot, 'packages/app/node_modules/yaml/dist/index.js');
    if (existsSync(sharedYamlPath)) return sharedYamlPath;
  } catch {
    // Fall through to the explicit error below.
  }

  throw new Error(
    'Unable to resolve yaml runtime. Checked packages/app/node_modules/yaml/dist/index.js in the current worktree and the shared git checkout.',
  );
}

const { parse: parseYaml } = await import(resolveYamlModulePath(__dirname));

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
