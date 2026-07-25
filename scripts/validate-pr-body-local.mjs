#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPrBodyWarnings, validatePrBody } from './validate-pr-body.mjs';

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
  const requiresVisualProof = changedFiles.some(isUiImpactingPath);
  const errors = await validatePrBody(body, { changedFiles, diffText, requiresVisualProof });
  const warnings = getPrBodyWarnings(body, { changedFiles, diffText });

  return { changedFiles, diffText, errors, warnings, requiresVisualProof };
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
