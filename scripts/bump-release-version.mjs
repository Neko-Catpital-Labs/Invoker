#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function computeNextVersion(current, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) {
    throw new Error(`invalid version: ${JSON.stringify(current)}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (kind === 'patch') {
    return `${major}.${minor}.${patch + 1}`;
  }
  if (kind === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  throw new Error(`invalid kind: ${JSON.stringify(kind)}`);
}

const JSON_TARGETS = [
  'package.json',
  'packages/app/package.json',
  'packages/cli/package.json',
  'packages/slack-manager/package.json',
  'packages/watcher/package.json',
  'packages/npm-cli/package.json',
  'packages/npm-ui/package.json',
  'packages/npm-slack/package.json',
  'packages/npm-watcher/package.json',
];

const CONST_TARGETS = ['packages/cli/src/index.ts', 'packages/slack-manager/src/index.ts'];

const JSON_VERSION_RE = /"version":\s*"([^"]+)"/;
const CONST_VERSION_RE = /^const VERSION = '([^']+)';$/m;

function loadTargets() {
  const jsonTargets = JSON_TARGETS.map((relPath) => {
    const text = readFileSync(join(root, relPath), 'utf8');
    return { relPath, kind: 'json', text, current: text.match(JSON_VERSION_RE)?.[1] };
  });
  const constTargets = CONST_TARGETS.map((relPath) => {
    const text = readFileSync(join(root, relPath), 'utf8');
    return { relPath, kind: 'const', text, current: text.match(CONST_VERSION_RE)?.[1] };
  });
  return [...jsonTargets, ...constTargets];
}

function writeTarget(target, nextVersion) {
  const re = target.kind === 'json' ? JSON_VERSION_RE : CONST_VERSION_RE;
  const replacement =
    target.kind === 'json' ? `"version": "${nextVersion}"` : `const VERSION = '${nextVersion}';`;
  writeFileSync(join(root, target.relPath), target.text.replace(re, replacement));
}

function parseArgs(argv) {
  let type;
  let dryRun = false;
  let from;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--type') {
      type = argv[++i];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--from') {
      from = argv[++i];
    }
  }
  return { type, dryRun, from };
}

function main() {
  const { type, dryRun, from } = parseArgs(process.argv.slice(2));

  if (type !== 'patch' && type !== 'minor') {
    console.error(`--type must be "patch" or "minor" (got ${JSON.stringify(type)})`);
    process.exit(1);
  }

  const current = from ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

  let next;
  try {
    next = computeNextVersion(current, type);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (dryRun) {
    console.log(next);
    process.exit(0);
  }

  const targets = loadTargets();
  const mismatches = targets.filter((target) => target.current !== current);
  if (mismatches.length > 0) {
    console.error(`Cannot bump: expected all targets at version ${current}, found mismatches:`);
    for (const target of mismatches) {
      console.error(`  ${target.relPath}: expected ${current}, found ${target.current ?? 'NOT FOUND'}`);
    }
    process.exit(1);
  }

  for (const target of targets) {
    writeTarget(target, next);
  }

  console.log(next);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
