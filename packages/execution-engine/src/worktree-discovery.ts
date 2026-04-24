import { realpathSync } from 'node:fs';
import { normalize, sep } from 'node:path';

export interface GitWorktreePorcelainEntry {
  path: string;
  /** Short branch name from `branch refs/heads/<name>` (omit detached). */
  branch?: string;
}

/**
 * Parse `git worktree list --porcelain` output into worktree records.
 * Blank lines separate records; `branch (detached)` entries have no `branch` field.
 */
export function parseGitWorktreePorcelain(porcelain: string): GitWorktreePorcelainEntry[] {
  const result: GitWorktreePorcelainEntry[] = [];
  let current: GitWorktreePorcelainEntry | null = null;

  const flush = () => {
    if (current) {
      result.push(current);
      current = null;
    }
  };

  for (const line of porcelain.split('\n')) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch refs/heads/') && current) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  flush();
  return result;
}

/** Resolve to a stable path for prefix checks and returned paths (macOS: /var vs /private/var). */
export function canonicalPathForComparison(p: string): string {
  try {
    return normalize(realpathSync(p));
  } catch {
    return normalize(p);
  }
}

/** True if `worktreePath` is exactly `prefix` or a descendant (Invoker-owned tree). */
export function pathIsUnderManagedPrefixes(worktreePath: string, managedPathPrefixes: string[]): boolean {
  const nw = canonicalPathForComparison(worktreePath);
  return managedPathPrefixes.some((p) => {
    const np = canonicalPathForComparison(p);
    return nw === np || nw.startsWith(np + sep);
  });
}

/**
 * First Invoker-managed worktree path where `branch` is checked out (per porcelain).
 */
export function findManagedWorktreeForBranch(
  porcelain: string,
  branch: string,
  managedPathPrefixes: string[],
): string | undefined {
  const entries = parseGitWorktreePorcelain(porcelain);
  for (const e of entries) {
    if (e.branch !== branch) continue;
    if (!pathIsUnderManagedPrefixes(e.path, managedPathPrefixes)) continue;
    return e.path;
  }
  return undefined;
}

/**
 * First Invoker-managed worktree whose branch starts with `experiment/{actionId}-`
 * (same task, possibly different hash). Returns the worktree path and branch name.
 */
export function findManagedWorktreeByActionId(
  porcelain: string,
  actionId: string,
  managedPathPrefixes: string[],
): { path: string; branch: string } | undefined {
  const prefix = `experiment/${actionId}-`;
  const entries = parseGitWorktreePorcelain(porcelain);
  for (const e of entries) {
    if (!e.branch?.startsWith(prefix)) continue;
    if (!pathIsUnderManagedPrefixes(e.path, managedPathPrefixes)) continue;
    return { path: e.path, branch: e.branch };
  }
  return undefined;
}

/** True if `git rev-parse --abbrev-ref HEAD` output matches the logical branch name. */
export function abbrevRefMatchesBranch(abbrevRef: string, branch: string): boolean {
  const t = abbrevRef.trim();
  if (t === 'HEAD') return false;
  return t === branch;
}

export interface ParsedExperimentBranch {
  /** Workflow-scoped action id (e.g. `wf-1234/task-name`). */
  actionId: string;
  /** Lifecycle tag (e.g. `g0.t1.a3f9c0d2`). */
  lifecycleTag: string;
  /** 8-char content hash (fingerprint of spec inputs). */
  contentHash: string;
}

export interface ContentMatchedWorktree {
  /** Worktree directory path. */
  path: string;
  /** Full branch name attached to the worktree. */
  branch: string;
  /** Lifecycle tag parsed out of the branch name. */
  lifecycleTag: string;
  /** Content hash parsed out of the branch name. */
  contentHash: string;
}

/**
 * First Invoker-managed worktree whose branch matches the new
 * `experiment/<actionId>/<lifecycleTag>-<contentHash>` shape *and* whose
 * actionId+contentHash equal the supplied values. Used by the acquire layer
 * to find a leftover worktree with cache-equivalent content (same spec) so
 * it can be re-used (and renamed to the current lifecycle tag) instead of
 * recreated from scratch.
 */
export function findManagedWorktreeByContent(
  porcelain: string,
  actionId: string,
  contentHash: string,
  managedPathPrefixes: string[],
): ContentMatchedWorktree | undefined {
  const entries = parseGitWorktreePorcelain(porcelain);
  for (const e of entries) {
    if (!e.branch) continue;
    if (!pathIsUnderManagedPrefixes(e.path, managedPathPrefixes)) continue;
    const parsed = parseExperimentBranch(e.branch);
    if (!parsed) continue;
    if (parsed.actionId !== actionId) continue;
    if (parsed.contentHash !== contentHash) continue;
    return {
      path: e.path,
      branch: e.branch,
      lifecycleTag: parsed.lifecycleTag,
      contentHash: parsed.contentHash,
    };
  }
  return undefined;
}

/**
 * Detect Invoker-managed worktrees whose branch shares a `contentHash` with the
 * supplied target but belongs to a *different* actionId. Such collisions are
 * statistically rare (8 hex chars / 32-bit space) but no longer fatal under the
 * new branch shape — the acquire layer can still create the new branch because
 * the lifecycle tag plus actionId path component differ. Caller is expected to
 * emit a structured warning so collisions can be observed in production.
 */
export function findContentHashCollisions(
  porcelain: string,
  contentHash: string,
  excludeActionId: string,
  managedPathPrefixes: string[],
): ContentMatchedWorktree[] {
  const out: ContentMatchedWorktree[] = [];
  const entries = parseGitWorktreePorcelain(porcelain);
  for (const e of entries) {
    if (!e.branch) continue;
    if (!pathIsUnderManagedPrefixes(e.path, managedPathPrefixes)) continue;
    const parsed = parseExperimentBranch(e.branch);
    if (!parsed) continue;
    if (parsed.contentHash !== contentHash) continue;
    if (parsed.actionId === excludeActionId) continue;
    out.push({
      path: e.path,
      branch: e.branch,
      lifecycleTag: parsed.lifecycleTag,
      contentHash: parsed.contentHash,
    });
  }
  return out;
}

/**
 * Parse an experiment branch name produced by `buildExperimentBranchName`.
 *
 * Returns the structured pieces, or `undefined` if the input does not match
 * the new `experiment/<actionId>/<lifecycleTag>-<contentHash>` shape.
 *
 * Note: the legacy `experiment/<actionId>-<sha8>` shape is intentionally not
 * recognized here — old-format branches are ignored by the new code paths
 * and are expected to be wiped manually by the operator.
 */
export function parseExperimentBranch(branch: string): ParsedExperimentBranch | undefined {
  if (typeof branch !== 'string' || !branch.startsWith('experiment/')) return undefined;
  const rest = branch.slice('experiment/'.length);
  const lastSlash = rest.lastIndexOf('/');
  if (lastSlash <= 0) return undefined;
  const actionId = rest.slice(0, lastSlash);
  const tail = rest.slice(lastSlash + 1);
  const dash = tail.lastIndexOf('-');
  if (dash <= 0 || dash === tail.length - 1) return undefined;
  const lifecycleTag = tail.slice(0, dash);
  const contentHash = tail.slice(dash + 1);
  if (!/^[0-9a-f]{8}$/.test(contentHash)) return undefined;
  if (!/^g\d+\.t\d+\.a[a-z0-9_-]*$/.test(lifecycleTag)) return undefined;
  if (!actionId.length) return undefined;
  return { actionId, lifecycleTag, contentHash };
}
