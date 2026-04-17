/**
 * Resolve plan base refs in the pool mirror clone so worktrees branch from the remote tip,
 * not a stale local refs/heads/<branch>. Short names sync from origin only; use
 * <parentRemote>/<branch> explicitly when parent remote should define the base.
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
  remoteName = 'origin',
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

function stripKnownRemotePrefix(ref: string, parentRemote: string): string {
  if (ref.startsWith('origin/')) return ref.slice('origin/'.length);
  const parentPrefix = `${parentRemote}/`;
  if (ref.startsWith(parentPrefix)) return ref.slice(parentPrefix.length);
  return ref;
}

/**
 * Fetch the single remote branch that backs `baseRef` before resolving it.
 * No-op for HEAD, full SHAs, refs/*, or rev expressions with traversal.
 */
export async function syncPlanBaseRemoteForRef(
  runGit: GitExec,
  baseRef: string,
  parentRemote = 'upstream',
): Promise<void> {
  const r = baseRef.trim();
  if (!r || r === 'HEAD') return;
  if (isFullSha(r)) return;
  if (r.startsWith('refs/')) return;
  if (r.includes('~') || r.includes('^')) return;

  const parentPrefix = `${parentRemote}/`;
  if (r.startsWith(parentPrefix)) {
    const branch = r.slice(parentPrefix.length);
    if (!branch || !(await hasRemote(runGit, parentRemote))) return;
    await syncPlanBaseRemote(runGit, branch, parentRemote);
    return;
  }

  if (r.startsWith('origin/')) {
    const branch = r.slice('origin/'.length);
    if (!branch) return;
    await syncPlanBaseRemote(runGit, branch, 'origin');
    return;
  }

  if (shouldResolveViaOriginTracking(r, parentRemote)) {
    await syncPlanBaseRemote(runGit, r, 'origin');
  }
}

/**
 * For short branch names, choose tracking remote that should define workflow base.
 */
export async function resolvePreferredTrackingRemote(
  runGit: GitExec,
  baseBranch: string,
  parentRemote = 'upstream',
): Promise<string> {
  const branch = baseBranch.trim();
  if (!branch || !shouldResolveViaOriginTracking(branch, parentRemote)) return 'origin';
  if (!(await hasRemote(runGit, parentRemote))) return 'origin';

  await syncPlanBaseRemote(runGit, branch, parentRemote);
  const parentResolved = await tryResolveCommit(runGit, `${parentRemote}/${branch}^{commit}`);
  return parentResolved ? parentRemote : 'origin';
}

function isFullSha(ref: string): boolean {
  return SHA40.test(ref.trim());
}

/**
 * True if we should resolve via origin/<name> after sync (short branch like master, main).
 */
export function shouldResolveViaOriginTracking(ref: string, parentRemote = 'upstream'): boolean {
  const r = ref.trim();
  if (!r || r === 'HEAD') return false;
  if (isFullSha(r)) return false;
  if (r.startsWith('refs/')) return false;
  if (r.startsWith('origin/')) return false;
  if (r.startsWith(`${parentRemote}/`)) return false;
  // tags often contain no slash but rev-parse treats ambiguous; require heads-like
  if (r.includes('~') || r.includes('^')) return false;
  return true;
}

/**
 * Resolve base ref to a full commit SHA for computeBranchHash / worktree base.
 * For short branch names, uses origin/<branch> (caller should syncPlanBaseRemote first).
 */
export async function resolvePlanBaseRevision(
  runGit: GitExec,
  baseRef: string,
  parentRemote = 'upstream',
): Promise<string> {
  const r = baseRef.trim() || 'HEAD';
  const parentPrefix = `${parentRemote}/`;
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
  if (r.startsWith(parentPrefix)) {
    return (await runGit(['rev-parse', '--verify', `${r}^{commit}`])).trim();
  }
  if (shouldResolveViaOriginTracking(r, parentRemote)) {
    const parentRemoteConfigured = await hasRemote(runGit, parentRemote);
    const parentExpr = `${parentRemote}/${r}^{commit}`;
    const originExpr = `origin/${r}^{commit}`;
    const localExpr = `refs/heads/${r}^{commit}`;

    if (parentRemoteConfigured) {
      const parentResolved = await tryResolveCommit(runGit, parentExpr);
      if (parentResolved) return parentResolved;

      await syncPlanBaseRemote(runGit, r, parentRemote);
      const parentAfterSync = await tryResolveCommit(runGit, parentExpr);
      if (parentAfterSync) return parentAfterSync;
    }

    const originResolved = await tryResolveCommit(runGit, originExpr);
    if (originResolved) return originResolved;

    // Common stacked-diff case: branch exists locally in the mirror but has no
    // tracking ref yet (or was created before fetch).
    const localResolved = await tryResolveCommit(runGit, localExpr);
    if (localResolved) return localResolved;

    // Last chance: fetch the branch into origin/<branch>, then retry both.
    await syncPlanBaseRemote(runGit, stripKnownRemotePrefix(r, parentRemote), 'origin');
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
