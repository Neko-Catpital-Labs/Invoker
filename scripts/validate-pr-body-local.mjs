#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BASE_BRANCH = 'master';
const DEFAULT_BASE_REMOTE = process.env.INVOKER_PARENT_REMOTE || 'origin';

function usage() {
  console.error(`Usage: node scripts/validate-pr-body-local.mjs --body-file <file> [--base <branch>] [--base-remote <remote>]

Validates a local PR body against the current branch diff using the same changed-files
and full-diff inputs as the PR Body CI workflow.`);
  process.exit(1);
}

function parseArgs(argv) {
  let bodyFile = '';
  let baseBranch = DEFAULT_BASE_BRANCH;
  let baseRemote = DEFAULT_BASE_REMOTE;

  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--body-file':
        bodyFile = argv[++index] || '';
        break;
      case '--base':
        baseBranch = argv[++index] || '';
        break;
      case '--base-remote':
        baseRemote = argv[++index] || '';
        break;
      case '--help':
        usage();
        break;
      default:
        console.error(`Unknown option: ${argv[index]}`);
        usage();
    }
  }

  if (!bodyFile || !baseBranch || !baseRemote) {
    console.error('--body-file, --base, and --base-remote require values.');
    usage();
  }

  return { bodyFile, baseBranch, baseRemote };
}

function gitText(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function parseValidatorMessages(output, heading) {
  const lines = String(output).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];
  return lines
    .slice(start + 1)
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
}

function findNodeModules(repoRoot) {
  let current = repoRoot;
  while (true) {
    const nodeModules = join(current, 'node_modules');
    if (existsSync(nodeModules)) return nodeModules;
    const parent = dirname(current);
    if (parent === current || parent === parse(current).root) return '';
    current = parent;
  }
}

function runTrustedBaseValidator({ repoRoot, baseRef, body, changedFiles, diffText }) {
  const tempRoot = join(repoRoot, '.tmp');
  mkdirSync(tempRoot, { recursive: true });
  const validatorWorktree = mkdtempSync(join(tempRoot, 'pr-body-validator-base-'));
  const inputsDir = mkdtempSync(join(tempRoot, 'pr-body-validator-inputs-'));
  const bodyPath = join(inputsDir, 'pr-body.md');
  const changedFilesPath = join(inputsDir, 'changed-files.txt');
  const diffPath = join(inputsDir, 'pr.diff');
  let worktreeAdded = false;

  try {
    execFileSync('git', ['worktree', 'add', '--detach', validatorWorktree, baseRef], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    worktreeAdded = true;
    const nodeModules = findNodeModules(repoRoot);
    const validatorNodeModules = join(validatorWorktree, 'node_modules');
    if (nodeModules && !existsSync(validatorNodeModules)) {
      symlinkSync(nodeModules, validatorNodeModules, 'dir');
    }
    writeFileSync(bodyPath, body);
    writeFileSync(changedFilesPath, `${changedFiles.join('\n')}\n`);
    writeFileSync(diffPath, diffText);

    const result = spawnSync(
      process.execPath,
      [
        join(validatorWorktree, 'scripts', 'validate-pr-body.mjs'),
        '--body-file',
        bodyPath,
        '--changed-files-file',
        changedFilesPath,
        '--diff-file',
        diffPath,
      ],
      { cwd: validatorWorktree, encoding: 'utf8' },
    );
    if (result.error) throw result.error;

    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    if (result.status === 0) {
      return {
        errors: [],
        warnings: parseValidatorMessages(stdout, 'PR body validation warnings:'),
      };
    }

    const errors = parseValidatorMessages(stderr, 'PR body validation failed:');
    if (errors.length > 0) return { errors, warnings: [] };

    throw new Error(`Trusted-base PR body validator failed: ${stderr || stdout}`);
  } finally {
    try {
      if (worktreeAdded) {
        execFileSync('git', ['worktree', 'remove', '--force', validatorWorktree], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      }
    } finally {
      rmSync(validatorWorktree, { recursive: true, force: true });
      rmSync(inputsDir, { recursive: true, force: true });
    }
  }
}

export function isUiImpactingPath(filePath) {
  const path = filePath.replace(/\\/g, '/');
  return path.startsWith('packages/ui/')
    || path.startsWith('packages/app/src/window/')
    || path === 'packages/app/src/main.ts'
    || path === 'packages/app/src/preload.ts'
    || path === 'packages/app/src/app-menu.ts';
}

export async function validateLocalPrBody({ body, baseBranch = DEFAULT_BASE_BRANCH, baseRemote = DEFAULT_BASE_REMOTE }) {
  const baseRef = `${baseRemote}/${baseBranch}`;
  const repoRoot = process.cwd();
  gitText(['fetch', '--quiet', baseRemote, baseBranch]);
  const changedFiles = gitText(['diff', '--name-only', `${baseRef}...HEAD`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const diffText = gitText([
    'diff',
    '--find-renames',
    '--unified=200000',
    '--diff-filter=ACMRTD',
    `${baseRef}...HEAD`,
    '--',
  ]);
  const { errors, warnings } = runTrustedBaseValidator({
    repoRoot,
    baseRef,
    body,
    changedFiles,
    diffText,
  });

  return { changedFiles, diffText, errors, warnings, requiresVisualProof: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const body = readFileSync(args.bodyFile, 'utf8');
  const result = await validateLocalPrBody({
    body,
    baseBranch: args.baseBranch,
    baseRemote: args.baseRemote,
  });

  if (result.errors.length > 0) {
    console.error('PR body validation failed:');
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  if (result.warnings.length > 0) {
    console.error('PR body validation warnings:');
    for (const warning of result.warnings) {
      console.error(`- ${warning}`);
    }
  }

  console.log('PR body validation passed.');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
