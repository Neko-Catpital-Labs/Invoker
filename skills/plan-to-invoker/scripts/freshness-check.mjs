#!/usr/bin/env node

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_PATH_PATTERN = /(?:^|[\s`'"(])((?:\.github|corpus|docs|engine|packages|scripts|tests)\/[A-Za-z0-9_@./-]+)/g;
const BACKTICK_TOKEN_PATTERN = /`([^`]+)`/g;
const ANCHOR_CLAUSE_PATTERN = /\b(?:already exists?|existing|do not create|must not create|without creating)\b/i;

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

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function normalizedRepoPaths(text) {
  const paths = [];
  for (const match of text.matchAll(REPO_PATH_PATTERN)) {
    const value = match[1]?.replace(/[),.;:]+$/, '');
    if (value && !value.split('/').includes('..')) paths.push(value);
  }
  return uniqueSorted(paths);
}

function anchorsOf(text) {
  const anchors = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const clause = raw.trim();
    if (!clause || !ANCHOR_CLAUSE_PATTERN.test(clause)) continue;
    const paths = normalizedRepoPaths(clause);
    for (const value of paths) anchors.set(`path:${value}`, { kind: 'path', value, clause });
    for (const match of clause.matchAll(BACKTICK_TOKEN_PATTERN)) {
      const value = match[1]?.trim();
      if (!value || paths.includes(value) || !/^[A-Za-z_$][\w$]*$/.test(value)) continue;
      anchors.set(`symbol:${value}`, { kind: 'symbol', value, clause });
    }
  }
  return [...anchors.values()];
}

function usage() {
  console.error('Usage: node freshness-check.mjs [--ref <git-ref>] <repo-checkout> <plan.yaml...>');
  process.exit(2);
}

function parseArgs(argv) {
  let ref = 'HEAD';
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--ref') {
      ref = argv[index + 1] ?? '';
      index += 1;
    } else {
      positional.push(argv[index]);
    }
  }
  if (!ref || positional.length < 2) usage();
  const [repo, ...files] = positional;
  return { ref, repo, files };
}

const { ref, repo, files } = parseArgs(process.argv.slice(2));
const { parse } = await importYaml(__dirname);

function gitOk(args) {
  try {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const resolvedRef = execFileSync('git', ['-C', repo, 'rev-parse', '--short', ref]).toString().trim();
const pathExists = (value) => gitOk(['cat-file', '-e', `${ref}:${value}`]);
const symbolExists = (value) => gitOk(['grep', '-F', '-q', '-e', value, ref, '--']);

let anyStale = false;
for (const file of files) {
  const plan = parse(readFileSync(file, 'utf8'));
  for (const task of plan?.tasks ?? []) {
    if (!task?.prompt) continue;
    const text = [task.description, task.prompt].filter(Boolean).join('\n');
    const missing = anchorsOf(text).filter((anchor) => (
      anchor.kind === 'path' ? !pathExists(anchor.value) : !symbolExists(anchor.value)
    ));
    const verdict = missing.length ? 'STALE -> needs_input' : 'current';
    if (missing.length) anyStale = true;
    console.log(`${verdict}  ${basename(file)} :: ${task.id}`);
    for (const anchor of missing) {
      console.log(`    missing ${anchor.kind}:${anchor.value}`);
      console.log(`      clause: ${anchor.clause.slice(0, 110)}`);
    }
  }
}
console.log(`(checked against ${repo} @ ${ref} = ${resolvedRef})`);
process.exit(anyStale ? 1 : 0);
