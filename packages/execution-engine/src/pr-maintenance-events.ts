export type GitHubPrEventChange =
  | 'opened'
  | 'closed'
  | 'head_ref_changed'
  | 'merge_state_changed'
  | 'labels_changed'
  | 'coderabbit_comment'
  | 'mergify_comment';

export interface GitHubPrEvent {
  readonly eventKey: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly author: string;
  readonly headRefName: string;
  readonly mergeState: 'clean' | 'dirty' | 'unknown';
  readonly labels: readonly string[];
  readonly coderabbitCommentUpdatedAt?: string;
  readonly mergifyCommentUpdatedAt?: string;
  readonly changes: readonly GitHubPrEventChange[];
  readonly createdAt: string;
}

export function isGitHubPrEvent(value: unknown): value is GitHubPrEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return typeof event.eventKey === 'string'
    && typeof event.repo === 'string'
    && typeof event.prNumber === 'number'
    && typeof event.author === 'string'
    && typeof event.headRefName === 'string'
    && (event.mergeState === 'clean' || event.mergeState === 'dirty' || event.mergeState === 'unknown')
    && Array.isArray(event.labels)
    && event.labels.every((entry) => typeof entry === 'string')
    && Array.isArray(event.changes)
    && event.changes.every((entry) => typeof entry === 'string')
    && typeof event.createdAt === 'string';
}
