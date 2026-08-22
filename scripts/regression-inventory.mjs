#!/usr/bin/env node
// Loads and validates scripts/test-suites/regression-inventory.yaml -- the
// policy source for deterministic regression candidates that live outside
// the merge-required CI gates. Used by scripts/run-all-tests.sh's nightly
// mode (as a CLI: `validate`, `list`) and by
// scripts/test-regression-inventory.mjs (as a module, for unit assertions).
//
// Usage:
//   node scripts/regression-inventory.mjs validate
//   node scripts/regression-inventory.mjs list --tier nightly|manual [--field id|command|script]
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MANIFEST_PATH = resolve(repoRoot, 'scripts/test-suites/regression-inventory.yaml');
export const VALID_TIERS = new Set(['nightly', 'manual']);

export function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const parsed = YAML.parse(readFileSync(manifestPath, 'utf8'));
  const candidates = parsed?.candidates;
  if (!Array.isArray(candidates)) {
    throw new Error(`${manifestPath}: top-level "candidates" must be an array`);
  }
  return candidates;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateManifest(candidates, { repoRootPath = repoRoot } = {}) {
  const errors = [];
  const seenIds = new Set();

  for (const candidate of candidates) {
    const id = candidate?.id;
    const label = isNonEmptyString(id) ? id : JSON.stringify(candidate);

    if (!isNonEmptyString(id)) {
      errors.push(`candidate is missing a non-empty string "id": ${label}`);
      continue;
    }
    if (seenIds.has(id)) {
      errors.push(`duplicate candidate id: "${id}"`);
    }
    seenIds.add(id);

    if (!VALID_TIERS.has(candidate.tier)) {
      errors.push(`"${id}" has invalid tier "${candidate.tier}" (expected one of: ${[...VALID_TIERS].join(', ')})`);
    }
    if (typeof candidate.hermetic !== 'boolean') {
      errors.push(`"${id}" is missing a boolean "hermetic" flag`);
    }
    if (!isNonEmptyString(candidate.description)) {
      errors.push(`"${id}" is missing a non-empty "description"`);
    }
    if (!isNonEmptyString(candidate.command)) {
      errors.push(`"${id}" is missing a non-empty "command"`);
    }
    if (!isNonEmptyString(candidate.script)) {
      errors.push(`"${id}" is missing a non-empty "script" path`);
    } else if (!existsSync(resolve(repoRootPath, candidate.script))) {
      errors.push(`"${id}" references a "script" path that does not exist: ${candidate.script}`);
    }

    // The nightly tier is the automated, unattended tier -- every candidate
    // it runs must be hermetic, or a flaky/live candidate could silently
    // start gating the scheduled job.
    if (candidate.tier === 'nightly' && candidate.hermetic !== true) {
      errors.push(`"${id}" is tier "nightly" but hermetic is not true`);
    }
    if (candidate.tier === 'manual' && !isNonEmptyString(candidate.reason)) {
      errors.push(`"${id}" is tier "manual" but is missing a non-empty "reason"`);
    }
  }

  return errors;
}

export function candidatesForTier(candidates, tier) {
  if (!VALID_TIERS.has(tier)) {
    throw new Error(`unknown tier "${tier}" (expected one of: ${[...VALID_TIERS].join(', ')})`);
  }
  return candidates.filter((candidate) => candidate.tier === tier);
}

function printUsage() {
  console.error('Usage: node scripts/regression-inventory.mjs validate');
  console.error('       node scripts/regression-inventory.mjs list --tier nightly|manual [--field id|command|script]');
}

function parseListArgs(args) {
  let tier;
  let field = 'id';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--tier') {
      tier = args[i + 1];
      i += 1;
      continue;
    }
    if (args[i] === '--field') {
      field = args[i + 1];
      i += 1;
    }
  }
  return { tier, field };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const candidates = loadManifest();

  if (cmd === 'validate') {
    const errors = validateManifest(candidates);
    if (errors.length > 0) {
      console.error('[regression-inventory] manifest validation failed:');
      for (const error of errors) console.error(`  - ${error}`);
      process.exit(1);
    }
    console.log(`[regression-inventory] OK: ${candidates.length} candidate(s) each have exactly one valid tier.`);
    process.exit(0);
  }

  if (cmd === 'list') {
    const { tier, field } = parseListArgs(rest);
    if (!tier) {
      console.error('[regression-inventory] "list" requires --tier');
      printUsage();
      process.exit(2);
    }
    for (const candidate of candidatesForTier(candidates, tier)) {
      console.log(candidate[field] ?? '');
    }
    process.exit(0);
  }

  printUsage();
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
