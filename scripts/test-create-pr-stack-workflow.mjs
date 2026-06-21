#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CREATE_PR = join(ROOT, 'scripts', 'create-pr.mjs');
const TMP_PREFIX = join(tmpdir(), 'create-pr-stack-workflow-');

const VALID_BODY = `## Summary

This branch updates the PR workflow.

<details>
<summary>Review metadata</summary>

Review Claim:

Keep stack publication on the supported path.

Review Lane:

- policy

Review Unit:

- tooling-policy

Safety Invariant:

Only PR workflow tooling changes.

Slice Rationale:

Stack publishing stays separate from unrelated cleanup.

</details>

## Non-goals

- Do not change app behavior.

## Test Plan

- [ ] \`node scripts/test-create-pr-stack-workflow.mjs\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf-8',
    ...options,
  });
}

function git(cwd, ...args) {
  return run('git', ['-C', cwd, ...args]);
}

function gitQuiet(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

function readLogLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean);
}

function readGhCalls(path) {
  return readLogLines(path).map((line) => {
    const [route, stdin = ''] = line.split('\t');
    return { route, stdin };
  });
}

function createHarness() {
  const root = mkdtempSync(TMP_PREFIX);
  const binDir = join(root, 'bin');
  mkdirSync(binDir);

  const pushLog = join(root, 'push.log');
  const ghLog = join(root, 'gh.log');
  const realGit = run('which', ['git']).trim();

  writeExecutable(join(binDir, 'git'), `#!/bin/sh
if [ "$1" = "push" ]; then
  printf '%s\n' "$*" >> "$TEST_PUSH_LOG"
  exit 0
fi
exec "$REAL_GIT" "$@"
`);

  writeExecutable(join(binDir, 'gh'), `#!/bin/sh
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  printf 'repo view\t\n' >> "$GH_CALL_LOG"
  if [ -n "$GH_REPO_VIEW_OUTPUT" ]; then
    printf '%s' "$GH_REPO_VIEW_OUTPUT"
  else
    printf '%s' 'owner/repo'
  fi
  exit 0
fi

if [ "$1" = "api" ]; then
  route="$2"
  stdin=''
  if [ "$5" = "--input" ] && [ "$6" = "-" ]; then
    stdin="$(cat)"
  fi
  printf '%s\t%s\n' "$route" "$stdin" >> "$GH_CALL_LOG"

  case "$route" in
    *"/pulls?"*)
      if [ -n "$GH_API_PULLS_JSON" ]; then
        printf '%s' "$GH_API_PULLS_JSON"
      else
        printf '%s' '[]'
      fi
      exit 0
      ;;
    */pulls/[0-9]*)
      if [ -n "$GH_PATCH_RESPONSE" ]; then
        printf '%s' "$GH_PATCH_RESPONSE"
      else
        printf '%s' '{"html_url":"https://example.com/pull/0"}'
      fi
      exit 0
      ;;
    */pulls)
      if [ -n "$GH_POST_RESPONSE" ]; then
        printf '%s' "$GH_POST_RESPONSE"
      else
        printf '%s' '{"html_url":"https://example.com/pull/0"}'
      fi
      exit 0
      ;;
  esac
fi

printf 'Unexpected gh invocation: %s\n' "$*" >&2
exit 2
`);

  return {
    root,
    pushLog,
    ghLog,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      REAL_GIT: realGit,
      TEST_PUSH_LOG: pushLog,
      GH_CALL_LOG: ghLog,
      GH_REPO_VIEW_OUTPUT: 'owner/repo',
    },
  };
}

function createRepo(harness) {
  const originBare = join(harness.root, 'origin.git');
  const seed = join(harness.root, 'seed');
  const work = join(harness.root, 'work');

  gitQuiet(harness.root, 'init', '--bare', '--initial-branch=master', originBare);
  gitQuiet(harness.root, 'clone', originBare, seed);
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'test-user');
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  git(seed, 'add', 'README.md');
  gitQuiet(seed, 'commit', '-m', 'seed');
  gitQuiet(seed, 'push', 'origin', 'HEAD:master');
  rmSync(seed, { recursive: true, force: true });

  gitQuiet(harness.root, 'clone', originBare, work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'test-user');
  writeFileSync(join(work, 'pr-body.md'), VALID_BODY);

  return { originBare, work };
}

function commitFile(work, fileName, content, message) {
  writeFileSync(join(work, fileName), content);
  git(work, 'add', fileName);
  gitQuiet(work, 'commit', '-m', message);
}

function createTrackedBranch(work, branch, startPoint = 'origin/master') {
  gitQuiet(work, 'switch', '-c', branch, '--track', startPoint);
}

function setManagedBranchConfig(work, branch, baseBranch = 'master') {
  git(work, 'config', `branch.${branch}.remote`, 'origin');
  git(work, 'config', `branch.${branch}.merge`, `refs/heads/${baseBranch}`);
}

function advanceOriginMaster(harness, originBare) {
  const advance = join(harness.root, `advance-${Date.now()}`);
  gitQuiet(harness.root, 'clone', originBare, advance);
  git(advance, 'config', 'user.email', 'test@example.com');
  git(advance, 'config', 'user.name', 'test-user');
  appendFileSync(join(advance, 'README.md'), 'advance\n');
  git(advance, 'add', 'README.md');
  gitQuiet(advance, 'commit', '-m', 'advance origin master');
  gitQuiet(advance, 'push', 'origin', 'HEAD:master');
  rmSync(advance, { recursive: true, force: true });
}

function runCreatePr(work, harness, args, envOverrides = {}) {
  return spawnSync(process.execPath, [CREATE_PR, ...args], {
    cwd: work,
    env: {
      ...harness.env,
      ...envOverrides,
    },
    encoding: 'utf-8',
  });
}

function baseArgs() {
  return ['--title', 'test title', '--base', 'master', '--body-file', 'pr-body.md'];
}

function stackTitleArgs(base = 'master') {
  return ['--title', '[Graph Blanking](1) Preserve graph blanking', '--base', base, '--body-file', 'pr-body.md'];
}

function expectNoPush(harness, label) {
  assert(readLogLines(harness.pushLog).length === 0, `${label}: expected no git push attempt`);
}

function testStaleBaseDetection() {
  const harness = createHarness();
  try {
    const { originBare, work } = createRepo(harness);
    createTrackedBranch(work, 'feature/stale');
    commitFile(work, 'feature.txt', 'feature\n', 'feature change');
    advanceOriginMaster(harness, originBare);

    const result = runCreatePr(work, harness, baseArgs());
    assert(result.status === 1, 'stale base detection should fail');
    assert(result.stderr.includes('not based on the latest origin/master'), 'stale base error should name origin/master');
    assert(result.stderr.includes('git cherry-pick <commit> [<commit> ...]'), 'stale base error should include cherry-pick recovery');
    expectNoPush(harness, 'stale base detection');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testMergifyManagedCreateRefusal() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    createTrackedBranch(work, 'pr/stack-create');
    commitFile(work, 'stack.txt', 'stack\n', 'stack create\n\nChange-Id: Icreate0001');
    setManagedBranchConfig(work, 'pr/stack-create');

    const result = runCreatePr(work, harness, baseArgs());
    assert(result.status === 1, `managed stack create should fail\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(result.stderr.includes('This branch is managed by Mergify stacks.'), `managed stack create should explain branch state\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(result.stderr.includes('mergify stack push'), 'managed stack create should require mergify stack push');
    expectNoPush(harness, 'managed create refusal');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testMergifyManagedUpdateSkipsPush() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    const branch = 'stack/test-managed-update';
    createTrackedBranch(work, branch);
    commitFile(work, 'stack.txt', 'stack\n', 'stack update\n\nChange-Id: Iupdate0001');
    gitQuiet(work, 'push', '-u', 'origin', branch);
    setManagedBranchConfig(work, branch);

    const result = runCreatePr(work, harness, [...stackTitleArgs(), '--update-existing'], {
      GH_API_PULLS_JSON: JSON.stringify([
        {
          number: 42,
          html_url: 'https://example.com/pull/42',
          head: { ref: branch, repo: { full_name: 'owner/repo' } },
        },
      ]),
      GH_PATCH_RESPONSE: JSON.stringify({ html_url: 'https://example.com/pull/42' }),
    });

    const ghLog = existsSync(harness.ghLog) ? readFileSync(harness.ghLog, 'utf-8') : '';
    assert(
      result.status === 0,
      `managed stack update should succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\ngh log:\n${ghLog}`,
    );
    assert(
      result.stdout.trim() === 'https://example.com/pull/42',
      `managed stack update should print updated PR URL\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\ngh log:\n${ghLog}`,
    );
    expectNoPush(harness, 'managed update skip push');

    const ghCalls = readGhCalls(harness.ghLog);
    assert(ghCalls.some((call) => call.route.includes('/pulls?')), 'managed update should look up current branch PR');
    const patchCall = ghCalls.find((call) => call.route.endsWith('/pulls/42'));
    assert(Boolean(patchCall), 'managed update should patch the existing PR');
    assert(patchCall.stdin.includes('"title":"[Graph Blanking](1) Preserve graph blanking"'), 'managed update patch should include title');
    assert(patchCall.stdin.includes('## Summary'), 'managed update patch should include PR body');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testMergifyManagedUpdateRejectsPlainTitle() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    const branch = 'stack/test-title-reject';
    createTrackedBranch(work, branch);
    commitFile(work, 'stack.txt', 'stack\n', 'stack update\n\nChange-Id: Ititle0001');
    gitQuiet(work, 'push', '-u', 'origin', branch);
    setManagedBranchConfig(work, branch);

    const result = runCreatePr(work, harness, [...baseArgs(), '--update-existing']);

    assert(result.status === 1, 'managed stack update should reject a plain title');
    assert(result.stderr.includes('Stack PR titles must start with a shared idea'), 'stack title error should explain format');
    expectNoPush(harness, 'managed title rejection');
    assert(readGhCalls(harness.ghLog).length === 0, 'managed title rejection should fail before GitHub calls');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testMergifyManagedUpdateRejectsNestedTitle() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    const branch = 'stack/test-nested-title-reject';
    createTrackedBranch(work, branch);
    commitFile(work, 'stack.txt', 'stack\n', 'stack update\n\nChange-Id: Inested0001');
    gitQuiet(work, 'push', '-u', 'origin', branch);
    setManagedBranchConfig(work, branch);

    const result = runCreatePr(work, harness, [
      '--title',
      '[Graph Blanking](1)(2) Follow-up slice',
      '--base',
      'master',
      '--body-file',
      'pr-body.md',
      '--update-existing',
    ]);

    assert(result.status === 1, 'managed stack update should reject a nested title');
    assert(result.stderr.includes('exactly one slice index'), 'nested stack title error should explain format');
    expectNoPush(harness, 'managed nested title rejection');
    assert(readGhCalls(harness.ghLog).length === 0, 'managed nested title rejection should fail before GitHub calls');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testUnpublishedStackCommitsBlockUpdate() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    const branch = 'pr/stack-ahead';
    createTrackedBranch(work, branch);
    commitFile(work, 'stack.txt', 'stack\n', 'stack base\n\nChange-Id: Iahead0001');
    gitQuiet(work, 'push', '-u', 'origin', branch);
    setManagedBranchConfig(work, branch);
    commitFile(work, 'stack.txt', 'stack\nahead\n', 'stack ahead\n\nChange-Id: Iahead0002');

    const result = runCreatePr(work, harness, [...baseArgs(), '--update-existing']);
    assert(result.status === 1, 'managed stack update should fail when local commits are unpublished');
    assert(result.stderr.includes('Run `mergify stack push` first'), 'managed stack update should require mergify stack push first');
    expectNoPush(harness, 'unpublished stack commits');
    assert(readGhCalls(harness.ghLog).length === 0, 'unpublished stack commits should fail before GitHub calls');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testCurrentBranchPrLookupFailure() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    const branch = 'pr/stack-missing';
    createTrackedBranch(work, branch);
    commitFile(work, 'stack.txt', 'stack\n', 'stack missing\n\nChange-Id: Imissing0001');
    gitQuiet(work, 'push', '-u', 'origin', branch);
    setManagedBranchConfig(work, branch);

    const result = runCreatePr(work, harness, [...stackTitleArgs(), '--update-existing'], {
      GH_API_PULLS_JSON: '[]',
    });

    assert(result.status === 1, 'missing PR lookup should fail');
    assert(result.stderr.includes(`No PR exists for current branch "${branch}" in owner/repo.`), 'missing PR lookup should name the current branch');
    assert(result.stderr.includes('Run `mergify stack push` first for stack branches'), 'missing PR lookup should explain next step');
    expectNoPush(harness, 'missing current-branch PR');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testStackedDiffTitleRequiredForNonTrunkBase() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    gitQuiet(work, 'branch', 'pr/previous', 'origin/master');
    gitQuiet(work, 'push', 'origin', 'pr/previous');
    createTrackedBranch(work, 'pr/stacked-diff', 'origin/pr/previous');
    commitFile(work, 'stacked.txt', 'stacked\n', 'stacked diff');

    const result = runCreatePr(work, harness, ['--title', 'plain title', '--base', 'pr/previous', '--body-file', 'pr-body.md']);

    assert(result.status === 1, 'stacked diff PR should reject a plain title');
    assert(result.stderr.includes('Stack PR titles must start with a shared idea'), 'stacked diff title error should explain format');
    expectNoPush(harness, 'stacked diff title rejection');
    assert(readGhCalls(harness.ghLog).length === 0, 'stacked diff title rejection should fail before GitHub calls');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testHelpMentionsStackUpdateFlow() {
  const harness = createHarness();
  try {
    const result = runCreatePr(harness.root, harness, ['--help']);
    assert(result.status === 1, 'help should exit with status 1');
    assert(result.stderr.includes('--update-existing'), 'help should mention --update-existing');
    assert(result.stderr.includes('mergify stack push'), 'help should mention mergify stack push');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

const tests = [
  testStaleBaseDetection,
  testMergifyManagedCreateRefusal,
  testMergifyManagedUpdateSkipsPush,
  testMergifyManagedUpdateRejectsPlainTitle,
  testMergifyManagedUpdateRejectsNestedTitle,
  testUnpublishedStackCommitsBlockUpdate,
  testCurrentBranchPrLookupFailure,
  testStackedDiffTitleRequiredForNonTrunkBase,
  testHelpMentionsStackUpdateFlow,
];

for (const test of tests) {
  test();
}

console.log('OK: create-pr stack workflow checks passed');
