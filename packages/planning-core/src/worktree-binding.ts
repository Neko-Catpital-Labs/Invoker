export interface WorktreeBindingRequest {
  storedRepoUrl?: string;
  storedHeadSha?: string;
  requestedRepoUrl: string;
  requestedHeadSha: string;
  hasDraft: boolean;
}

export type WorktreeBindingAction = 'reuse' | 'provision' | 'invalidate_and_block_submit';

export type WorktreeBindingReason = 'no-prior-binding' | 'unchanged' | 'repo-changed' | 'commit-changed';

export interface WorktreeBindingDecision {
  action: WorktreeBindingAction;
  reason: WorktreeBindingReason;
}

export function decideWorktreeBinding(request: WorktreeBindingRequest): WorktreeBindingDecision {
  const { storedRepoUrl, storedHeadSha, requestedRepoUrl, requestedHeadSha, hasDraft } = request;

  if (storedRepoUrl === undefined || storedHeadSha === undefined) {
    return { action: 'provision', reason: 'no-prior-binding' };
  }

  if (storedRepoUrl === requestedRepoUrl && storedHeadSha === requestedHeadSha) {
    return { action: 'reuse', reason: 'unchanged' };
  }

  const reason: WorktreeBindingReason = storedRepoUrl !== requestedRepoUrl ? 'repo-changed' : 'commit-changed';
  return {
    action: hasDraft ? 'invalidate_and_block_submit' : 'provision',
    reason,
  };
}
