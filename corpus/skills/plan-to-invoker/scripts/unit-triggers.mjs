#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importYaml } from './vendor/resolve-yaml.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXCLUDED_LINE_PATTERN = /\b(separate|non-goals?|do not|does not|without|no\s+)\b/i;
const SCANNED_SECTIONS = ['Review claim', 'Slice rationale', 'Implementation details', 'Implementation'];

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
    return null;
  }
  return null;
}

function resolveReviewUnitRulesModulePath(scriptDir) {
  const vendoredPath = resolve(scriptDir, 'vendor', 'review-unit-rules.mjs');
  if (existsSync(vendoredPath)) return vendoredPath;
  const repoRoot = resolveInvokerRepoRoot(scriptDir);
  const repoRulesPath = repoRoot ? resolve(repoRoot, 'scripts/review-unit-rules.mjs') : null;
  if (repoRulesPath && existsSync(repoRulesPath)) return repoRulesPath;
  throw new Error('Unable to resolve review-unit-rules.mjs (run bash scripts/vendor-plan-doctor-deps.sh).');
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node unit-triggers.mjs <plan.yaml...>');
  process.exit(2);
}

const { parse } = await importYaml(__dirname);
const { getLabelSection, parseFileListItems, classifyReviewUnitsForPath, validateSingleReviewUnitFiles } = await import(resolveReviewUnitRulesModulePath(__dirname));

let anyFailure = false;
for (const file of files) {
  const plan = parse(readFileSync(file, 'utf8'));
  for (const task of plan?.tasks ?? []) {
    const description = String(task.description ?? '');
    const listed = parseFileListItems(getLabelSection(description, 'Files'));
    if (listed.length === 0) {
      if (String(task.prompt ?? '')) console.log(`== ${file} :: ${task.id}\n  no Files list, so this task's review unit is unchecked`);
      continue;
    }
    const errors = validateSingleReviewUnitFiles({ files: listed, context: 'description' });
    if (errors.length === 0) continue;
    anyFailure = true;
    console.log(`== ${file} :: ${task.id}`);
    for (const error of errors) console.log(`  ${error}`);
    for (const listedFile of listed) {
      const units = classifyReviewUnitsForPath(listedFile);
      if (units.length > 0) console.log(`  [${units.join(', ')}] ${listedFile}`);
    }
  }
}
process.exit(anyFailure ? 1 : 0);
