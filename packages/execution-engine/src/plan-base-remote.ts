/**
 * Resolve plan base refs in the pool mirror clone so worktrees branch from the remote tip,
 * not a stale local refs/heads/<branch>. Short names and legacy remote-qualified refs
 * both resolve against origin.
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

function stripKnownRemotePrefix(ref: string): string {
  if (ref.startsWith('origin/')) return ref.slice('origin/'.length);
  if (ref.startsWith('upstream/')) return ref.slice('upstream/'.length);
  if (ref.startsWith('refs/remotes/origin/')) return ref.slice('refs/remotes/origin/'.length);
  if (ref.startsWith('refs/remotes/upstream/')) return ref.slice('refs/remotes/upstream/'.length);
  return ref;
}

/**
 * Fetch the single remote branch that backs `baseRef` before resolving it.
 * No-op for HEAD, full SHAs, refs/*, or rev expressions with traversal.
 */
export async function syncPlanBaseRemoteForRef(
  runGit: GitExec,
  baseRef: string,
): Promise<void> {
  const r = baseRef.trim();
  if (!r || r === 'HEAD') return;
  if (isFullSha(r)) return;
  if (r.startsWith('refs/')) {
    if (!r.startsWith('refs/remotes/origin/')) return;
    await syncPlanBaseRemote(runGit, r.slice('refs/remotes/origin/'.length), 'origin');
    return;
  }
  if (r.includes('~') || r.includes('^')) return;

  if (r.startsWith('origin/')) {
    await syncPlanBaseRemote(runGit, r.slice('origin/'.length), 'origin');
    return;
  }

  if (shouldResolveViaOriginTracking(r)) {
    await syncPlanBaseRemote(runGit, stripKnownRemotePrefix(r), 'origin');
  }
}

/**
 * For short branch names, choose tracking remote that should define workflow base.
 */
export async function resolvePreferredTrackingRemote(
  _runGit: GitExec,
  _baseBranch: string,
): Promise<string> {
  return 'origin';
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
  if (r.includes('~') || r.includes('^')) return false;
  return true;
}

/**
 * Resolve base ref to a full commit SHA for computeContentHash / worktree base.
 * For short branch names and legacy remote-qualified refs, uses origin/<branch>.
 */
export async function resolvePlanBaseRevision(
  runGit: GitExec,
  baseRef: string,
): Promise<string> {
  const r = baseRef.trim() || 'HEAD';
  if (r === 'HEAD') {
    return (await runGit(['rev-parse', 'HEAD'])).trim();
  }
  if (isFullSha(r)) {
    return (await runGit(['rev-parse', '--verify', `${r}^{commit}`])).trim();
  }
  if (r.startsWith('refs/heads/')) {
    return (await runGit(['rev-parse', '--verify', `${r}^{commit}`])).trim();
  }
  if (r.startsWith('refs/remotes/origin/')) {
    return (await runGit(['rev-parse', '--verify', `${r}^{commit}`])).trim();
  }
  if (r.startsWith('origin/')) {
    return (await runGit(['rev-parse', '--verify', `${r}^{commit}`])).trim();
  }

  const stripped = stripKnownRemotePrefix(r);
  if (shouldResolveViaOriginTracking(r)) {
    const originExpr = `origin/${stripped}^{commit}`;
    const localExpr = `refs/heads/${stripped}^{commit}`;

    const originResolved = await tryResolveCommit(runGit, originExpr);
    if (originResolved) return originResolved;

    const localResolved = await tryResolveCommit(runGit, localExpr);
    if (localResolved) return localResolved;

    await syncPlanBaseRemote(runGit, stripped, 'origin');
    const originAfterSync = await tryResolveCommit(runGit, originExpr);
    if (originAfterSync) return originAfterSync;
    const localAfterSync = await tryResolveCommit(runGit, localExpr);
    if (localAfterSync) return localAfterSync;

    throw new Error(
      `Unable to resolve base ref "${r}" as ${originExpr} or ${localExpr}. ` +
      `Ensure the branch exists locally or on origin.`,
    );
  }

  if (stripped !== r) {
    return (await runGit(['rev-parse', '--verify', `origin/${stripped}^{commit}`])).trim();
  }
  return (await runGit(['rev-parse', '--verify', `${r}^{commit}`])).trim();
}

/**
 * Branches Invoker creates in the pool mirror; safe to remove on rebase-and-retry.
 */
export function isInvokerManagedPoolBranch(branch: string): boolean {
  return branch.startsWith('experiment/') || branch.startsWith('invoker/');
}
