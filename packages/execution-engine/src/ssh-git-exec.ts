/**
 * SSH-based remote git command construction and execution.
 *
 * Isolates quoting, execution primitives, and error code shaping for git operations
 * performed over SSH. Enables hermetic unit testing without real SSH connections.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface SshRemoteErrorMetadata {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  phase?: string;
}

function formatRawRemoteOutput(stdout: string, stderr: string): string {
  const sections: string[] = [];
  if (stderr.length > 0) sections.push(`STDERR:\n${stderr}`);
  if (stdout.length > 0) sections.push(`STDOUT:\n${stdout}`);
  return sections.join('\n');
}

export function createSshRemoteScriptError(
  code: number | null | undefined,
  stdout: string,
  stderr: string,
  phase?: string,
): Error & SshRemoteErrorMetadata {
  const phaseLabel = phase ? `, phase=${phase}` : '';
  const exitCodeLabel = code ?? 'unknown';
  const rawOutput = formatRawRemoteOutput(stdout, stderr);
  const message = rawOutput.length > 0
    ? `SSH remote script failed (exit=${exitCodeLabel}${phaseLabel})\n${rawOutput}`
    : `SSH remote script failed (exit=${exitCodeLabel}${phaseLabel})`;
  const error = new Error(message) as Error & SshRemoteErrorMetadata;
  error.exitCode = code ?? undefined;
  error.stdout = stdout;
  error.stderr = stderr;
  error.phase = phase;
  return error;
}

/**
 * POSIX single-quote escaping for bash -c '…' command lines.
 * Handles embedded single quotes by ending the quoted string, escaping the quote, and resuming.
 */
export function shellPosixSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Base64-encode a string for safe transmission over SSH.
 * Used to avoid shell interpolation issues with complex strings.
 */
export function base64Encode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

/**
 * Bash fragment to expand leading ~ in a variable after base64 decode.
 * After `WT=$(echo … | base64 -d)`, this ensures `cd "$WT"` works with tilde paths.
 *
 * NOTE: Do NOT use `case ~/*)` — bash tilde-expands case patterns, so `~/*` becomes
 * `/root/*` and never matches literal `~/.invoker/…`.
 */
export function bashNormalizeTildePath(varName = 'WT'): string {
  return `if [[ "$${varName}" == '~' ]]; then
  ${varName}="$HOME"
elif [[ "\${${varName}:0:2}" == '~/' ]]; then
  ${varName}="$HOME/\${${varName}:2}"
fi`;
}

/**
 * Build bash -lc inner fragment for interactive SSH sessions.
 * Expands ~ to $HOME for paths that start with ~/ or are exactly ~.
 */
export function sshInteractiveCdFragment(workspacePath: string): string {
  if (workspacePath === '~') return 'cd "$HOME"';
  if (workspacePath.startsWith('~/')) {
    const rest = workspacePath.slice(2).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `cd "$HOME/${rest}"`;
  }
  return `cd ${shellPosixSingleQuote(workspacePath)}`;
}

export interface GitMirrorCloneOpts {
  /** Repository URL to clone */
  repoUrl: string;
  /** Repo URL hash (12 chars from computeRepoUrlHash) */
  repoHash: string;
  /** Base ref to resolve (e.g., "main", "origin/master", or "HEAD") */
  baseRef: string;
  /** Remote invoker home directory (e.g., ~/.invoker). Default: $HOME/.invoker */
  invokerHome?: string;
}

/**
 * Generate bash script for mirror clone + fetch + base ref resolution.
 *
 * On success, outputs to stdout:
 *   __INVOKER_FETCH_SUCCESS__=1 (or __INVOKER_FETCH_FAILED__=1)
 *   __INVOKER_BASE_REF__=<resolved-ref>
 *   __INVOKER_BASE_HEAD__=<sha>
 *
 * On base ref not found, attempts fallback to origin/HEAD and outputs:
 *   __INVOKER_BASE_WARNING__=Requested base '<ref>' not found; falling back to '<fallback>'.
 *   __INVOKER_BASE_REF__=<fallback>
 *   __INVOKER_BASE_HEAD__=<sha>
 *
 * On fetch failure, continues with existing refs and outputs:
 *   __INVOKER_FETCH_FAILED__=1
 *   [WARNING] messages to stderr
 *
 * Exits 128 if base ref and fallback both missing.
 */
export function buildMirrorCloneScript(opts: GitMirrorCloneOpts): string {
  const repoB64 = base64Encode(opts.repoUrl);
  const baseB64 = base64Encode(opts.baseRef);
  const { repoHash, invokerHome = '$HOME/.invoker' } = opts;
  const homeB64 = base64Encode(invokerHome);

  return `set -euo pipefail
REPO=$(echo ${repoB64} | base64 -d)
BASE=$(echo ${baseB64} | base64 -d)
H="${repoHash}"
INVOKER_HOME=$(echo ${homeB64} | base64 -d)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
CLONE="$INVOKER_HOME/repos/$H"
mkdir -p "$(dirname "$CLONE")"
if [ ! -d "$CLONE/.git" ]; then git clone "$REPO" "$CLONE"; fi
if ! git -C "$CLONE" fetch --all --prune; then
  echo "[WARNING] Git fetch failed for $CLONE" >&2
  echo "[WARNING] Continuing with existing refs. Tasks may use stale commits." >&2
  echo "__INVOKER_FETCH_FAILED__=1"
else
  echo "__INVOKER_FETCH_SUCCESS__=1"
fi
RESOLVED_BASE="$BASE"
ORIGIN_HEAD=$(git -C "$CLONE" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
if [ "$BASE" = "HEAD" ] && [ -n "$ORIGIN_HEAD" ] && git -C "$CLONE" rev-parse --verify "$ORIGIN_HEAD^{commit}" >/dev/null 2>&1; then
  RESOLVED_BASE="$ORIGIN_HEAD"
elif git -C "$CLONE" rev-parse --verify "origin/$BASE^{commit}" >/dev/null 2>&1; then
  RESOLVED_BASE="origin/$BASE"
elif git -C "$CLONE" rev-parse --verify "$RESOLVED_BASE^{commit}" >/dev/null 2>&1; then
  :
else
  if [ -n "$ORIGIN_HEAD" ] && git -C "$CLONE" rev-parse --verify "$ORIGIN_HEAD^{commit}" >/dev/null 2>&1; then
    RESOLVED_BASE="$ORIGIN_HEAD"
    printf "__INVOKER_BASE_WARNING__=Requested base '%s' not found; falling back to '%s'.\\n" "$BASE" "$RESOLVED_BASE"
  else
    echo "Requested base '$BASE' does not exist and origin/HEAD is unavailable." >&2
    exit 128
  fi
fi
BASE_HEAD=$(git -C "$CLONE" rev-parse "$RESOLVED_BASE")
printf "__INVOKER_BASE_REF__=%s\\n" "$RESOLVED_BASE"
printf "__INVOKER_BASE_HEAD__=%s\\n" "$BASE_HEAD"
`;
}

export interface BootstrapOutput {
  resolvedBaseRef: string;
  baseHead: string;
  warning?: string;
  fetchSuccess: boolean;
}

/**
 * Parse output from buildMirrorCloneScript.
 * Throws if required markers are missing.
 */
export function parseBootstrapOutput(stdout: string): BootstrapOutput {
  const lines = stdout.split('\n');
  const refLine = [...lines].reverse().find((line) => line.startsWith('__INVOKER_BASE_REF__='));
  const headLine = [...lines].reverse().find((line) => line.startsWith('__INVOKER_BASE_HEAD__='));
  const warningLine = [...lines].reverse().find((line) => line.startsWith('__INVOKER_BASE_WARNING__='));
  const fetchSuccessLine = [...lines].reverse().find((line) => line.startsWith('__INVOKER_FETCH_SUCCESS__='));
  const fetchFailedLine = [...lines].reverse().find((line) => line.startsWith('__INVOKER_FETCH_FAILED__='));

  const resolvedBaseRef = refLine?.slice('__INVOKER_BASE_REF__='.length).trim();
  const baseHead = headLine?.slice('__INVOKER_BASE_HEAD__='.length).trim();
  const warning = warningLine?.slice('__INVOKER_BASE_WARNING__='.length).trim();
  const fetchSuccess = !!fetchSuccessLine && !fetchFailedLine;

  if (!resolvedBaseRef || !baseHead) {
    throw new Error(`SSH bootstrap output missing base markers. Output: ${stdout.slice(0, 500)}`);
  }

  return { resolvedBaseRef, baseHead, warning: warning || undefined, fetchSuccess };
}

export interface GitWorktreeListOpts {
  /** Repo URL hash */
  repoHash: string;
  /** Remote invoker home directory (e.g., ~/.invoker). Default: $HOME/.invoker */
  invokerHome?: string;
}

/**
 * Generate script to list git worktrees in porcelain format.
 * Also returns $HOME for path normalization.
 */
export function buildWorktreeListScript(opts: GitWorktreeListOpts): string {
  const { repoHash, invokerHome = '$HOME/.invoker' } = opts;
  const homeB64 = base64Encode(invokerHome);

  return `set -euo pipefail
H="${repoHash}"
INVOKER_HOME=$(echo ${homeB64} | base64 -d)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
CLONE="$INVOKER_HOME/repos/$H"
git -C "$CLONE" worktree list --porcelain
`;
}

/**
 * Generate script to get current HEAD ref for a worktree.
 */
export function buildWorktreeHeadScript(worktreePath: string): string {
  const wtQ = shellPosixSingleQuote(worktreePath);
  return `set -euo pipefail
git -C ${wtQ} rev-parse --abbrev-ref HEAD
`;
}

export interface GitWorktreeCleanupOpts {
  remoteClone: string;
  canonicalRemoteWt: string;
}

/**
 * Generate script to prune stale worktrees and remove a specific worktree path.
 */
export function buildWorktreeCleanupScript(opts: GitWorktreeCleanupOpts): string {
  return `set -euo pipefail
CLONE="${opts.remoteClone}"
WT="${opts.canonicalRemoteWt}"
${bashNormalizeTildePath('CLONE')}
${bashNormalizeTildePath('WT')}
mkdir -p "$(dirname "$WT")"
git -C "$CLONE" worktree prune 2>/dev/null || true
if [ -e "$WT" ]; then
  echo "[SshGitExec] Removing stale worktree path: $WT"
  git -C "$CLONE" worktree remove --force "$WT" 2>/dev/null || true
  rm -rf "$WT"
  git -C "$CLONE" worktree prune 2>/dev/null || true
fi
`;
}

export interface GitRecordAndPushOpts {
  worktreePath: string;
  branch: string;
  commitMessageChanges: string;
  commitMessageEmpty: string;
}

/**
 * Generate script to commit task result and push branch.
 * Uses staged changes commit message if changes present, otherwise empty commit message.
 *
 * On success, outputs commit hash (40-char hex).
 * Non-zero exit if commit or push fails.
 */
export function buildRecordAndPushScript(opts: GitRecordAndPushOpts): string {
  const wtB = base64Encode(opts.worktreePath);
  const brB = base64Encode(opts.branch);
  const chB = base64Encode(opts.commitMessageChanges);
  const emB = base64Encode(opts.commitMessageEmpty);

  return `set -euo pipefail
WT=$(echo ${wtB} | base64 -d)
${bashNormalizeTildePath()}
cd "$WT"
git add -A
M=$(mktemp)
trap 'rm -f "$M"' EXIT
if git diff --cached --quiet; then
  echo ${emB} | base64 -d > "$M"
  git commit --allow-empty -F "$M"
else
  echo ${chB} | base64 -d > "$M"
  git commit -F "$M"
fi
HASH=$(git rev-parse HEAD)
BR=$(echo ${brB} | base64 -d)
git push -u origin "$BR"
printf "%s" "$HASH"
`;
}

export interface GitRecordAndPushResult {
  commitHash?: string;
  error?: string;
}

/**
 * Parse output from buildRecordAndPushScript execution.
 * Returns { commitHash } on success, { error } on failure.
 */
export function parseRecordAndPushOutput(
  stdout: string,
  exitCode: number,
  stderr: string,
): GitRecordAndPushResult {
  if (exitCode !== 0) {
    return { error: `remote commit or push failed (code ${exitCode}): ${stderr.trim() || stdout.trim()}` };
  }

  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const hash = lines[lines.length - 1] ?? '';

  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return { error: `remote commit: unexpected output (last line: ${hash.slice(0, 80)})` };
  }

  return { commitHash: hash };
}

/**
 * Execute a bash script over SSH and capture output.
 *
 * This is the core execution primitive. Tests can spy on or mock this function
 * to verify command construction without real SSH.
 */
export interface SshExecOpts {
  sshArgs: string[];
  script: string;
  phase?: string;
}

export async function execRemoteCapture(opts: SshExecOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...opts.sshArgs, 'bash', '-s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(opts.script);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(createSshRemoteScriptError(code, stdout, stderr, opts.phase));
      }
    });
  });
}

/**
 * Execute a bash script over SSH without capturing output (for long-running tasks).
 * Returns the child process for streaming output.
 */
export function spawnRemoteStdin(opts: SshExecOpts): ChildProcess {
  const child = spawn('ssh', [...opts.sshArgs, 'bash', '-s'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdin?.write(opts.script);
  child.stdin?.end();
  return child;
}
