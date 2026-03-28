import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

/**
 * Merkle-style hash for content-addressable branch naming.
 * Inputs: task identity + command/prompt + upstream dependency commits + base branch HEAD.
 * When any input changes (e.g. master moves forward), the hash changes and a fresh branch is created.
 */
export function computeBranchHash(
  actionId: string,
  command: string | undefined,
  prompt: string | undefined,
  upstreamCommits: string[],
  baseHead: string,
  salt: string = '',
): string {
  const h = createHash('sha256');
  h.update(actionId);
  h.update(command ?? '');
  h.update(prompt ?? '');
  for (const c of [...upstreamCommits].sort()) h.update(c);
  h.update(baseHead);
  if (salt) h.update(salt);
  return h.digest('hex').slice(0, 8);
}

export interface PreserveOrResetOpts {
  repoDir: string;
  worktreeDir?: string;
  branch: string;
  base: string;
}

/**
 * Generate a bash script that preserves an existing branch with commits ahead
 * of base (merging base in), or force-creates from base for a clean start.
 * In worktree mode, also creates the worktree.
 *
 * Outputs to stdout: "PRESERVED=0|1\nBASE_SHA=<sha>"
 * Exit code 0 on success.
 */
export function bashPreserveOrReset(opts: PreserveOrResetOpts): string {
  const { repoDir, worktreeDir, branch, base } = opts;
  const q = shellQuote;

  // #region agent log
  if (repoDir.includes('$HOME') || repoDir.startsWith('~/')) {
    fetch('http://127.0.0.1:7658/ingest/762b7479-8057-4c6f-a805-85ee7d433bf5', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '39b8ae' },
      body: JSON.stringify({
        sessionId: '39b8ae',
        runId: 'pre-fix',
        hypothesisId: 'H1',
        location: 'branch-utils.ts:bashPreserveOrReset',
        message: 'preserve script path quoting',
        data: {
          repoDir,
          worktreeDir: worktreeDir ?? null,
          repoDirAssignment: `REPO_DIR=${q(repoDir)}`.slice(0, 120),
          usedSingleQuotedHome: q(repoDir).startsWith("'$HOME"),
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  }
  // #endregion

  // All paths/refs are injected as shell-quoted literals.
  // The script resolves the base ref to a concrete SHA, checks if the branch
  // exists with commits ahead, and either preserves or force-creates.
  return `set -euo pipefail
REPO_DIR=${q(repoDir)}
BRANCH=${q(branch)}
BASE=${q(base)}
BASE_SHA=$(git -C "$REPO_DIR" rev-parse "$BASE")
preserved=0
${worktreeDir ? generateWorktreePreserve(q(worktreeDir)) : generateCheckoutPreserve()}
echo "PRESERVED=$preserved"
echo "BASE_SHA=$BASE_SHA"
`;
}

function generateWorktreePreserve(worktreeDir: string): string {
  return `WT_DIR=${worktreeDir}
if git -C "$REPO_DIR" rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  AHEAD=$(git -C "$REPO_DIR" rev-list --count "$BASE_SHA..$BRANCH" 2>/dev/null || echo 0)
  if [ "\${AHEAD:-0}" -gt 0 ]; then
    git -C "$REPO_DIR" worktree add "$WT_DIR" "$BRANCH"
    git -C "$WT_DIR" merge --no-edit "$BASE_SHA"
    preserved=1
  fi
fi
if [ "$preserved" -eq 0 ]; then
  git -C "$REPO_DIR" worktree add -B "$BRANCH" "$WT_DIR" "$BASE"
fi`;
}

function generateCheckoutPreserve(): string {
  return `if git -C "$REPO_DIR" rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  AHEAD=$(git -C "$REPO_DIR" rev-list --count "$BASE_SHA..$BRANCH" 2>/dev/null || echo 0)
  if [ "\${AHEAD:-0}" -gt 0 ]; then
    git -C "$REPO_DIR" checkout "$BRANCH"
    git -C "$REPO_DIR" merge --no-edit "$BASE"
    preserved=1
  fi
fi
if [ "$preserved" -eq 0 ]; then
  git -C "$REPO_DIR" checkout -B "$BRANCH" "$BASE"
fi`;
}

export interface MergeUpstreamsOpts {
  worktreeDir: string;
  upstreamBranches: string[];
  skipAncestors?: boolean;
}

/**
 * Generate a bash script that merges upstream dependency branches into the
 * working directory. Skips branches already in HEAD's ancestry by default.
 *
 * Exit codes: 0=success, 30=missing ref, 31=merge conflict.
 * On conflict, stderr contains MERGE_CONFLICT_BRANCH=<branch> and MERGE_CONFLICT_FILES.
 */
export function bashMergeUpstreams(opts: MergeUpstreamsOpts): string {
  const { worktreeDir, upstreamBranches, skipAncestors = true } = opts;
  if (!upstreamBranches.length) return 'true';

  const q = shellQuote;
  const branches = upstreamBranches.map(b => q(b)).join(' ');

  return `set -euo pipefail
WT_DIR=${q(worktreeDir)}
for upBranch in ${branches}; do
  # Resolve: try bare name first, then origin/ prefix
  if git -C "$WT_DIR" rev-parse --verify "$upBranch" >/dev/null 2>&1; then
    upRef="$upBranch"
  elif git -C "$WT_DIR" rev-parse --verify "origin/$upBranch" >/dev/null 2>&1; then
    upRef="origin/$upBranch"
  else
    echo "MISSING_REF=$upBranch" >&2
    exit 30
  fi
${skipAncestors ? `  if git -C "$WT_DIR" merge-base --is-ancestor "$upRef" HEAD 2>/dev/null; then
    echo "SKIPPED=$upBranch"
    continue
  fi` : ''}
  if ! git -C "$WT_DIR" merge --no-edit -m "Invoker: merge $upBranch" "$upRef" 2>&1; then
    echo "MERGE_CONFLICT_BRANCH=$upBranch" >&2
    git -C "$WT_DIR" diff --name-only --diff-filter=U 2>/dev/null | while IFS= read -r f; do
      [ -n "$f" ] && echo "MERGE_CONFLICT_FILE=$f" >&2
    done
    git -C "$WT_DIR" merge --abort 2>/dev/null || true
    exit 31
  fi
done
`;
}

export interface EnsureRefOpts {
  worktreeDir: string;
  branch: string;
}

/**
 * Generate a bash script that verifies a ref is available locally.
 * Tries bare name, then origin/ prefix. Exit 30 if not found.
 */
export function bashEnsureRef(opts: EnsureRefOpts): string {
  const { worktreeDir, branch } = opts;
  const q = shellQuote;

  return `set -euo pipefail
WT_DIR=${q(worktreeDir)}
BRANCH=${q(branch)}
if git -C "$WT_DIR" rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  exit 0
elif git -C "$WT_DIR" rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  exit 0
else
  echo "MISSING_REF=$BRANCH" >&2
  exit 30
fi
`;
}

export interface PreserveResult {
  preserved: boolean;
  baseSha: string;
}

/**
 * Parse the stdout of bashPreserveOrReset.
 * Expected format: "PRESERVED=0|1\nBASE_SHA=<sha>"
 */
export function parsePreserveResult(stdout: string): PreserveResult {
  const lines = stdout.trim().split('\n');
  let preserved = false;
  let baseSha = '';
  for (const line of lines) {
    if (line.startsWith('PRESERVED=')) {
      preserved = line.slice('PRESERVED='.length).trim() === '1';
    } else if (line.startsWith('BASE_SHA=')) {
      baseSha = line.slice('BASE_SHA='.length).trim();
    }
  }
  if (!baseSha) {
    throw new Error(`Failed to parse bashPreserveOrReset output: missing BASE_SHA in: ${stdout}`);
  }
  return { preserved, baseSha };
}

export interface MergeError {
  failedBranch: string;
  conflictFiles: string[];
}

/**
 * Parse the stderr/exit code of bashMergeUpstreams on failure.
 * Exit 30 = missing ref, exit 31 = merge conflict.
 */
export function parseMergeError(exitCode: number, stderr: string): MergeError {
  const lines = stderr.trim().split('\n');
  let failedBranch = '';
  const conflictFiles: string[] = [];

  for (const line of lines) {
    if (line.startsWith('MERGE_CONFLICT_BRANCH=')) {
      failedBranch = line.slice('MERGE_CONFLICT_BRANCH='.length).trim();
    } else if (line.startsWith('MERGE_CONFLICT_FILE=')) {
      const f = line.slice('MERGE_CONFLICT_FILE='.length).trim();
      if (f) conflictFiles.push(f);
    } else if (line.startsWith('MISSING_REF=')) {
      failedBranch = line.slice('MISSING_REF='.length).trim();
    }
  }

  return { failedBranch, conflictFiles };
}

/**
 * Run a bash script locally via child_process.spawn.
 * Returns stdout on success; throws on non-zero exit with stderr attached.
 */
export function runBashLocal(script: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn bash: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        const err = new Error(`bash exited with code ${code}: ${stderr.trim()}`);
        (err as any).exitCode = code;
        (err as any).stderr = stderr;
        reject(err);
      }
    });
  });
}

function shellQuote(s: string): string {
  // `$HOME/...` and `~/...` must use double-quoted bash so $HOME expands.
  // Single-quoted literals would make git -C see a path literally named "$HOME".
  if (s.startsWith('$HOME/')) {
    const rest = s.slice('$HOME/'.length).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
    return `"$HOME/${rest}"`;
  }
  if (s.startsWith('~/')) {
    const rest = s.slice(2).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
    return `"$HOME/${rest}"`;
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
