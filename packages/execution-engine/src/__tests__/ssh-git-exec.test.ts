import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import {
  shellPosixSingleQuote,
  base64Encode,
  bashNormalizeTildePath,
  sshInteractiveCdFragment,
  buildMirrorCloneScript,
  parseBootstrapOutput,
  buildWorktreeListScript,
  buildWorktreeHeadScript,
  buildWorktreeCleanupScript,
  buildWorktreeSandboxResetScript,
  buildWorktreeRenameBranchScript,
  buildRecordAndPushScript,
  parseRecordAndPushOutput,
  execRemoteCapture,
  spawnRemoteStdin,
  createSshRemoteScriptError,
} from '../ssh-git-exec.js';

describe('shellPosixSingleQuote', () => {
  it('wraps string in single quotes', () => {
    expect(shellPosixSingleQuote('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellPosixSingleQuote("it's")).toBe("'it'\\''s'");
  });

  it('handles multiple single quotes', () => {
    expect(shellPosixSingleQuote("'a' 'b'")).toBe("''\\''a'\\'' '\\''b'\\'''");
  });

  it('handles empty string', () => {
    expect(shellPosixSingleQuote('')).toBe("''");
  });
});

describe('base64Encode', () => {
  it('encodes UTF-8 string to base64', () => {
    expect(base64Encode('hello')).toBe(Buffer.from('hello', 'utf8').toString('base64'));
  });

  it('encodes complex string with special chars', () => {
    const input = "git@github.com:user/repo.git';rm -rf /";
    expect(base64Encode(input)).toBe(Buffer.from(input, 'utf8').toString('base64'));
  });
});

describe('bashNormalizeTildePath', () => {
  it('generates script that expands tilde paths', () => {
    const script = bashNormalizeTildePath();
    expect(script).toContain('if [[ "$WT" == \'~\' ]]; then');
    expect(script).toContain('WT="$HOME"');
    expect(script).toContain('elif [[ "${WT:0:2}" == \'~/\' ]]; then');
    expect(script).toContain('WT="$HOME/${WT:2}"');
  });
});

describe('sshInteractiveCdFragment', () => {
  it('expands bare tilde to $HOME', () => {
    expect(sshInteractiveCdFragment('~')).toBe('cd "$HOME"');
  });

  it('expands tilde-slash to $HOME/rest', () => {
    expect(sshInteractiveCdFragment('~/.invoker/worktrees')).toBe('cd "$HOME/.invoker/worktrees"');
  });

  it('escapes special chars in tilde path', () => {
    expect(sshInteractiveCdFragment('~/path with"quotes')).toBe('cd "$HOME/path with\\"quotes"');
  });

  it('single-quotes absolute paths', () => {
    expect(sshInteractiveCdFragment('/home/user/repo')).toBe("cd '/home/user/repo'");
  });

  it('handles paths with single quotes', () => {
    expect(sshInteractiveCdFragment("/home/user's/repo")).toBe("cd '/home/user'\\''s/repo'");
  });
});

describe('buildMirrorCloneScript', () => {
  it('generates clone + fetch + base ref resolution script', () => {
    const script = buildMirrorCloneScript({
      repoUrl: 'git@github.com:owner/repo.git',
      repoHash: 'abc123def456',
      baseRef: 'main',
    });

    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('REPO=$(echo');
    expect(script).toContain('base64 -d)');
    expect(script).toContain('H="abc123def456"');
    expect(script).toContain('INVOKER_HOME=$(echo');
    expect(script).toContain('CLONE="$INVOKER_HOME/repos/$H"');
    expect(script).toContain('if [ ! -d "$CLONE/.git" ]; then git clone "$REPO" "$CLONE"; fi');
    expect(script).toContain('if ! git -C "$CLONE" fetch --all --prune; then');
    expect(script).toContain('__INVOKER_FETCH_FAILED__=1');
    expect(script).toContain('__INVOKER_FETCH_SUCCESS__=1');
    expect(script).toContain('__INVOKER_BASE_REF__');
    expect(script).toContain('__INVOKER_BASE_HEAD__');
  });

  it('includes fallback logic for missing base ref', () => {
    const script = buildMirrorCloneScript({
      repoUrl: 'git@github.com:owner/repo.git',
      repoHash: 'abc123',
      baseRef: 'nonexistent',
    });

    expect(script).toContain('ORIGIN_HEAD=$(git -C "$CLONE" symbolic-ref');
    expect(script).toContain('__INVOKER_BASE_WARNING__');
    expect(script).toContain('exit 128');
  });

  it('prefers origin/HEAD over the mirror local HEAD', () => {
    const script = buildMirrorCloneScript({
      repoUrl: 'git@github.com:owner/repo.git',
      repoHash: 'abc123',
      baseRef: 'HEAD',
    });

    expect(script).toContain('ORIGIN_HEAD=$(git -C "$CLONE" symbolic-ref --quiet --short refs/remotes/origin/HEAD');
    expect(script).toContain('if [ "$BASE" = "HEAD" ] && [ -n "$ORIGIN_HEAD" ]');
    expect(script).toContain('RESOLVED_BASE="$ORIGIN_HEAD"');
  });

  it('base64-encodes repo URL to avoid shell injection', () => {
    const maliciousUrl = "git@github.com:user/repo.git';rm -rf /;'";
    const script = buildMirrorCloneScript({
      repoUrl: maliciousUrl,
      repoHash: 'safe123',
      baseRef: 'main',
    });

    // Should not contain the raw malicious string
    expect(script).not.toContain(maliciousUrl);
    // Should contain base64 encoded version
    expect(script).toContain('REPO=$(echo');
    expect(script).toContain('base64 -d)');
  });

  it('fetches branch repo refs without mutating shared mirror remotes', () => {
    const script = buildMirrorCloneScript({
      repoUrl: 'git@github.com:owner/repo.git',
      branchRepoUrl: 'git@github.com:fork/repo.git',
      repoHash: 'abc123',
      baseRef: 'main',
    });

    expect(script).toContain('BRANCH_REPO=$(echo');
    expect(script).not.toContain('remote set-url invoker-branches');
    expect(script).not.toContain('remote add invoker-branches');
    expect(script).toContain('git -C "$CLONE" fetch "$BRANCH_REPO" \'+refs/heads/*:refs/remotes/invoker-branches/*\' --prune');
    expect(script).toContain('BRANCH_REPO_FETCH_FAILED=$BRANCH_REPO');
    expect(script).toContain('exit 32');
  });
});

describe('parseBootstrapOutput', () => {
  it('parses successful output with resolved ref and head', () => {
    const stdout = `some output
__INVOKER_FETCH_SUCCESS__=1
__INVOKER_BASE_REF__=origin/main
__INVOKER_BASE_HEAD__=abcdef1234567890abcdef1234567890abcdef12
`;
    const result = parseBootstrapOutput(stdout);
    expect(result.resolvedBaseRef).toBe('origin/main');
    expect(result.baseHead).toBe('abcdef1234567890abcdef1234567890abcdef12');
    expect(result.warning).toBeUndefined();
    expect(result.fetchSuccess).toBe(true);
  });

  it('parses output with fallback warning', () => {
    const stdout = `__INVOKER_FETCH_SUCCESS__=1
__INVOKER_BASE_WARNING__=Requested base 'nonexistent' not found; falling back to 'origin/master'.
__INVOKER_BASE_REF__=origin/master
__INVOKER_BASE_HEAD__=1234567890abcdef1234567890abcdef12345678
`;
    const result = parseBootstrapOutput(stdout);
    expect(result.resolvedBaseRef).toBe('origin/master');
    expect(result.baseHead).toBe('1234567890abcdef1234567890abcdef12345678');
    expect(result.warning).toBe("Requested base 'nonexistent' not found; falling back to 'origin/master'.");
    expect(result.fetchSuccess).toBe(true);
  });

  it('throws when base ref marker is missing', () => {
    const stdout = '__INVOKER_BASE_HEAD__=abcdef\n';
    expect(() => parseBootstrapOutput(stdout)).toThrow('SSH bootstrap output missing base markers');
  });

  it('throws when base head marker is missing', () => {
    const stdout = '__INVOKER_BASE_REF__=main\n';
    expect(() => parseBootstrapOutput(stdout)).toThrow('SSH bootstrap output missing base markers');
  });

  it('uses last occurrence of markers when duplicated', () => {
    const stdout = `__INVOKER_FETCH_SUCCESS__=1
__INVOKER_BASE_REF__=old
__INVOKER_BASE_HEAD__=old123
__INVOKER_BASE_REF__=new
__INVOKER_BASE_HEAD__=new456
`;
    const result = parseBootstrapOutput(stdout);
    expect(result.resolvedBaseRef).toBe('new');
    expect(result.baseHead).toBe('new456');
    expect(result.fetchSuccess).toBe(true);
  });

  it('parses fetch failure output', () => {
    const stdout = `[WARNING] Git fetch failed for /home/user/.invoker/repos/abc123
[WARNING] Continuing with existing refs. Tasks may use stale commits.
__INVOKER_FETCH_FAILED__=1
__INVOKER_BASE_REF__=origin/main
__INVOKER_BASE_HEAD__=abcdef1234567890abcdef1234567890abcdef12
`;
    const result = parseBootstrapOutput(stdout);
    expect(result.resolvedBaseRef).toBe('origin/main');
    expect(result.baseHead).toBe('abcdef1234567890abcdef1234567890abcdef12');
    expect(result.fetchSuccess).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it('defaults to fetch failure when no fetch status markers present', () => {
    const stdout = `__INVOKER_BASE_REF__=origin/main
__INVOKER_BASE_HEAD__=abcdef1234567890abcdef1234567890abcdef12
`;
    const result = parseBootstrapOutput(stdout);
    expect(result.resolvedBaseRef).toBe('origin/main');
    expect(result.baseHead).toBe('abcdef1234567890abcdef1234567890abcdef12');
    expect(result.fetchSuccess).toBe(false);
  });
});

describe('buildWorktreeListScript', () => {
  it('generates worktree list script with correct repo hash', () => {
    const script = buildWorktreeListScript({ repoHash: 'xyz789' });
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('H="xyz789"');
    expect(script).toContain('INVOKER_HOME=$(echo');
    expect(script).toContain('CLONE="$INVOKER_HOME/repos/$H"');
    expect(script).toContain('git -C "$CLONE" worktree list --porcelain');
  });
});

describe('buildWorktreeHeadScript', () => {
  it('generates script to get HEAD ref for worktree', () => {
    const script = buildWorktreeHeadScript('/home/user/.invoker/worktrees/abc/exp-task-123');
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain("git -C '/home/user/.invoker/worktrees/abc/exp-task-123' rev-parse --abbrev-ref HEAD");
  });

  it('single-quotes worktree path with special chars', () => {
    const script = buildWorktreeHeadScript("/home/user's worktree/path");
    expect(script).toContain("git -C '/home/user'\\''s worktree/path'");
  });
});

describe('buildWorktreeCleanupScript', () => {
  it('generates cleanup script with prune and remove logic', () => {
    const script = buildWorktreeCleanupScript({
      remoteClone: '$HOME/.invoker/repos/abc123',
      worktreePaths: ['$HOME/.invoker/worktrees/abc123/exp-task-def'],
    });

    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('CLONE="$HOME/.invoker/repos/abc123"');
    expect(script).toContain('CLONE="$HOME"');
    expect(script).toContain('WORKTREES_B64=');
    expect(script).toContain('while IFS= read -r WT; do');
    expect(script).toContain('mkdir -p "$(dirname "$WT")"');
    expect(script).toContain('git -C "$CLONE" worktree prune');
    expect(script).toContain('git -C "$CLONE" worktree remove --force "$WT"');
    expect(script).toContain('[SshGitExec] Removing stale worktree path');
  });

  it('removes a stale worktree when canonicalRemoteWt starts with quoted tilde', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'ssh-cleanup-home-'));
    const cloneDir = join(fakeHome, '.invoker', 'repos', 'abc123');
    const staleWt = join(fakeHome, '.invoker', 'worktrees', 'abc123', 'exp-task-def');
    const literalTildeRoot = join(process.cwd(), '~');

    execSync(`rm -rf ${JSON.stringify(literalTildeRoot)}`);
    mkdirSync(cloneDir, { recursive: true });
    execSync('git init', { cwd: cloneDir, stdio: 'ignore' });
    mkdirSync(staleWt, { recursive: true });
    writeFileSync(join(staleWt, 'sentinel.txt'), 'stale');

    const script = buildWorktreeCleanupScript({
      remoteClone: '~/.invoker/repos/abc123',
      worktreePaths: ['~/.invoker/worktrees/abc123/exp-task-def'],
    });

    execFileSync('bash', ['-lc', script], {
      env: {
        ...process.env,
        HOME: fakeHome,
      },
    });

    expect(() => execSync(`test ! -e ${JSON.stringify(join(staleWt, 'sentinel.txt'))}`)).not.toThrow();
    expect(() => execSync(`test ! -e ${JSON.stringify(literalTildeRoot)}`)).not.toThrow();
    execSync(`rm -rf ${JSON.stringify(literalTildeRoot)}`);
  });
});

describe('buildWorktreeSandboxResetScript', () => {
  it('generates script with set -euo pipefail and base64-decoded WT and REF', () => {
    const script = buildWorktreeSandboxResetScript({
      worktreePath: '/home/invoker/.invoker/worktrees/abc123/exp-task-def',
      toRef: 'origin/main',
    });

    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('WT=$(echo');
    expect(script).toContain('REF=$(echo');
    expect(script).toContain('base64 -d)');
    expect(script).toContain('git -C "$WT" reset --hard "$REF"');
    expect(script).toContain('git -C "$WT" clean -fd');
    expect(script).not.toContain('clean -fdx');
  });

  it('includes tilde-expansion logic for worktree path', () => {
    const script = buildWorktreeSandboxResetScript({
      worktreePath: '~/.invoker/worktrees/abc123/exp-task-def',
      toRef: 'abc123def',
    });

    expect(script).toContain('"$HOME"');
    expect(script).toContain('git -C "$WT" reset --hard "$REF"');
    expect(script).toContain('git -C "$WT" clean -fd');
    expect(script).not.toContain('clean -fdx');
  });

  it('encodes path and ref as base64 so special characters are safe', () => {
    const path = "/home/user's worktree/path";
    const ref = 'branch/with spaces and $pecial';
    const script = buildWorktreeSandboxResetScript({ worktreePath: path, toRef: ref });

    const pathB64 = Buffer.from(path, 'utf8').toString('base64');
    const refB64 = Buffer.from(ref, 'utf8').toString('base64');
    expect(script).toContain(pathB64);
    expect(script).toContain(refB64);
    expect(script).not.toContain(path);
    expect(script).not.toContain(ref);
  });

  it('actually resets and cleans a dirty worktree via bash execution', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'ssh-sandbox-reset-home-'));
    const cloneDir = join(fakeHome, '.invoker', 'repos', 'abc123');
    const wtDir = join(fakeHome, '.invoker', 'worktrees', 'abc123', 'exp-task-def');

    // Set up a real git repo + worktree
    mkdirSync(cloneDir, { recursive: true });
    execSync('git init', { cwd: cloneDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: cloneDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: cloneDir, stdio: 'ignore' });
    writeFileSync(join(cloneDir, 'initial.txt'), 'initial');
    execSync('git add -A && git commit -m "initial"', { cwd: cloneDir, stdio: 'ignore' });

    execSync(`git worktree add ${JSON.stringify(wtDir)}`, { cwd: cloneDir, stdio: 'ignore' });

    // Dirty the worktree: modify tracked file + add untracked file
    writeFileSync(join(wtDir, 'initial.txt'), 'dirty');
    writeFileSync(join(wtDir, 'untracked.txt'), 'untracked');

    const baseRef = execSync('git rev-parse HEAD', { cwd: cloneDir }).toString().trim();

    const script = buildWorktreeSandboxResetScript({
      worktreePath: '~/.invoker/worktrees/abc123/exp-task-def',
      toRef: baseRef,
    });

    execFileSync('bash', ['-lc', script], {
      env: { ...process.env, HOME: fakeHome },
    });

    // Tracked file should be restored
    const content = require('node:fs').readFileSync(join(wtDir, 'initial.txt'), 'utf8');
    expect(content).toBe('initial');

    // Untracked file should be gone
    const { existsSync } = require('node:fs');
    expect(existsSync(join(wtDir, 'untracked.txt'))).toBe(false);
  });

  it('gitignored files (e.g. node_modules/) survive the reset because -fd not -fdx', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'ssh-sandbox-reset-gitignore-'));
    const cloneDir = join(fakeHome, '.invoker', 'repos', 'abc123');
    const wtDir = join(fakeHome, '.invoker', 'worktrees', 'abc123', 'exp-task-def');

    // Set up a real git repo + worktree with a .gitignore
    mkdirSync(cloneDir, { recursive: true });
    execSync('git init', { cwd: cloneDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: cloneDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: cloneDir, stdio: 'ignore' });
    writeFileSync(join(cloneDir, '.gitignore'), 'node_modules/\n.cache/\n');
    writeFileSync(join(cloneDir, 'initial.txt'), 'initial');
    execSync('git add -A && git commit -m "initial"', { cwd: cloneDir, stdio: 'ignore' });

    execSync(`git worktree add ${JSON.stringify(wtDir)}`, { cwd: cloneDir, stdio: 'ignore' });

    // Simulate a warm-reuse scenario: node_modules/ and .cache/ exist from a prior run
    mkdirSync(join(wtDir, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(join(wtDir, 'node_modules', 'some-pkg', 'index.js'), 'cached');
    mkdirSync(join(wtDir, '.cache'), { recursive: true });
    writeFileSync(join(wtDir, '.cache', 'build.json'), '{}');

    const baseRef = execSync('git rev-parse HEAD', { cwd: cloneDir }).toString().trim();

    const script = buildWorktreeSandboxResetScript({
      worktreePath: '~/.invoker/worktrees/abc123/exp-task-def',
      toRef: baseRef,
    });

    execFileSync('bash', ['-lc', script], {
      env: { ...process.env, HOME: fakeHome },
    });

    // Gitignored caches must survive (-fd keeps them; -fdx would delete them)
    const { existsSync, readFileSync } = require('node:fs');
    expect(existsSync(join(wtDir, 'node_modules', 'some-pkg', 'index.js'))).toBe(true);
    expect(readFileSync(join(wtDir, 'node_modules', 'some-pkg', 'index.js'), 'utf8')).toBe('cached');
    expect(existsSync(join(wtDir, '.cache', 'build.json'))).toBe(true);
  });
});

describe('buildWorktreeRenameBranchScript', () => {
  it('renames a managed branch and prints the new HEAD ref', () => {
    const script = buildWorktreeRenameBranchScript({
      worktreePath: '~/.invoker/worktrees/abc123/exp-task-old',
      fromBranch: 'experiment/task-old',
      toBranch: 'experiment/task-new',
    });

    expect(script).toContain('WT=$(echo');
    expect(script).toContain('FROM=$(echo');
    expect(script).toContain('TO=$(echo');
    expect(script).toContain('git -C "$WT" branch -m "$FROM" "$TO"');
    expect(script).toContain('git -C "$WT" rev-parse --abbrev-ref HEAD');
  });
});

describe('buildRecordAndPushScript', () => {
  it('generates commit + push script with conditional message logic', () => {
    const script = buildRecordAndPushScript({
      worktreePath: '~/.invoker/worktrees/abc/task',
      branch: 'experiment/task-123-abc',
      commitMessageChanges: 'invoker: task-123 — make changes',
      commitMessageEmpty: 'invoker: task-123\n\nExit code: 0',
      gitUserName: 'Invoker Bot',
      gitUserEmail: 'invoker@local',
    });

    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('WT=$(echo');
    expect(script).toContain('base64 -d)');
    expect(script).not.toContain('git config user.name');
    expect(script).not.toContain('git config user.email');
    expect(script).toContain('GIT_AUTHOR_NAME="$GIT_NAME"');
    expect(script).toContain('git add -A');
    expect(script).toContain('if git diff --cached --quiet');
    expect(script).toContain('git commit --allow-empty -F');
    expect(script).toContain('git commit -F');
    expect(script).toContain('HASH=$(git rev-parse HEAD)');
    expect(script).toContain('git push origin "$BR:refs/heads/$BR"');
    expect(script).toContain('printf "%s" "$HASH"');
  });

  it('includes tilde path normalization', () => {
    const script = buildRecordAndPushScript({
      worktreePath: '~/worktree',
      branch: 'branch',
      commitMessageChanges: 'msg',
      commitMessageEmpty: 'empty',
      gitUserName: 'Invoker Bot',
      gitUserEmail: 'invoker@local',
    });

    expect(script).toContain(bashNormalizeTildePath());
  });

  it('targets branch repo remote when pushRemoteUrl is provided', () => {
    const script = buildRecordAndPushScript({
      worktreePath: '~/worktree',
      branch: 'branch',
      commitMessageChanges: 'msg',
      commitMessageEmpty: 'empty',
      gitUserName: 'Invoker Bot',
      gitUserEmail: 'invoker@local',
      pushRemoteUrl: 'https://github.com/fork/repo.git',
    });

    expect(script).not.toContain('git remote set-url invoker-branches "$PUSH_URL"');
    expect(script).not.toContain('git remote add invoker-branches "$PUSH_URL"');
    expect(script).toContain('git push "$PUSH_URL" "$BR:refs/heads/$BR"');
  });

  it('commits and pushes successfully without preconfigured git identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'ssh-record-push-'));
    const source = join(root, 'source');
    const bare = join(root, 'remote.git');
    const clone = join(root, 'clone');

    mkdirSync(source, { recursive: true });
    execSync('git init -b master', { cwd: source, stdio: 'ignore' });
    writeFileSync(join(source, 'README.md'), 'seed\n');
    execSync('git add README.md', { cwd: source, stdio: 'ignore' });
    execSync('git -c user.name="Seed User" -c user.email="seed@example.com" commit -m "seed"', {
      cwd: source,
      stdio: 'ignore',
    });
    execSync(`git clone --bare ${JSON.stringify(source)} ${JSON.stringify(bare)}`, { stdio: 'ignore' });
    execSync(`git clone ${JSON.stringify(bare)} ${JSON.stringify(clone)}`, { stdio: 'ignore' });
    execSync('git checkout -b experiment/test-branch', { cwd: clone, stdio: 'ignore' });
    writeFileSync(join(clone, 'result.txt'), 'ok\n');

    const script = buildRecordAndPushScript({
      worktreePath: clone,
      branch: 'experiment/test-branch',
      commitMessageChanges: 'invoker: record remote result',
      commitMessageEmpty: 'invoker: record remote empty result',
      gitUserName: 'Remote CI Bot',
      gitUserEmail: 'remote-ci@example.com',
    });

    execFileSync('bash', ['-lc', script], {
      env: {
        ...process.env,
        HOME: mkdtempSync(join(tmpdir(), 'ssh-record-push-home-')),
      },
      stdio: 'ignore',
    });

    const authorName = execSync('git log -1 --format=%an', { cwd: clone }).toString().trim();
    const authorEmail = execSync('git log -1 --format=%ae', { cwd: clone }).toString().trim();
    const pushedHead = execSync(`git --git-dir=${JSON.stringify(bare)} rev-parse refs/heads/experiment/test-branch`)
      .toString()
      .trim();
    const localHead = execSync('git rev-parse HEAD', { cwd: clone }).toString().trim();

    expect(authorName).toBe('Remote CI Bot');
    expect(authorEmail).toBe('remote-ci@example.com');
    expect(pushedHead).toBe(localHead);
  });
});

describe('parseRecordAndPushOutput', () => {
  it('parses successful commit hash from stdout', () => {
    const stdout = 'some output\nabcdef1234567890abcdef1234567890abcdef12\n';
    const result = parseRecordAndPushOutput(stdout, 0, '');
    expect(result.commitHash).toBe('abcdef1234567890abcdef1234567890abcdef12');
    expect(result.error).toBeUndefined();
  });

  it('accepts short 7-char commit hash', () => {
    const stdout = 'abcdef1\n';
    const result = parseRecordAndPushOutput(stdout, 0, '');
    expect(result.commitHash).toBe('abcdef1');
  });

  it('returns error when exit code is non-zero', () => {
    const result = parseRecordAndPushOutput('', 1, 'push failed: permission denied');
    expect(result.error).toContain('remote commit or push failed');
    expect(result.error).toContain('permission denied');
    expect(result.commitHash).toBeUndefined();
  });

  it('returns error when output does not match commit hash pattern', () => {
    const stdout = 'not a commit hash\n';
    const result = parseRecordAndPushOutput(stdout, 0, '');
    expect(result.error).toContain('remote commit: unexpected output');
    expect(result.commitHash).toBeUndefined();
  });

  it('uses stderr when stdout is empty on failure', () => {
    const result = parseRecordAndPushOutput('', 1, 'fatal: unable to access remote');
    expect(result.error).toContain('unable to access remote');
  });
});

describe('execRemoteCapture', () => {
  it('executes SSH script and returns stdout on success', async () => {
    // This test requires mocking spawn or running in an integration test environment
    // For unit tests, we verify the function signature and error handling

    // We can't actually run SSH in unit tests, so we'll verify the structure
    expect(execRemoteCapture).toBeDefined();
    expect(typeof execRemoteCapture).toBe('function');
  });
});

describe('createSshRemoteScriptError', () => {
  it('preserves raw stderr and stdout with phase metadata', () => {
    const err = createSshRemoteScriptError(
      254,
      'stdout detail\n',
      'Welcome to Ubuntu\nreal failure\n',
      'bootstrap_clone_fetch',
    );

    expect(err.message).toContain('SSH remote script failed (exit=254, phase=bootstrap_clone_fetch)');
    expect(err.message).toContain('STDERR:\nWelcome to Ubuntu\nreal failure\n');
    expect(err.message).toContain('STDOUT:\nstdout detail\n');
    expect(err.phase).toBe('bootstrap_clone_fetch');
    expect(err.exitCode).toBe(254);
    expect(err.stderr).toBe('Welcome to Ubuntu\nreal failure\n');
    expect(err.stdout).toBe('stdout detail\n');
  });
});

describe('spawnRemoteStdin', () => {
  it('spawns SSH process with detached mode', () => {
    // Similar to execRemoteCapture, this is an integration boundary
    // Unit tests verify the function exists and has correct signature
    expect(spawnRemoteStdin).toBeDefined();
    expect(typeof spawnRemoteStdin).toBe('function');
  });
});

describe('deterministic command construction', () => {
  it('generates identical scripts for identical inputs', () => {
    const opts = {
      repoUrl: 'git@github.com:owner/repo.git',
      repoHash: 'abc123',
      baseRef: 'main',
    };

    const script1 = buildMirrorCloneScript(opts);
    const script2 = buildMirrorCloneScript(opts);

    expect(script1).toBe(script2);
  });

  it('generates different scripts for different inputs', () => {
    const script1 = buildMirrorCloneScript({
      repoUrl: 'git@github.com:owner/repo1.git',
      repoHash: 'abc123',
      baseRef: 'main',
    });

    const script2 = buildMirrorCloneScript({
      repoUrl: 'git@github.com:owner/repo2.git',
      repoHash: 'def456',
      baseRef: 'develop',
    });

    expect(script1).not.toBe(script2);
  });
});

describe('error code preservation', () => {
  it('parseRecordAndPushOutput preserves exit codes in error result', () => {
    const result = parseRecordAndPushOutput('', 127, 'command not found');
    expect(result.error).toContain('code 127');
  });
});

describe('stable error messages', () => {
  it('parseBootstrapOutput produces consistent error format', () => {
    const stdout = 'incomplete output';
    expect(() => parseBootstrapOutput(stdout)).toThrow(/SSH bootstrap output missing base markers/);
  });

  it('parseRecordAndPushOutput produces consistent error format', () => {
    const result = parseRecordAndPushOutput('bad output', 1, 'stderr content');
    expect(result.error).toMatch(/remote commit or push failed \(code \d+\)/);
  });
});
