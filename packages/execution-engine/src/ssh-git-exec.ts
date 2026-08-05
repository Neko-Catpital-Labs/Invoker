/**
 * SSH-based remote git command construction and execution.
 *
 * Isolates quoting, execution primitives, and error code shaping for git operations
 * performed over SSH. Enables hermetic unit testing without real SSH connections.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { buildPortableBase64DecodeFunction } from './remote-shell-fragments.js';

export interface SshRemoteErrorMetadata {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  phase?: string;
}

export function parseOwnedWorktreePath(text: string): string | undefined {
  const match = text.match(/already used by worktree at ['"]([^'"]+)['"]/);
  return match?.[1];
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
 * After `WT=$(printf '%s' … | invoker_base64_decode)`, this ensures `cd "$WT"` works with tilde paths.
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
  /** Optional repository URL used to publish/read node branches. */
  branchRepoUrl?: string;
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
  const branchRepoB64 = base64Encode(opts.branchRepoUrl?.trim() ?? '');
  const baseB64 = base64Encode(opts.baseRef);
  const { repoHash, invokerHome = '$HOME/.invoker' } = opts;
  const homeB64 = base64Encode(invokerHome);

  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
REPO=$(printf '%s' ${shellPosixSingleQuote(repoB64)} | invoker_base64_decode)
BRANCH_REPO=$(printf '%s' ${shellPosixSingleQuote(branchRepoB64)} | invoker_base64_decode)
BASE=$(printf '%s' ${shellPosixSingleQuote(baseB64)} | invoker_base64_decode)
H="${repoHash}"
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(homeB64)} | invoker_base64_decode)
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
CLONE="$INVOKER_HOME/repos/$H"
mkdir -p "$(dirname "$CLONE")"
# The remote ssh session has its own HOME/git config, so a local file:// $REPO
# owned by another uid is rejected with "detected dubious ownership". Only the
# safe.directory "*" wildcard covers the check on $REPO/.git (the -c form and a
# specific path do not), so set it in the remote global config before cloning.
git config --global --add safe.directory '*' >/dev/null 2>&1 || true
if [ ! -d "$CLONE/.git" ]; then git clone "$REPO" "$CLONE"; fi
if ! git -C "$CLONE" fetch --all --prune; then
  echo "[WARNING] Git fetch failed for $CLONE" >&2
  echo "[WARNING] Continuing with existing refs. Tasks may use stale commits." >&2
  echo "__INVOKER_FETCH_FAILED__=1"
else
  echo "__INVOKER_FETCH_SUCCESS__=1"
fi
if [ -n "$BRANCH_REPO" ]; then
  if ! git -C "$CLONE" fetch "$BRANCH_REPO" '+refs/heads/*:refs/remotes/invoker-branches/*' --prune; then
    echo "BRANCH_REPO_FETCH_FAILED=$BRANCH_REPO" >&2
    exit 32
  fi
fi
RESOLVED_BASE="$BASE"
ORIGIN_HEAD=$(git -C "$CLONE" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
if [ "$BASE" = "HEAD" ] && [ -n "$ORIGIN_HEAD" ] && git -C "$CLONE" rev-parse --verify "$ORIGIN_HEAD^{commit}" >/dev/null 2>&1; then
  RESOLVED_BASE="$ORIGIN_HEAD"
elif git -C "$CLONE" rev-parse --verify "origin/$BASE^{commit}" >/dev/null 2>&1; then
  RESOLVED_BASE="origin/$BASE"
elif git -C "$CLONE" rev-parse --verify "$RESOLVED_BASE^{commit}" >/dev/null 2>&1; then
  RESOLVED_BASE="$BASE"
else
  FALLBACK="\${ORIGIN_HEAD:-origin/master}"
  if git -C "$CLONE" rev-parse --verify "$FALLBACK^{commit}" >/dev/null 2>&1; then
    RESOLVED_BASE="$FALLBACK"
    printf "__INVOKER_BASE_WARNING__=Requested base '%s' not found; falling back to '%s'.\\n" "$BASE" "$RESOLVED_BASE"
  else
    echo "ERROR: base ref '$BASE' not found and fallback '$FALLBACK' also missing" >&2
    exit 128
  fi
fi
printf "__INVOKER_BASE_REF__=%s\\n" "$RESOLVED_BASE"
printf "__INVOKER_BASE_HEAD__=%s\\n" "$(git -C "$CLONE" rev-parse "$RESOLVED_BASE^{commit}")"
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
${buildPortableBase64DecodeFunction()}
H="${repoHash}"
INVOKER_HOME=$(printf '%s' ${shellPosixSingleQuote(homeB64)} | invoker_base64_decode)
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
  worktreePaths: string[];
}

/**
 * Generate script to prune stale worktrees and remove specific worktree paths.
 */
export function buildWorktreeCleanupScript(opts: GitWorktreeCleanupOpts): string {
  const worktreesB64 = base64Encode(`${opts.worktreePaths.join('\n')}\n`);
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
CLONE="${opts.remoteClone}"
${bashNormalizeTildePath('CLONE')}
WORKTREES_B64="${worktreesB64}"
git -C "$CLONE" worktree prune 2>/dev/null || true
while IFS= read -r WT; do
  [ -z "$WT" ] && continue
  ${bashNormalizeTildePath('WT')}
  mkdir -p "$(dirname "$WT")"
  if [ -e "$WT" ]; then
    echo "[SshGitExec] Removing stale worktree path: $WT"
    git -C "$CLONE" worktree remove --force "$WT" 2>/dev/null || true
    rm -rf "$WT"
    git -C "$CLONE" worktree prune 2>/dev/null || true
  fi
done < <(printf '%s' "$WORKTREES_B64" | invoker_base64_decode)
`;
}

export interface GitWorktreeSandboxResetOpts {
  worktreePath: string;
  /** The commit/ref to hard-reset the branch to before execution (e.g. resolvedBaseRef / baseHead). */
  toRef: string;
}

/**
 * Sandbox-reset a reused managed worktree to a known-good state before task execution.
 *
 * Removes residual state from a prior (possibly SIGKILL-interrupted) run so that
 * the task always starts from the declared base ref.
 *
 *   1. git reset --hard <toRef>   — force branch tip back to declared base
 *   2. git clean -fd              — remove untracked/modified files, but keep gitignored
 *                                   files (e.g. node_modules/, build caches).
 *
 * Why -fd and not -fdx:
 *   Managed SSH may hydrate package caches such as node_modules/ before task
 *   execution. Keeping gitignored caches alive with -fd makes repeated
 *   task-level hydration faster without changing tracked files.
 */
export function buildWorktreeSandboxResetScript(opts: GitWorktreeSandboxResetOpts): string {
  const wtB64 = base64Encode(opts.worktreePath);
  const refB64 = base64Encode(opts.toRef);
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
WT=$(printf '%s' ${shellPosixSingleQuote(wtB64)} | invoker_base64_decode)
REF=$(printf '%s' ${shellPosixSingleQuote(refB64)} | invoker_base64_decode)
${bashNormalizeTildePath('WT')}
git -C "$WT" reset --hard "$REF"
git -C "$WT" clean -fd
`;
}

export interface GitWorktreeRenameBranchOpts {
  worktreePath: string;
  fromBranch: string;
  toBranch: string;
}

export function buildWorktreeRenameBranchScript(opts: GitWorktreeRenameBranchOpts): string {
  const wtB64 = base64Encode(opts.worktreePath);
  const fromB64 = base64Encode(opts.fromBranch);
  const toB64 = base64Encode(opts.toBranch);
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
WT=$(printf '%s' ${shellPosixSingleQuote(wtB64)} | invoker_base64_decode)
FROM=$(printf '%s' ${shellPosixSingleQuote(fromB64)} | invoker_base64_decode)
TO=$(printf '%s' ${shellPosixSingleQuote(toB64)} | invoker_base64_decode)
${bashNormalizeTildePath('WT')}
git -C "$WT" branch -m "$FROM" "$TO"
git -C "$WT" rev-parse --abbrev-ref HEAD
`;
}

export interface GitRecordAndPushOpts {
  worktreePath: string;
  branch: string;
  commitMessageChanges: string;
  commitMessageEmpty: string;
  gitUserName: string;
  gitUserEmail: string;
  pushRemoteUrl?: string;
  idempotencyKey?: string;
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
  const userNameB = base64Encode(opts.gitUserName);
  const userEmailB = base64Encode(opts.gitUserEmail);
  const pushRemoteUrlB = base64Encode(opts.pushRemoteUrl ?? '');
  const idempotencyKeyB = base64Encode(opts.idempotencyKey ?? '');

  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
WT=$(printf '%s' ${shellPosixSingleQuote(wtB)} | invoker_base64_decode)
${bashNormalizeTildePath()}
cd "$WT"
IDEMPOTENCY_KEY=$(printf '%s' ${shellPosixSingleQuote(idempotencyKeyB)} | invoker_base64_decode)
MARKER=''
IDEMPOTENCY_FOOTER=''
if [ -n "$IDEMPOTENCY_KEY" ]; then
  IDEMPOTENCY_FOOTER="Invoker-Finalize-Id: $IDEMPOTENCY_KEY"
  SAFE_IDEMPOTENCY_KEY=$(printf '%s' "$IDEMPOTENCY_KEY" | tr -c 'A-Za-z0-9_.-' '_')
  STATE_DIR=$(git rev-parse --git-path invoker-record-and-push)
  MARKER="$STATE_DIR/$SAFE_IDEMPOTENCY_KEY.hash"
  if [ -s "$MARKER" ]; then
    RECORDED_HASH=$(cat "$MARKER")
    if git rev-parse --verify --quiet "$RECORDED_HASH^{commit}" >/dev/null; then
      printf "%s" "$RECORDED_HASH"
      exit 0
    fi
  fi
fi
GIT_NAME=$(printf '%s' ${shellPosixSingleQuote(userNameB)} | invoker_base64_decode)
GIT_EMAIL=$(printf '%s' ${shellPosixSingleQuote(userEmailB)} | invoker_base64_decode)
BR=$(printf '%s' ${shellPosixSingleQuote(brB)} | invoker_base64_decode)
PUSH_URL=$(printf '%s' ${shellPosixSingleQuote(pushRemoteUrlB)} | invoker_base64_decode)
if [ -n "$PUSH_URL" ]; then
  PUSH_REMOTE="$PUSH_URL"
else
  PUSH_REMOTE=origin
fi
push_recorded_head() {
  HASH=$(git rev-parse HEAD)
  REMOTE_EXPECTED=$(git ls-remote "$PUSH_REMOTE" "refs/heads/$BR" | awk 'NR == 1 { print $1 }')
  if [ -n "$REMOTE_EXPECTED" ]; then
    git push --force-with-lease="refs/heads/$BR:$REMOTE_EXPECTED" "$PUSH_REMOTE" "$HASH:refs/heads/$BR"
  else
    git push "$PUSH_REMOTE" "$HASH:refs/heads/$BR"
  fi
  if [ -n "$MARKER" ]; then
    mkdir -p "$(dirname "$MARKER")"
    printf "%s" "$HASH" > "$MARKER.tmp"
    mv "$MARKER.tmp" "$MARKER"
  fi
  printf "%s" "$HASH"
}
if [ -n "$IDEMPOTENCY_FOOTER" ] && git log -1 --format=%B | grep -Fqx "$IDEMPOTENCY_FOOTER"; then
  push_recorded_head
  exit 0
fi
git add -A
M=$(mktemp)
trap 'rm -f "$M"' EXIT
if git diff --cached --quiet; then
  printf '%s' ${shellPosixSingleQuote(emB)} | invoker_base64_decode > "$M"
  if [ -n "$IDEMPOTENCY_FOOTER" ]; then printf '\\n%s\\n' "$IDEMPOTENCY_FOOTER" >> "$M"; fi
  GIT_AUTHOR_NAME="$GIT_NAME" GIT_AUTHOR_EMAIL="$GIT_EMAIL" GIT_COMMITTER_NAME="$GIT_NAME" GIT_COMMITTER_EMAIL="$GIT_EMAIL" git commit --allow-empty -F "$M"
else
  printf '%s' ${shellPosixSingleQuote(chB)} | invoker_base64_decode > "$M"
  if [ -n "$IDEMPOTENCY_FOOTER" ]; then printf '\\n%s\\n' "$IDEMPOTENCY_FOOTER" >> "$M"; fi
  GIT_AUTHOR_NAME="$GIT_NAME" GIT_AUTHOR_EMAIL="$GIT_EMAIL" GIT_COMMITTER_NAME="$GIT_NAME" GIT_COMMITTER_EMAIL="$GIT_EMAIL" git commit -F "$M"
fi
push_recorded_head
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
