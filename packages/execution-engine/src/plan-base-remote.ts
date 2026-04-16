/**
 * Resolve plan base refs against origin/<branch> in the pool mirror clone so worktrees
 * branch from the remote tip, not a stale local refs/heads/<branch>.
 */

const SHA40 = /^[0-9a-f]{40}$/i;

/** Git runner: args + implicit cwd (caller binds cwd via closure). */
export type GitExec = (args: string[]) => Promise<string>;

async function tryResolveCommit(runGit: GitExec, refExpr: string): Promise<string | undefined> {
  try {
    return (await runGit(['rev-parse', '--verify', refExpr])).trim();
  } catch {
    return undefined;
  }
}

async function hasRemote(runGit: GitExec, remoteName: string): Promise<boolean> {
  try {
    await runGit(['remote', 'get-url', remoteName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch a single branch from origin into refs/remotes/origin/<baseBranch>.
 */
export async function syncPlanBaseRemote(
  runGit: GitExec,
  baseBranch: string,
  remoteName: 'origin' | 'upstream' = 'origin',
): Promise<void> {
  const spec = `refs/heads/${baseBranch}:refs/remotes/${remoteName}/${baseBranch}`;
  try {
    await runGit(['fetch', remoteName, spec]);
  } catch (err) {
    // Branch may not exist on origin yet (for stacked workflows). Callers can
    // still resolve local refs/heads/<branch> when available.
    const msg = err instanceof Error ? err.message : String(err);
    const missingRemoteRef =
      msg.includes("couldn't find remote ref")
      || msg.includes('fatal: invalid refspec')
      || msg.includes('fatal: couldn\'t find remote ref');
    if (!missingRemoteRef) {
      throw err;
    }
  }
}

/**
 * For short branch names, choose the tracking remote that should define the
 * workflow base in fork workflows.
 */
export async function resolvePreferredTrackingRemote(
  runGit: GitExec,
  baseBranch: string,
): Promise<'origin' | 'upstream'> {
  const branch = baseBranch.trim();
  if (!branch || !shouldResolveViaOriginTracking(branch)) return 'origin';
  if (!(await hasRemote(runGit, 'upstream'))) return 'origin';

  // Refresh upstream tracking ref first so the decision is made from current remote state.
  await syncPlanBaseRemote(runGit, branch, 'upstream');
  const upstreamResolved = await tryResolveCommit(runGit, `upstream/${branch}^{commit}`);
  return upstreamResolved ? 'upstream' : 'origin';
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
  if (r.startsWith('upstream/')) {
    return (await runGit(['rev-parse', '--verify', `${r}^{commit}`])).trim();
  }
  if (shouldResolveViaOriginTracking(r)) {
    const upstreamRemoteConfigured = await hasRemote(runGit, 'upstream');
    const upstreamExpr = `upstream/${r}^{commit}`;
    const originExpr = `origin/${r}^{commit}`;
    const localExpr = `refs/heads/${r}^{commit}`;

    if (upstreamRemoteConfigured) {
      const upstreamResolved = await tryResolveCommit(runGit, upstreamExpr);
      if (upstreamResolved) return upstreamResolved;

      await syncPlanBaseRemote(runGit, r, 'upstream');
      const upstreamAfterSync = await tryResolveCommit(runGit, upstreamExpr);
      if (upstreamAfterSync) return upstreamAfterSync;
    }

    const originResolved = await tryResolveCommit(runGit, originExpr);
    if (originResolved) return originResolved;

    // Common stacked-diff case: branch exists locally in the mirror but has no
    // tracking ref yet (or was created before fetch).
    const localResolved = await tryResolveCommit(runGit, localExpr);
    if (localResolved) return localResolved;

    // Last chance: fetch the branch into origin/<branch>, then retry both.
    await syncPlanBaseRemote(runGit, r, 'origin');
    const originAfterSync = await tryResolveCommit(runGit, originExpr);
    if (originAfterSync) return originAfterSync;
    const localAfterSync = await tryResolveCommit(runGit, localExpr);
    if (localAfterSync) return localAfterSync;

    throw new Error(
      `Unable to resolve base ref "${r}" as ${originExpr} or ${localExpr}. ` +
      `Ensure the branch exists locally or on origin.`,
    );
  }
  return (await runGit(['rev-parse', '--verify', `${r}^{commit}`])).trim();
}

/**
 * Branches Invoker creates in the pool mirror; safe to remove on rebase-and-retry.
 */
export function isInvokerManagedPoolBranch(branch: string): boolean {
  return branch.startsWith('experiment/') || branch.startsWith('invoker/');
}
