/**
 * Resolve plan base refs in the pool mirror clone so worktrees branch from the requested
 * remote tip, not a stale local refs/heads/<branch>.
 */

const SHA40 = /^[0-9a-f]{40}$/i;
const HEADS_PREFIX = 'refs/heads/';
const REMOTES_PREFIX = 'refs/remotes/';

/** Git runner: args + implicit cwd (caller binds cwd via closure). */
export type GitExec = (args: string[]) => Promise<string>;

interface RemoteQualifiedRef {
  remoteName: string;
  branchName: string;
}

async function tryResolveCommit(runGit: GitExec, refExpr: string): Promise<string | undefined> {
  try {
    return (await runGit(['rev-parse', '--verify', refExpr])).trim();
  } catch {
    return undefined;
  }
}

async function tryResolveRemoteHeadCommit(runGit: GitExec, remoteName: string): Promise<string | undefined> {
  try {
    const remoteHeadRef = (await runGit([
      'symbolic-ref',
      '--quiet',
      '--short',
      `refs/remotes/${remoteName}/HEAD`,
    ])).trim();
    if (!remoteHeadRef) return undefined;
    return await tryResolveCommit(runGit, `${remoteHeadRef}^{commit}`);
  } catch {
    return undefined;
  }
}

async function tryResolveOriginHeadCommit(runGit: GitExec): Promise<string | undefined> {
  return tryResolveRemoteHeadCommit(runGit, 'origin');
}

async function listRemoteNames(runGit: GitExec): Promise<string[]> {
  try {
    const output = await runGit(['remote']);
    const names = output
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length > 0) {
      return [...new Set(names)].sort((left, right) => right.length - left.length);
    }
  } catch {
    // Fall through to the default remote.
  }
  return ['origin'];
}

function stripHeadsPrefix(ref: string): string {
  return ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;
}

function parseRemoteQualifiedRef(ref: string, remoteNames: readonly string[]): RemoteQualifiedRef | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith(REMOTES_PREFIX)) {
    const rest = trimmed.slice(REMOTES_PREFIX.length);
    for (const remoteName of remoteNames) {
      const prefix = `${remoteName}/`;
      if (rest.startsWith(prefix) && rest.length > prefix.length) {
        return { remoteName, branchName: rest.slice(prefix.length) };
      }
    }
    const slashIndex = rest.indexOf('/');
    if (slashIndex > 0 && slashIndex < rest.length - 1) {
      return { remoteName: rest.slice(0, slashIndex), branchName: rest.slice(slashIndex + 1) };
    }
    return undefined;
  }

  for (const remoteName of remoteNames) {
    const prefix = `${remoteName}/`;
    if (trimmed.startsWith(prefix) && trimmed.length > prefix.length) {
      return { remoteName, branchName: trimmed.slice(prefix.length) };
    }
  }
  return undefined;
}

/**
 * Fetch a single branch from the selected remote into refs/remotes/<remote>/<branch>.
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
      || msg.includes("fatal: couldn't find remote ref");
    if (!missingRemoteRef) {
      throw err;
    }
  }
}

/**
 * Fetch the single remote branch that backs `baseRef` before resolving it.
 * No-op for HEAD, full SHAs, refs/* tags, or rev expressions with traversal.
 */
export async function syncPlanBaseRemoteForRef(
  runGit: GitExec,
  baseRef: string,
): Promise<void> {
  const r = baseRef.trim();
  if (!r || r === 'HEAD') return;
  if (isFullSha(r)) return;
  if (r.includes('~') || r.includes('^')) return;

  const remoteNames = await listRemoteNames(runGit);
  const explicitRemote = parseRemoteQualifiedRef(r, remoteNames);
  if (explicitRemote) {
    await syncPlanBaseRemote(runGit, explicitRemote.branchName, explicitRemote.remoteName);
    return;
  }

  if (r.startsWith('refs/') && !r.startsWith(HEADS_PREFIX)) {
    return;
  }

  const branchName = stripHeadsPrefix(r);
  const preferredRemote = await resolvePreferredTrackingRemote(runGit, branchName);
  await syncPlanBaseRemote(runGit, branchName, preferredRemote);
}

/**
 * For short branch names, choose the tracking remote that should define the workflow base.
 */
export async function resolvePreferredTrackingRemote(
  runGit: GitExec,
  baseBranch: string,
): Promise<string> {
  const remoteNames = await listRemoteNames(runGit);
  const explicitRemote = parseRemoteQualifiedRef(baseBranch, remoteNames);
  if (explicitRemote) return explicitRemote.remoteName;
  if (remoteNames.includes('origin')) return 'origin';
  return remoteNames[0] ?? 'origin';
}

function isFullSha(ref: string): boolean {
  return SHA40.test(ref.trim());
}

export function shouldResolveViaOriginTracking(ref: string): boolean {
  const r = ref.trim();
  if (!r || r === 'HEAD') return false;
  if (isFullSha(r)) return false;
  if (r.startsWith('refs/')) return false;
  if (r.includes('~') || r.includes('^')) return false;
  return !r.startsWith('origin/');
}

/**
 * Resolve base ref to a full commit SHA for computeContentHash / worktree base.
 * Short branch names use the preferred tracking remote; explicit remote-qualified refs keep
 * that remote selection.
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

  const remoteNames = await listRemoteNames(runGit);
  const explicitRemote = parseRemoteQualifiedRef(r, remoteNames);
  if (explicitRemote) {
    const remoteExpr = `${explicitRemote.remoteName}/${explicitRemote.branchName}^{commit}`;
    const resolved = await tryResolveCommit(runGit, remoteExpr);
    if (resolved) return resolved;

    await syncPlanBaseRemote(runGit, explicitRemote.branchName, explicitRemote.remoteName);
    const synced = await tryResolveCommit(runGit, remoteExpr);
    if (synced) return synced;

    const remoteHeadFallback = await tryResolveRemoteHeadCommit(runGit, explicitRemote.remoteName);
    if (remoteHeadFallback) return remoteHeadFallback;
    const originHeadFallback = explicitRemote.remoteName === 'origin'
      ? undefined
      : await tryResolveOriginHeadCommit(runGit);
    if (originHeadFallback) return originHeadFallback;

    throw new Error(
      `Unable to resolve base ref "${r}" as ${remoteExpr}. `
      + `Ensure the branch exists locally or on ${explicitRemote.remoteName}.`,
    );
  }

  if (r.startsWith('refs/') && !r.startsWith(HEADS_PREFIX)) {
    return (await runGit(['rev-parse', '--verify', `${r}^{commit}`])).trim();
  }

  const branchName = stripHeadsPrefix(r);
  const preferredRemote = await resolvePreferredTrackingRemote(runGit, branchName);
  const remoteExpr = `${preferredRemote}/${branchName}^{commit}`;
  const localExpr = `refs/heads/${branchName}^{commit}`;

  const remoteResolved = await tryResolveCommit(runGit, remoteExpr);
  if (remoteResolved) return remoteResolved;

  const localResolved = await tryResolveCommit(runGit, localExpr);
  if (localResolved) return localResolved;

  await syncPlanBaseRemote(runGit, branchName, preferredRemote);
  const remoteAfterSync = await tryResolveCommit(runGit, remoteExpr);
  if (remoteAfterSync) return remoteAfterSync;

  const localAfterSync = await tryResolveCommit(runGit, localExpr);
  if (localAfterSync) return localAfterSync;

  const preferredHeadFallback = await tryResolveRemoteHeadCommit(runGit, preferredRemote);
  if (preferredHeadFallback) return preferredHeadFallback;
  const originHeadFallback = preferredRemote === 'origin'
    ? undefined
    : await tryResolveOriginHeadCommit(runGit);
  if (originHeadFallback) return originHeadFallback;

  throw new Error(
    `Unable to resolve base ref "${r}" as ${remoteExpr} or ${localExpr}. `
    + `Ensure the branch exists locally or on ${preferredRemote}.`,
  );
}

/**
 * Branches Invoker creates in the pool mirror; safe to remove on rebase-and-retry.
 */
export function isInvokerManagedPoolBranch(branch: string): boolean {
  return branch.startsWith('experiment/') || branch.startsWith('invoker/');
}

/**
 * Verify a dependency task's exact commit is resolvable in the pool mirror,
 * retrying `fetch --all` with backoff first. The pool mirror is shared and
 * reused across tasks (RepoPool.ensureClone), and `syncPlanBaseRemoteForRef`
 * only ever fetches the named `baseRef` -- it never fetches for an explicit
 * dependency SHA (isFullSha short-circuits it). A dependency's just-pushed
 * commit can therefore be unresolvable here purely from timing, not because
 * it's actually missing. Throws with a clear message if it's still
 * unresolvable after retries, instead of letting a later `git worktree add`
 * fail with an opaque "invalid reference".
 */
export async function ensureRequiredCommitResolvable(
  runGit: GitExec,
  commit: string,
  opts: {
    maxAttempts?: number;
    sleepMs?: (attempt: number) => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const sleepMs = opts.sleepMs ?? ((attempt) => attempt * 2000);
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (await tryResolveCommit(runGit, `${commit}^{commit}`)) return;
    if (attempt >= maxAttempts) {
      throw new Error(
        `Required commit ${commit} not resolvable after ${maxAttempts} fetch attempts. `
        + `It may not have propagated to the shared pool mirror yet.`,
      );
    }
    await sleep(sleepMs(attempt));
    await runGit(['fetch', '--all', '--prune']).catch(() => undefined);
  }
}
