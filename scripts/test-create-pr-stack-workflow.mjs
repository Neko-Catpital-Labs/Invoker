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

## Review Claim

Keep stack publication on the supported path.

## Review Lane

- policy

## Review Unit

- tooling-policy

## Safety Invariant

Only PR workflow tooling changes.

## Slice Rationale

Stack publishing stays separate from unrelated cleanup.

## Non-goals

- Do not change app behavior.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] \`node scripts/test-create-pr-stack-workflow.mjs\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
`;

const ROUTING_BODY = `## Summary

This branch only changes invalidation routing.

## Review Claim

Keep invalidation routing local.

## Review Lane

- behavior

## Review Unit

- routing

## Safety Invariant

Only invalidation routing changes.

## Slice Rationale

Keep app exposure separate from core runtime behavior.

## Non-goals

- Do not add docs or proof changes in this slice.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] \`node scripts/test-create-pr-stack-workflow.mjs\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
`;

const REFACTOR_BODY = `## Summary
This branch moves one helper into its own module.
## Review Claim
Move the helper with no behavior change.
## Review Lane
- refactor
## Review Unit
- ownership-refactor
## Safety Invariant
Only this one helper moves; every call site is re-pointed in this same PR.
## Slice Rationale
One technique, one PR.
## Non-goals
- No behavior change.
## Test Plan
<details>
<summary>Test Plan</summary>
- [ ] \`node scripts/test-create-pr-stack-workflow.mjs\`
</details>
## Revert Plan
<details>
<summary>Revert Plan</summary>
- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
</details>
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

function gitTextRefExists(cwd, ref) {
  return spawnSync('git', ['-C', cwd, 'rev-parse', '--verify', ref], {
    encoding: 'utf-8',
  }).status === 0;
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
if [ "$1" = "diff" ] && [ -n "$TEST_GIT_DIFF_FAIL" ]; then
  printf '%s\n' "$TEST_GIT_DIFF_FAIL" >&2
  exit 1
fi
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
      if printf '%s' "$route" | grep -q 'head='; then
        if [ -n "$GH_API_PULLS_JSON" ]; then
          printf '%s' "$GH_API_PULLS_JSON"
        else
          printf '%s' '[]'
        fi
      elif [ -n "$GH_API_OPEN_PULLS_JSON" ]; then
        printf '%s' "$GH_API_OPEN_PULLS_JSON"
      elif [ -n "$GH_API_PULLS_JSON" ]; then
        printf '%s' "$GH_API_PULLS_JSON"
      else
        printf '%s' '[]'
      fi
      exit 0
      ;;
    */issues/[0-9]*/comments?*)
      if [ -n "$GH_API_ISSUE_COMMENTS_JSON" ]; then
        printf '%s' "$GH_API_ISSUE_COMMENTS_JSON"
      else
        printf '%s' '[]'
      fi
      exit 0
      ;;
    */issues/comments/[0-9]*|*/issues/[0-9]*/comments)
      if [ -n "$GH_COMMENT_RESPONSE" ]; then
        printf '%s' "$GH_COMMENT_RESPONSE"
      else
        printf '%s' '{"id":123}'
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
  mkdirSync(dirname(join(work, fileName)), { recursive: true });
  writeFileSync(join(work, fileName), content);
  git(work, 'add', fileName);
  gitQuiet(work, 'commit', '-m', message);
}

function commitEmpty(work, message) {
  gitQuiet(work, 'commit', '--allow-empty', '-m', message);
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

function stackTitleArgs(base = 'master', title = '[Graph Blanking](1) Preserve graph blanking') {
  return ['--title', title, '--base', base, '--body-file', 'pr-body.md'];
}

function expectNoPush(harness, label) {
  assert(readLogLines(harness.pushLog).length === 0, `${label}: expected no git push attempt`);
}

function expectNoGhCalls(harness, label) {
  assert(readGhCalls(harness.ghLog).length === 0, `${label}: expected no gh invocation`);
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
function testStaleMergedHelperBaseRejectsPublication() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    gitQuiet(work, 'branch', 'pr/previous', 'origin/master');
    gitQuiet(work, 'push', 'origin', 'pr/previous');
    createTrackedBranch(work, 'feature/on-stale-helper', 'origin/pr/previous');
    commitFile(work, 'feature.txt', 'feature\n', 'feature change');

    const result = runCreatePr(work, harness, ['--title', 'test title', '--base', 'pr/previous', '--body-file', 'pr-body.md'], {
      GH_API_PULLS_JSON: JSON.stringify([
        {
          number: 86,
          state: 'closed',
          merged_at: '2026-07-26T07:32:31Z',
          html_url: 'https://example.com/pull/86',
          head: { ref: 'pr/previous', repo: { full_name: 'owner/repo' } },
        },
      ]),
    });

    assert(result.status === 1, `stale merged helper base should fail\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(
      result.stderr.includes('Refusing to create/update PR: base branch "pr/previous" belongs to a stale helper PR.'),
      `stale helper base error should explain the stale helper branch\nstderr:\n${result.stderr}`,
    );
    assert(result.stderr.includes('merged helper PR #86'), `stale helper base error should name the merged helper PR\nstderr:\n${result.stderr}`);
    assert(result.stderr.includes('git switch -c stack/<name> origin/<live-stack-base>'), 'stale helper base error should include stack rebuild command');
    assert(result.stderr.includes('git cherry-pick <commit> [<commit> ...]'), 'stale helper base error should include cherry-pick recovery');
    expectNoPush(harness, 'stale merged helper base');
    const ghCalls = readGhCalls(harness.ghLog);
    assert(ghCalls.some((call) => call.route.includes('/pulls?')), 'stale helper base rejection should look up helper-base PRs');
    assert(
      !ghCalls.some((call) => /\/pulls(?:\/[0-9]+)?$/.test(call.route)),
      `stale helper base rejection should fail before PR mutation\n${JSON.stringify(ghCalls, null, 2)}`,
    );
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testDuplicateHelperBasePrsRejectPublication() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    gitQuiet(work, 'branch', 'pr/previous', 'origin/master');
    gitQuiet(work, 'push', 'origin', 'pr/previous');
    createTrackedBranch(work, 'feature/on-stale-helper', 'origin/pr/previous');
    commitFile(work, 'feature.txt', 'feature\n', 'feature change');

    const result = runCreatePr(work, harness, ['--title', 'test title', '--base', 'pr/previous', '--body-file', 'pr-body.md'], {
      GH_API_PULLS_JSON: JSON.stringify([
        {
          number: 86,
          state: 'open',
          html_url: 'https://example.com/pull/86',
          head: { ref: 'pr/previous', repo: { full_name: 'owner/repo' } },
        },
        {
          number: 87,
          state: 'closed',
          html_url: 'https://example.com/pull/87',
          head: { ref: 'pr/previous', repo: { full_name: 'owner/repo' } },
        },
      ]),
    });

    assert(result.status === 1, `duplicate helper-base PRs should fail\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(
      result.stderr.includes('Found multiple PRs for base branch "pr/previous"'),
      `duplicate helper-base error should name the helper base\nstderr:\n${result.stderr}`,
    );
    assert(result.stderr.includes('Refusing to guess. Resolve the duplicate helper-base PRs first.'), 'duplicate helper-base error should refuse to guess');
    assert(result.stderr.includes('#86: https://example.com/pull/86'), 'duplicate helper-base error should list PR #86');
    assert(result.stderr.includes('#87: https://example.com/pull/87'), 'duplicate helper-base error should list PR #87');
    expectNoPush(harness, 'duplicate helper-base PRs');
    const ghCalls = readGhCalls(harness.ghLog);
    assert(
      !ghCalls.some((call) => /\/pulls(?:\/[0-9]+)?$/.test(call.route)),
      `duplicate helper-base rejection should fail before PR mutation\n${JSON.stringify(ghCalls, null, 2)}`,
    );
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}


function testNoFileChangesBlockPrCreation() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    createTrackedBranch(work, 'feature/no-file-changes');

    const result = runCreatePr(work, harness, baseArgs());

    assert(result.status === 1, `no file changes should block PR creation\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(
      result.stderr.includes('no file changes versus origin/master'),
      `no file changes error should name the selected base\nstderr:\n${result.stderr}`,
    );
    expectNoPush(harness, 'no file changes');
    expectNoGhCalls(harness, 'no file changes');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testEmptyCommitAloneBlocksPrCreation() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    createTrackedBranch(work, 'feature/empty-only');
    commitEmpty(work, 'empty slice');

    const result = runCreatePr(work, harness, baseArgs());

    assert(result.status === 1, `empty commit should block PR creation\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(
      result.stderr.includes('commits with no tree diff from their first parent'),
      `empty commit error should explain the tree-diff check\nstderr:\n${result.stderr}`,
    );
    assert(result.stderr.includes('empty slice'), `empty commit error should list the offending commit\nstderr:\n${result.stderr}`);
    assert(result.stderr.includes('Drop empty commits'), `empty commit error should explain drop recovery\nstderr:\n${result.stderr}`);
    assert(result.stderr.includes('squash each empty commit'), `empty commit error should explain squash recovery\nstderr:\n${result.stderr}`);
    expectNoPush(harness, 'empty commit alone');
    expectNoGhCalls(harness, 'empty commit alone');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testEmptyCommitMixedWithRealChangeBlocksPrCreation() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    createTrackedBranch(work, 'feature/empty-mixed');
    commitFile(work, 'feature.txt', 'feature\n', 'feature change');
    commitEmpty(work, 'empty follow-up');

    const result = runCreatePr(work, harness, baseArgs());

    assert(result.status === 1, `mixed empty commit should block PR creation\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(
      result.stderr.includes('commits with no tree diff from their first parent'),
      `mixed empty commit error should explain the tree-diff check\nstderr:\n${result.stderr}`,
    );
    assert(result.stderr.includes('empty follow-up'), `mixed empty commit error should list the offending commit\nstderr:\n${result.stderr}`);
    expectNoPush(harness, 'empty commit mixed with real change');
    expectNoGhCalls(harness, 'empty commit mixed with real change');
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
      GH_API_OPEN_PULLS_JSON: JSON.stringify([
        {
          number: 41,
          title: '[Graph Blanking](1) Base slice',
          html_url: 'https://example.com/pull/41',
          base: { ref: 'master' },
          head: { ref: 'stack/TestOwner/stack/example/base/root--aaaa', repo: { full_name: 'owner/repo' } },
        },
        {
          number: 42,
          title: '[Graph Blanking](2) Middle slice',
          html_url: 'https://example.com/pull/42',
          base: { ref: 'stack/example/base' },
          head: { ref: branch, repo: { full_name: 'owner/repo' } },
        },
        {
          number: 43,
          title: '[Graph Blanking](3) Top slice',
          html_url: 'https://example.com/pull/43',
          base: { ref: branch },
          head: { ref: 'stack/TestOwner/stack/example/top/top--bbbb', repo: { full_name: 'owner/repo' } },
        },
      ]),
      GH_PATCH_RESPONSE: JSON.stringify({ html_url: 'https://example.com/pull/42', number: 42 }),
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
    const commentPosts = ghCalls.filter((call) => /\/issues\/(41|42|43)\/comments$/.test(call.route));
    assert(commentPosts.length === 3, `managed update should upsert stack comments across the full stack\n${JSON.stringify(ghCalls, null, 2)}`);
    assert(commentPosts.some((call) => call.stdin.includes('Full stack for this PR series (bottom → top):')), 'stack comments should include the full stack header');
    assert(commentPosts.some((call) => call.stdin.includes('#42 — [Graph Blanking](2) Middle slice ← this PR')), 'stack comments should mark each target PR');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}
function testMergifyManagedUpdateAcceptsLetteredTitle() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    const branch = 'stack/test-lettered-update';
    createTrackedBranch(work, branch);
    commitFile(work, 'stack.txt', 'stack\n', 'stack update\n\nChange-Id: Iletter0001');
    gitQuiet(work, 'push', '-u', 'origin', branch);
    setManagedBranchConfig(work, branch);

    const result = runCreatePr(work, harness, [
      ...stackTitleArgs('master', '[Graph Blanking](3a) Split follow-up slice'),
      '--update-existing',
    ], {
      GH_API_PULLS_JSON: JSON.stringify([
        {
          number: 43,
          html_url: 'https://example.com/pull/43',
          head: { ref: branch, repo: { full_name: 'owner/repo' } },
        },
      ]),
      GH_PATCH_RESPONSE: JSON.stringify({ html_url: 'https://example.com/pull/43' }),
    });

    const ghLog = existsSync(harness.ghLog) ? readFileSync(harness.ghLog, 'utf-8') : '';
    assert(
      result.status === 0,
      `managed stack update should accept a lettered title\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\ngh log:\n${ghLog}`,
    );
    assert(
      result.stdout.trim() === 'https://example.com/pull/43',
      `managed stack update should print updated PR URL for lettered titles\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\ngh log:\n${ghLog}`,
    );
    expectNoPush(harness, 'managed lettered update skip push');

    const ghCalls = readGhCalls(harness.ghLog);
    const patchCall = ghCalls.find((call) => call.route.endsWith('/pulls/43'));
    assert(Boolean(patchCall), 'managed lettered update should patch the existing PR');
    assert(patchCall.stdin.includes('"title":"[Graph Blanking](3a) Split follow-up slice"'), 'managed lettered update patch should include lettered title');
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

function testRefactorLaneTitleWithTagAccepted() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    const branch = 'stack/test-refactor-tag-accept';
    createTrackedBranch(work, branch);
    writeFileSync(join(work, 'pr-body-refactor.md'), REFACTOR_BODY);
    commitFile(work, 'stack.txt', 'stack\n', 'stack update\n\nChange-Id: Irefactortag001');
    gitQuiet(work, 'push', '-u', 'origin', branch);
    setManagedBranchConfig(work, branch);

    const result = runCreatePr(work, harness, [
      '--title',
      '[Test Stack](2)[REFACTOR: Move Method] move the helper',
      '--base',
      'master',
      '--body-file',
      'pr-body-refactor.md',
      '--update-existing',
    ], {
      GH_API_PULLS_JSON: JSON.stringify([
        {
          number: 51,
          html_url: 'https://example.com/pull/51',
          head: { ref: branch, repo: { full_name: 'owner/repo' } },
        },
      ]),
      GH_PATCH_RESPONSE: JSON.stringify({ html_url: 'https://example.com/pull/51' }),
    });

    assert(
      result.status === 0,
      `refactor lane with a [REFACTOR: ...] tag should be accepted\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert(
      result.stdout.trim() === 'https://example.com/pull/51',
      `refactor-tagged update should print the PR URL\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testRefactorLaneTitleWithoutTagRejected() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    const branch = 'stack/test-refactor-tag-missing';
    createTrackedBranch(work, branch);
    writeFileSync(join(work, 'pr-body-refactor.md'), REFACTOR_BODY);
    commitFile(work, 'stack.txt', 'stack\n', 'stack update\n\nChange-Id: Irefactortag002');
    gitQuiet(work, 'push', '-u', 'origin', branch);
    setManagedBranchConfig(work, branch);

    const result = runCreatePr(work, harness, [
      '--title',
      '[Test Stack](2) move the helper',
      '--base',
      'master',
      '--body-file',
      'pr-body-refactor.md',
      '--update-existing',
    ]);

    assert(result.status === 1, `refactor lane without a [REFACTOR: ...] tag should be rejected\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(result.stderr.includes('REFACTOR'), `missing refactor tag error should mention REFACTOR\nstderr:\n${result.stderr}`);
    assert(result.stderr.includes('technique'), `missing refactor tag error should mention the technique catalog\nstderr:\n${result.stderr}`);
    expectNoPush(harness, 'refactor lane missing tag rejection');
    assert(readGhCalls(harness.ghLog).length === 0, 'refactor lane missing tag rejection should fail before GitHub calls');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testNonRefactorLaneTitleWithTagRejected() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    const branch = 'stack/test-refactor-tag-wrong-lane';
    createTrackedBranch(work, branch);
    commitFile(work, 'stack.txt', 'stack\n', 'stack update\n\nChange-Id: Irefactortag003');
    gitQuiet(work, 'push', '-u', 'origin', branch);
    setManagedBranchConfig(work, branch);

    const result = runCreatePr(work, harness, [
      '--title',
      '[Test Stack](2)[REFACTOR: Move Method] move the helper',
      '--base',
      'master',
      '--body-file',
      'pr-body.md',
      '--update-existing',
    ]);

    assert(result.status === 1, `non-refactor lane with a [REFACTOR: ...] tag should be rejected\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(result.stderr.includes('not refactor'), `wrong-lane refactor tag error should say the lane is not refactor\nstderr:\n${result.stderr}`);
    assert(result.stderr.includes('drop the tag'), `wrong-lane refactor tag error should suggest dropping the tag\nstderr:\n${result.stderr}`);
    expectNoPush(harness, 'non-refactor lane tag rejection');
    assert(readGhCalls(harness.ghLog).length === 0, 'non-refactor lane tag rejection should fail before GitHub calls');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testNonRefactorLanePlainTitleStillAccepted() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    const branch = 'stack/test-refactor-tag-plain';
    createTrackedBranch(work, branch);
    commitFile(work, 'stack.txt', 'stack\n', 'stack update\n\nChange-Id: Irefactortag004');
    gitQuiet(work, 'push', '-u', 'origin', branch);
    setManagedBranchConfig(work, branch);

    const result = runCreatePr(work, harness, [
      '--title',
      '[Test Stack](2) move the helper',
      '--base',
      'master',
      '--body-file',
      'pr-body.md',
      '--update-existing',
    ], {
      GH_API_PULLS_JSON: JSON.stringify([
        {
          number: 52,
          html_url: 'https://example.com/pull/52',
          head: { ref: branch, repo: { full_name: 'owner/repo' } },
        },
      ]),
      GH_PATCH_RESPONSE: JSON.stringify({ html_url: 'https://example.com/pull/52' }),
    });

    assert(
      result.status === 0,
      `non-refactor lane with a plain title should stay accepted\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert(
      result.stdout.trim() === 'https://example.com/pull/52',
      `plain-title update should print the PR URL\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
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

function testNestedMergifyPublishedBranchRecognizedBySha() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    const branch = 'stack/EdbertChan/owner-shutdown-signals/catch-sigterm-sigint-in-owner-serve';
    createTrackedBranch(work, branch);
    commitFile(work, 'stack.txt', 'stack\n', 'catch sigterm and sigint\n\nChange-Id: Ishutdown0001');
    setManagedBranchConfig(work, branch);

    const nestedRemoteBranch =
      'stack/EdbertChan/stack/EdbertChan/owner-shutdown-signals/catch-sigterm-sigint-in-owner-serve/catch-sigterm-sigint-owner-serve-process-instead--72172374';
    gitQuiet(work, 'push', 'origin', `HEAD:refs/heads/${nestedRemoteBranch}`);

    const result = runCreatePr(work, harness, [...stackTitleArgs(), '--update-existing'], {
      GH_API_PULLS_JSON: JSON.stringify([
        {
          number: 77,
          html_url: 'https://example.com/pull/77',
          head: { ref: branch, repo: { full_name: 'owner/repo' } },
        },
      ]),
      GH_PATCH_RESPONSE: JSON.stringify({ html_url: 'https://example.com/pull/77' }),
    });

    assert(
      result.status === 0,
      `nested mergify-published branch should be recognized by SHA match\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert(
      !result.stderr.includes('unpublished local commits'),
      `nested mergify-published branch should not report unpublished commits\nstderr:\n${result.stderr}`,
    );
    expectNoPush(harness, 'nested mergify-published branch update');

    commitFile(work, 'stack.txt', 'stack\nmore\n', 'truly unpublished follow-up\n\nChange-Id: Ishutdown0002');
    const secondResult = runCreatePr(work, harness, [...stackTitleArgs(), '--update-existing']);
    assert(secondResult.status === 1, 'a genuinely unpublished follow-up commit should still be rejected');
    assert(
      secondResult.stderr.includes('unpublished local commits'),
      `genuinely unpublished commit should still be reported\nstderr:\n${secondResult.stderr}`,
    );
    assert(
      secondResult.stderr.includes('Run `mergify stack push` first'),
      'genuinely unpublished commit should still require mergify stack push',
    );
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testDeletedMergifyPublishedBranchPrunesStaleTrackingRef() {
  const harness = createHarness();
  try {
    const { originBare, work } = createRepo(harness);
    const branch = 'stack/EdbertChan/deleted-stack-ref/local-branch';
    createTrackedBranch(work, branch);
    commitFile(work, 'stack.txt', 'stack\n', 'deleted stack ref\n\nChange-Id: Ideletedref0001');
    setManagedBranchConfig(work, branch);

    const deletedRemoteBranch =
      'stack/EdbertChan/stack/EdbertChan/deleted-stack-ref/local-branch/deleted-stack-ref--12345678';
    gitQuiet(work, 'push', 'origin', `HEAD:refs/heads/${deletedRemoteBranch}`);
    gitQuiet(
      work,
      'fetch',
      'origin',
      '+refs/heads/stack/EdbertChan/*:refs/remotes/origin/stack/EdbertChan/*',
    );
    gitQuiet(originBare, 'update-ref', '-d', `refs/heads/${deletedRemoteBranch}`);

    const staleTrackingRef = `refs/remotes/origin/${deletedRemoteBranch}`;
    assert(
      git(work, 'rev-parse', '--verify', staleTrackingRef).trim(),
      'test setup should leave a stale remote-tracking stack ref before create-pr runs',
    );

    const result = runCreatePr(work, harness, [...stackTitleArgs(), '--update-existing'], {
      GH_API_PULLS_JSON: JSON.stringify([
        {
          number: 78,
          html_url: 'https://example.com/pull/78',
          head: { ref: branch, repo: { full_name: 'owner/repo' } },
        },
      ]),
      GH_PATCH_RESPONSE: JSON.stringify({ html_url: 'https://example.com/pull/78' }),
    });

    assert(
      result.status === 1,
      `deleted remote stack branch should not be accepted through a stale remote-tracking ref\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert(
      result.stderr.includes(`Current branch "${branch}" has unpublished local commits ahead of origin/master.`)
        || result.stderr.includes(`Current branch "${branch}" has no published remote branch.`),
      `deleted remote stack branch should be rejected as unpublished\nstderr:\n${result.stderr}`,
    );
    assert(
      result.stderr.includes('Run `mergify stack push` first'),
      `deleted remote stack branch should require republishing\nstderr:\n${result.stderr}`,
    );
    assert(
      !gitTextRefExists(work, staleTrackingRef),
      'create-pr should prune the stale remote-tracking stack ref before matching',
    );
    expectNoPush(harness, 'deleted stack ref update');
    assert(readGhCalls(harness.ghLog).length === 0, 'deleted stack ref should fail before GitHub calls');
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

{
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    createTrackedBranch(work, 'stack/example/3-routing');
    setManagedBranchConfig(work, 'stack/example/3-routing');
    writeFileSync(join(work, 'pr-body-routing.md'), ROUTING_BODY);
    commitFile(work, 'packages/app/src/worker-control.ts', 'export const routing = true;\n', 'routing app helper');
    commitFile(work, 'packages/app/src/main.ts', 'export const mainRouting = true;\n', 'routing app main');
    commitFile(work, 'packages/app/src/workflow-mutation-facade.ts', 'export const facade = true;\n', 'activation surface');
    gitQuiet(work, 'push', '-u', 'origin', 'stack/example/3-routing');

    const result = runCreatePr(work, harness, [
      '--title', '[Example](3) Routing slice',
      '--base', 'master',
      '--body-file', 'pr-body-routing.md',
      '--update-existing',
    ], {
      GH_API_PULLS_JSON: JSON.stringify([
        {
          number: 42,
          title: '[Example](3) Routing slice',
          headRefName: 'stack/example/3-routing',
          baseRefName: 'stack/example/2-previous',
        },
      ]),
    });

    assert(
      result.stderr.includes('Review Unit "routing" cannot ship with activation-surface files'),
      `stack update should explain mixed review units\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

{
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    createTrackedBranch(work, 'stack/example/4-entrypoints');
    setManagedBranchConfig(work, 'stack/example/4-entrypoints');
    writeFileSync(join(work, 'pr-body-entrypoints.md'), `## Summary

This branch only changes app entrypoint behavior.

## Review Claim

Keep entrypoint activation behavior local.

## Review Lane

- behavior

## Review Unit

- activation-surface

## Safety Invariant

Only entrypoint behavior changes.

## Slice Rationale

Keep entrypoint behavior separate from routing internals.

## Non-goals

- Do not add docs or proof changes in this slice.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] \`node scripts/test-create-pr-stack-workflow.mjs\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
`);
    commitFile(work, 'packages/app/src/headless.ts', 'export const app = true;\n', 'app entrypoint');
    commitFile(work, 'packages/cli/src/index.ts', 'export const cli = true;\n', 'cli entrypoint');
    commitFile(work, 'packages/slack-manager/src/invoker-launcher.ts', 'export const slack = true;\n', 'slack entrypoint');
    gitQuiet(work, 'push', '-u', 'origin', 'stack/example/4-entrypoints');

    const result = runCreatePr(work, harness, [
      '--title', '[Example](4) Entrypoint slice',
      '--base', 'master',
      '--body-file', 'pr-body-entrypoints.md',
      '--update-existing',
    ], {
      GH_API_PULLS_JSON: JSON.stringify([
        {
          number: 43,
          title: '[Example](4) Entrypoint slice',
          headRefName: 'stack/example/4-entrypoints',
          baseRefName: 'stack/example/3-previous',
        },
      ]),
    });

    assert(result.status === 1, 'managed stack update should reject unrelated top-level areas even when the PR body stays on one review unit');
    assert(result.stderr.includes('Stack PR atomicity validation failed'), `stack atomicity blockers should fail publication\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(result.stderr.includes('unrelated-areas'), 'stack atomicity blockers should name the unrelated-areas finding');
    expectNoPush(harness, 'stack unrelated-areas rejection');
    const ghCalls = readGhCalls(harness.ghLog);
    assert(
      !ghCalls.some((call) => /\/pulls(?:\/[0-9]+)?$/.test(call.route)),
      'stack unrelated-areas rejection should fail before any GitHub PR mutation',
    );
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testNonStackedUnrelatedAreasStayWarnings() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    createTrackedBranch(work, 'feature/unrelated-areas-warning');
    writeFileSync(join(work, 'pr-body-entrypoints.md'), `## Summary

This branch only changes app entrypoint behavior.

## Review Claim

Keep entrypoint activation behavior local.

## Review Lane

- behavior

## Review Unit

- activation-surface

## Safety Invariant

Only entrypoint behavior changes.

## Slice Rationale

Keep entrypoint behavior separate from routing internals.

## Non-goals

- Do not add docs or proof changes in this slice.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] \`node scripts/test-create-pr-stack-workflow.mjs\`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No

</details>
`);
    commitFile(work, 'packages/app/src/headless.ts', 'export const app = true;\n', 'app entrypoint');
    commitFile(work, 'packages/cli/src/index.ts', 'export const cli = true;\n', 'cli entrypoint');
    commitFile(work, 'packages/slack-manager/src/invoker-launcher.ts', 'export const slack = true;\n', 'slack entrypoint');

    const result = runCreatePr(work, harness, ['--title', 'test title', '--base', 'master', '--body-file', 'pr-body-entrypoints.md']);

    assert(result.status === 0, `non-stacked unrelated areas should stay warnings\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(result.stderr.includes('Diff atomicity warning'), 'non-stacked publication should still print the warning');
    const ghCalls = readGhCalls(harness.ghLog);
    assert(
      ghCalls.some((call) => call.route.endsWith('/pulls')),
      'non-stacked unrelated areas warning should still allow PR creation',
    );
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}



function testStackedDiffTitleRequiredForNonTrunkBase() {
  const harness = createHarness();
  try {
    const branch = 'stack/stacked-diff';
    const { work } = createRepo(harness);
    gitQuiet(work, 'branch', 'stack/previous', 'origin/master');
    gitQuiet(work, 'push', 'origin', 'stack/previous');
    createTrackedBranch(work, branch, 'origin/stack/previous');
    commitFile(work, 'stacked.txt', 'stacked\n', 'stacked diff');
    gitQuiet(work, 'push', '-u', 'origin', branch);

    const result = runCreatePr(work, harness, ['--title', 'plain title', '--base', 'stack/previous', '--body-file', 'pr-body.md', '--update-existing']);

    assert(result.status === 1, 'stacked diff PR should reject a plain title');
    assert(result.stderr.includes('Stack PR titles must start with a shared idea'), 'stacked diff title error should explain format');
    expectNoPush(harness, 'stacked diff title rejection');
    assert(readGhCalls(harness.ghLog).length === 0, 'stacked diff title rejection should fail before GitHub calls');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testStackedBaseRequiresStackHead() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    gitQuiet(work, 'branch', 'stack/previous', 'origin/master');
    gitQuiet(work, 'push', 'origin', 'stack/previous');
    createTrackedBranch(work, 'pr/stacked-diff', 'origin/stack/previous');
    commitFile(work, 'stacked.txt', 'stacked\n', 'stacked diff');

    const result = runCreatePr(work, harness, stackTitleArgs('stack/previous'));

    assert(result.status === 1, `stacked base should require a stack head branch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(
      result.stderr.includes('Refusing to create/update PR: stacked publication requires a stack/ head branch.'),
      `stacked head guard should explain the stack branch requirement\nstderr:\n${result.stderr}`,
    );
    assert(result.stderr.includes('Current branch: pr/stacked-diff'), 'stacked head guard should name the current branch');
    assert(result.stderr.includes('Requested base: stack/previous'), 'stacked head guard should name the requested base');
    expectNoPush(harness, 'stacked base requires stack head');
    const ghCalls = readGhCalls(harness.ghLog);
    assert(
      !ghCalls.some((call) => /\/pulls(?:\/[0-9]+)?$/.test(call.route)),
      `stacked head guard should fail before PR mutation\n${JSON.stringify(ghCalls, null, 2)}`,
    );
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}


function testMergifyStackRejectsPlanBase() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    gitQuiet(work, 'branch', 'plan/upstream', 'origin/master');
    gitQuiet(work, 'push', 'origin', 'plan/upstream');
    createTrackedBranch(work, 'stack/plan-base', 'origin/plan/upstream');
    commitFile(work, 'stacked.txt', 'stacked\n', 'stacked diff');

    const result = runCreatePr(work, harness, [...stackTitleArgs('plan/upstream'), '--dry-run']);

    assert(result.status === 1, `Mergify stack PR should reject plan/ base\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(result.stderr.includes('Refusing to create or update a Mergify stack PR with a plan/ base branch.'), 'plan-base guard should explain the refusal');
    assert(result.stderr.includes('Requested base: plan/upstream'), 'plan-base guard should name the requested base');
    expectNoPush(harness, 'Mergify stack plan-base rejection');
    expectNoGhCalls(harness, 'Mergify stack plan-base rejection');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testNonMergifyPrAllowsPlanBase() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    gitQuiet(work, 'branch', 'plan/upstream', 'origin/master');
    gitQuiet(work, 'push', 'origin', 'plan/upstream');
    createTrackedBranch(work, 'feature/plan-base', 'origin/plan/upstream');
    commitFile(work, 'feature.txt', 'feature\n', 'feature change');

    const result = runCreatePr(work, harness, [...stackTitleArgs('plan/upstream'), '--dry-run']);

    assert(result.status === 1, `non-Mergify plan/ base fixture should reach the existing stack-comment path\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(result.stderr.includes('[dry-run] Would create PR'), 'non-Mergify plan-base PR should reach creation');
    assert(!result.stderr.includes('Refusing to create or update a Mergify stack PR with a plan/ base branch.'), 'non-Mergify plan-base PR should bypass the Mergify-only guard');
    expectNoPush(harness, 'non-Mergify plan-base dry run');
    expectNoGhCalls(harness, 'non-Mergify plan-base dry run');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testDiffAtomicityBlocksMixedDiff() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    createTrackedBranch(work, 'feature/atomicity-lockfile');
    commitFile(work, 'pnpm-lock.yaml', 'lockfileVersion: 9\npackages: {}\n', 'orphaned lockfile churn');

    const result = runCreatePr(work, harness, baseArgs());

    assert(
      result.status === 1,
      `mixed diff should fail diff atomicity gate\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert(
      result.stderr.includes('Diff atomicity violation'),
      `create-pr should report the diff atomicity violation\nstderr:\n${result.stderr}`,
    );
    expectNoPush(harness, 'diff atomicity violation');
    const ghCalls = readGhCalls(harness.ghLog);
    assert(
      !ghCalls.some((call) => /\/pulls(?:\/[0-9]+)?$/.test(call.route)),
      'diff atomicity violation should fail before any GitHub PR mutation',
    );
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testCreatePrDryRunMatchesCiBodyValidation() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    createTrackedBranch(work, 'feature/ci-parity');
    commitFile(work, 'packages/app/src/refresh-route.ts', 'export const refreshRoute = true;\n', 'route refresh');
    writeFileSync(join(work, 'pr-body.md'), ROUTING_BODY);

    const validResult = runCreatePr(work, harness, [...baseArgs(), '--dry-run']);
    assert(
      validResult.status === 0,
      `CI-compliant PR body should pass create-pr dry run\nstdout:\n${validResult.stdout}\nstderr:\n${validResult.stderr}`,
    );
    assert(validResult.stderr.includes('[dry-run] Would create PR'), 'valid body should reach the PR-create dry-run path');
    expectNoPush(harness, 'CI-compliant create-pr dry run');
    expectNoGhCalls(harness, 'CI-compliant create-pr dry run');

    writeFileSync(join(work, 'pr-body.md'), ROUTING_BODY.replace('- behavior', '- refactor'));
    const rejectedResult = runCreatePr(work, harness, [...baseArgs(), '--dry-run']);
    assert(rejectedResult.status === 1, 'CI-rejected refactor body should block create-pr before dry-run publication');
    assert(
      rejectedResult.stderr.includes('Review lane refactor must state in ## Non-goals that behavior stays unchanged'),
      `create-pr should return the same refactor error as CI\nstderr:\n${rejectedResult.stderr}`,
    );
    expectNoPush(harness, 'CI-rejected create-pr dry run');
    expectNoGhCalls(harness, 'CI-rejected create-pr dry run');
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testDiffComputationFailureBlocksPrCreation() {
  const harness = createHarness();
  try {
    const { work } = createRepo(harness);
    createTrackedBranch(work, 'feature/diff-failure');
    commitFile(work, 'feature.txt', 'feature\n', 'feature change');

    const result = runCreatePr(work, harness, baseArgs(), { TEST_GIT_DIFF_FAIL: 'simulated diff failure' });

    assert(result.status === 1, `diff failure should block PR creation\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert(
      result.stderr.includes('Unable to compute diff atomicity context against origin/master'),
      `diff failure should explain atomicity context failure\nstderr:\n${result.stderr}`,
    );
    assert(result.stderr.includes('simulated diff failure'), `diff failure should include git stderr\nstderr:\n${result.stderr}`);
    expectNoPush(harness, 'diff computation failure');
    assert(readGhCalls(harness.ghLog).length === 0, 'diff computation failure should fail before GitHub calls');
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
  testStaleMergedHelperBaseRejectsPublication,
  testDuplicateHelperBasePrsRejectPublication,
  testNoFileChangesBlockPrCreation,
  testEmptyCommitAloneBlocksPrCreation,
  testEmptyCommitMixedWithRealChangeBlocksPrCreation,
  testMergifyManagedCreateRefusal,
  testMergifyManagedUpdateSkipsPush,
  testMergifyManagedUpdateAcceptsLetteredTitle,
  testMergifyManagedUpdateRejectsPlainTitle,
  testMergifyManagedUpdateRejectsNestedTitle,
  testRefactorLaneTitleWithTagAccepted,
  testRefactorLaneTitleWithoutTagRejected,
  testNonRefactorLaneTitleWithTagRejected,
  testNonRefactorLanePlainTitleStillAccepted,
  testUnpublishedStackCommitsBlockUpdate,
  testNestedMergifyPublishedBranchRecognizedBySha,
  testDeletedMergifyPublishedBranchPrunesStaleTrackingRef,
  testCurrentBranchPrLookupFailure,
  testNonStackedUnrelatedAreasStayWarnings,
  testStackedDiffTitleRequiredForNonTrunkBase,
  testStackedBaseRequiresStackHead,
  testMergifyStackRejectsPlanBase,
  testNonMergifyPrAllowsPlanBase,
  testDiffAtomicityBlocksMixedDiff,
  testCreatePrDryRunMatchesCiBodyValidation,
  testDiffComputationFailureBlocksPrCreation,
  testHelpMentionsStackUpdateFlow,
];

for (const test of tests) {
  test();
}

console.log('OK: create-pr stack workflow checks passed');
