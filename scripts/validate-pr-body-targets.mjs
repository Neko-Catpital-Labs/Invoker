#!/usr/bin/env node
// CI entry point for the "Validate each target PR body" step in
// .github/workflows/pr-body.yml. Reads the targets written by the
// "Resolve PR Body targets" step (one per real PR being validated -- the
// PR itself on an ordinary run, or every PR in a Mergify merge-queue batch,
// see scripts/resolve-pr-body-targets.mjs) and runs the same
// validate-pr-body.mjs check against each one's real body and real diff.
// Fails if any target fails, so one bad body in a batch can't ride through
// behind good batchmates.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

function parseArgs(argv) {
  let targetsFile = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--targets-file') {
      targetsFile = argv[++i] || '';
    }
  }
  if (!targetsFile) {
    console.error('Usage: node scripts/validate-pr-body-targets.mjs --targets-file <file>');
    process.exit(1);
  }
  return { targetsFile };
}

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed:\n${detail}`);
  }
  return result;
}

async function main() {
  const { targetsFile } = parseArgs(process.argv.slice(2));
  const targets = JSON.parse(readFileSync(targetsFile, 'utf8'));

  const failures = [];

  for (const target of targets) {
    console.log(`\n=== PR #${target.number} (author: ${target.author}) ===`);

    try {
      runOrThrow('git', [
        'fetch', '--no-tags', '--depth=1', 'origin',
        `+refs/pull/${target.number}/head:refs/remotes/pull/${target.number}/head`,
      ], { stdio: 'inherit' });
      const fetchedHeadSha = runOrThrow('git', ['rev-parse', `refs/remotes/pull/${target.number}/head^{commit}`]).stdout.trim();
      if (fetchedHeadSha !== target.headSha) {
        failures.push(`PR #${target.number}: fetched head ${fetchedHeadSha} did not match resolved head ${target.headSha}.`);
        continue;
      }

      runOrThrow('bash', ['scripts/fetch-pr-diff-metadata.sh'], {
        env: { ...process.env, BASE_REF: target.baseRef, HEAD_SHA: target.headSha },
      });
    } catch (error) {
      failures.push(`PR #${target.number}: ${error.message}`);
      continue;
    }

    writeFileSync('pr-body-target-current.md', target.body, 'utf8');

    const result = spawnSync('node', [
      'scripts/validate-pr-body.mjs',
      '--body-file', 'pr-body-target-current.md',
      '--changed-files-file', 'changed-files.txt',
      '--diff-file', 'pr.diff',
    ], { encoding: 'utf8' });

    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');

    if (result.status !== 0) {
      failures.push(`PR #${target.number}: PR body validation failed (see output above).`);
    }
  }

  if (failures.length > 0) {
    console.error(`\nPR Body validation failed for ${failures.length} of ${targets.length} target(s):`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(`\nPR Body validation passed for all ${targets.length} target(s).`);
}

await main();
