#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function importYaml(scriptDir) {
  try {
    return await import('yaml');
  } catch {
    const repoRoot = resolveInvokerRepoRoot(scriptDir);
    for (const candidate of ['packages/app/node_modules/yaml/dist/index.js', 'node_modules/yaml/dist/index.js']) {
      const yamlPath = repoRoot ? resolve(repoRoot, candidate) : null;
      if (yamlPath && existsSync(yamlPath)) return import(yamlPath);
    }
    throw new Error('Unable to resolve yaml runtime. Set INVOKER_REPO_ROOT to an Invoker checkout with installed dependencies.');
  }
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
const { detectReviewUnits, getLabelSection, validateSingleReviewUnitFocus } = await import(resolveReviewUnitRulesModulePath(__dirname));

function scannedTexts(text) {
  return SCANNED_SECTIONS.map((label) => [label, getLabelSection(text, label)]).filter(([, section]) => section);
}

function triggerLines(text) {
  const hits = new Map();
  for (const [label, section] of scannedTexts(text)) {
    for (const line of section.split('\n')) {
      if (!line.trim() || EXCLUDED_LINE_PATTERN.test(line)) continue;
      for (const unit of detectReviewUnits(line)) {
        if (!hits.has(unit)) hits.set(unit, []);
        hits.get(unit).push(`${label}: ${line.trim().slice(0, 120)}`);
      }
    }
  }
  return hits;
}

let anyFailure = false;
for (const file of files) {
  const plan = parse(readFileSync(file, 'utf8'));
  for (const task of plan?.tasks ?? []) {
    for (const field of ['description', 'prompt']) {
      const text = String(task[field] ?? '');
      if (!text) continue;
      const errors = validateSingleReviewUnitFocus({
        context: `${field}`,
        texts: scannedTexts(text).map(([, section]) => section),
      });
      if (errors.length === 0) continue;
      anyFailure = true;
      console.log(`== ${file} :: ${task.id} (${field})`);
      for (const error of errors) console.log(`  ${error}`);
      for (const [unit, lines] of triggerLines(text)) {
        console.log(`  [${unit}]`);
        for (const line of lines.slice(0, 3)) console.log(`     ${line}`);
      }
    }
  }
}
process.exit(anyFailure ? 1 : 0);
