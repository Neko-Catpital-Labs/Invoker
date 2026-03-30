/**
 * Resolve plan base refs against origin/<branch> in the pool mirror clone so worktrees
 * branch from the remote tip, not a stale local refs/heads/<branch>.
 */

const SHA40 = /^[0-9a-f]{40}$/i;

/** Git runner: args + implicit cwd (caller binds cwd via closure). */
export type GitExec = (args: string[]) => Promise<string>;

/**
 * Fetch a single branch from origin into refs/remotes/origin/<baseBranch>.
 */
export async function syncPlanBaseRemote(runGit: GitExec, baseBranch: string): Promise<void> {
  const spec = `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`;
  await runGit(['fetch', 'origin', spec]);
}

function isFullSha(ref: string): boolean {
  return SHA40.test(ref.trim());
}

/**
 * True if we should resolve via origin/<name> after sync (short branch like master, main).
 */
export function shouldResolveViaOriginTracking(ref: string): boolean {
  const r = ref.trim();
  if (!r || r === 'HEAD') return false;
  if (isFullSha(r)) return false;
  if (r.startsWith('refs/')) return false;
  if (r.startsWith('origin/')) return false;
  // tags often contain no slash but rev-parse treats ambiguous; require heads-like
  if (r.includes('~') || r.includes('^')) return false;
  return true;
}

/**
 * Resolve base ref to a full commit SHA for computeBranchHash / worktree base.
 * For short branch names, uses origin/<branch> (caller should syncPlanBaseRemote first).
 */
export async function resolvePlanBaseRevision(runGit: GitExec, baseRef: string): Promise<string> {
  const r = baseRef.trim() || 'HEAD';
  if (r === 'HEAD') {
    return (await runGit(['rev-parse', 'HEAD'])).trim();
  }
  if (isFullSha(r)) {
    return (await runGit(['rev-parse', '--verify', `${r}^{commit}`])).trim();
  }
  if (r.startsWith('refs/')) {
    return (await runGit(['rev-parse', '--verify', `${r}^{commit}`])).trim();
  }
  if (r.startsWith('origin/')) {
    return (await runGit(['rev-parse', '--verify', `${r}^{commit}`])).trim();
  }
  if (shouldResolveViaOriginTracking(r)) {
    return (await runGit(['rev-parse', '--verify', `origin/${r}^{commit}`])).trim();
  }
  return (await runGit(['rev-parse', '--verify', `${r}^{commit}`])).trim();
}

/**
 * Branches Invoker creates in the pool mirror; safe to remove on rebase-and-retry.
 */
export function isInvokerManagedPoolBranch(branch: string): boolean {
  return branch.startsWith('experiment/') || branch.startsWith('invoker/');
}
