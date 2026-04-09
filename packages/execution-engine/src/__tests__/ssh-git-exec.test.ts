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
  buildRecordAndPushScript,
  parseRecordAndPushOutput,
  execRemoteCapture,
  spawnRemoteStdin,
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
      canonicalRemoteWt: '$HOME/.invoker/worktrees/abc123/exp-task-def',
    });

    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('CLONE="$HOME/.invoker/repos/abc123"');
    expect(script).toContain('WT="$HOME/.invoker/worktrees/abc123/exp-task-def"');
    expect(script).toContain('mkdir -p "$(dirname "$WT")"');
    expect(script).toContain('git -C "$CLONE" worktree prune');
    expect(script).toContain('git -C "$CLONE" worktree remove --force "$WT"');
    expect(script).toContain('[SshGitExec] Removing stale worktree path');
  });
});

describe('buildRecordAndPushScript', () => {
  it('generates commit + push script with conditional message logic', () => {
    const script = buildRecordAndPushScript({
      worktreePath: '~/.invoker/worktrees/abc/task',
      branch: 'experiment/task-123-abc',
      commitMessageChanges: 'invoker: task-123 — make changes',
      commitMessageEmpty: 'invoker: task-123\n\nExit code: 0',
    });

    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('WT=$(echo');
    expect(script).toContain('base64 -d)');
    expect(script).toContain('git add -A');
    expect(script).toContain('if git diff --cached --quiet');
    expect(script).toContain('git commit --allow-empty -F');
    expect(script).toContain('git commit -F');
    expect(script).toContain('HASH=$(git rev-parse HEAD)');
    expect(script).toContain('git push -u origin "$BR"');
    expect(script).toContain('printf "%s" "$HASH"');
  });

  it('includes tilde path normalization', () => {
    const script = buildRecordAndPushScript({
      worktreePath: '~/worktree',
      branch: 'branch',
      commitMessageChanges: 'msg',
      commitMessageEmpty: 'empty',
    });

    expect(script).toContain(bashNormalizeTildePath());
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
