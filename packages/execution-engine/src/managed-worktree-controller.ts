export interface ManagedWorktreeExactCandidate {
  path: string;
  headMatchesTargetBranch: boolean;
}

export interface ManagedWorktreeActionCandidate {
  path: string;
  branch: string;
  baseIsAncestorOfHead: boolean;
}

export interface ManagedWorktreeContentCandidate {
  path: string;
  branch: string;
}

export interface PlanManagedWorktreeInput {
  targetBranch: string;
  targetWorktreePath: string;
  forceFresh?: boolean;
  exactBranchCandidate?: ManagedWorktreeExactCandidate;
  actionIdCandidate?: ManagedWorktreeActionCandidate;
  /**
   * Worktree found via `findManagedWorktreeByContent`: same actionId, same
   * content hash, *different* lifecycle tag. Cache-equivalent → safe to reuse
   * by renaming the existing branch to the new target branch name. Reused even
   * when `forceFresh=true` because the spec is identical and the rename is a
   * cheap, non-destructive operation that avoids leaking another worktree.
   */
  contentCandidate?: ManagedWorktreeContentCandidate;
}

export type ManagedWorktreePlan =
  | {
    kind: 'reuse_exact';
    worktreePath: string;
  }
  | {
    kind: 'rename_reuse';
    worktreePath: string;
    fromBranch: string;
    toBranch: string;
  }
  | {
    kind: 'rename_to_lifecycle';
    worktreePath: string;
    fromBranch: string;
    toBranch: string;
  }
  | {
    kind: 'recreate';
    worktreePath: string;
    cleanupPaths: string[];
  };

export function planManagedWorktree(input: PlanManagedWorktreeInput): ManagedWorktreePlan {
  const cleanupPaths = new Set<string>([input.targetWorktreePath]);
  const allowReuse = input.forceFresh !== true;

  if (allowReuse && input.exactBranchCandidate?.headMatchesTargetBranch) {
    return {
      kind: 'reuse_exact',
      worktreePath: input.exactBranchCandidate.path,
    };
  }

  // Cache-equivalent reuse: identical actionId + contentHash but different
  // lifecycle tag (e.g. recreate of same spec). Honoured even when
  // `forceFresh=true` because reusing the workspace is strictly an
  // optimisation — the new lifecycle tag still uniquely identifies the
  // dispatch, and renaming the branch is non-destructive.
  if (input.contentCandidate && input.contentCandidate.branch !== input.targetBranch) {
    return {
      kind: 'rename_to_lifecycle',
      worktreePath: input.contentCandidate.path,
      fromBranch: input.contentCandidate.branch,
      toBranch: input.targetBranch,
    };
  }

  // If the target branch is already attached to another managed worktree but
  // that worktree is not reusable, we must reconcile that owning path before
  // creating/resetting the target branch again.
  if (input.exactBranchCandidate && !input.exactBranchCandidate.headMatchesTargetBranch) {
    cleanupPaths.add(input.exactBranchCandidate.path);
  }

  // Fallback: reuse worktree for same actionId but different hash (preserves
  // conflict resolutions). Only reuse when the requested base is an ancestor
  // of the existing worktree's HEAD — this means the worktree already contains
  // the caller's base revision and only the experiment commits are extra. If
  // the base has advanced beyond what the worktree contains, skip reuse and
  // fall through to fresh creation from the new base.
  if (allowReuse && input.actionIdCandidate?.baseIsAncestorOfHead) {
    return {
      kind: 'rename_reuse',
      worktreePath: input.actionIdCandidate.path,
      fromBranch: input.actionIdCandidate.branch,
      toBranch: input.targetBranch,
    };
  }

  return {
    kind: 'recreate',
    worktreePath: input.targetWorktreePath,
    cleanupPaths: [...cleanupPaths],
  };
}
