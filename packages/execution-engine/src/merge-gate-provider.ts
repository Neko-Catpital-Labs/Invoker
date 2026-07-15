export interface MergeGateProviderResult {
  url: string;
  identifier: string;
}

export interface MergeGateCreateReviewOptions {
  baseBranch: string;
  featureBranch: string;
  title: string;
  cwd: string;
  body?: string;
}

export interface MergeGateCheckApprovalOptions {
  identifier: string;
  cwd: string;
}

export interface MergeGateCloseReviewOptions {
  identifier: string;
  cwd: string;
}

export interface MergeGateUpdateReviewBodyOptions {
  identifier: string;
  cwd: string;
  body: string;
}

export interface MergeGateCheckSummary {
  state: 'pending' | 'success' | 'failure';
  failed: MergeGateFailedCheck[];
}

/**
 * PR lifecycle — exactly one of these by construction. Both `merged` and
 * `closed` derive from a single GitHub PR `state`, so a merge gate can never
 * observe a PR that is simultaneously merged and closed. Modelling it as one
 * field (instead of separate `approved`/`closed` booleans) makes that illegal
 * combination unrepresentable rather than something each consumer must guard.
 */
export type MergeGatePrLifecycle = 'open' | 'closed' | 'merged';

export interface MergeGateApprovalStatus {
  lifecycle: MergeGatePrLifecycle;
  /**
   * Review decision is an independent axis from lifecycle: a PR can have changes
   * requested AND be closed, so this stays a separate flag, not a lifecycle case.
   */
  rejected: boolean;
  statusText: string;
  url: string;
  headSha?: string;
  headRef?: string;
  mergeState?: 'clean' | 'dirty' | 'unknown';
  hasMergeConflict?: boolean;
  checks?: MergeGateCheckSummary;
}

export interface MergeGateFailedCheck {
  name: string;
  conclusion?: string;
  detailsUrl?: string;
  summary?: string;
}

export interface MergeGateProvider {
  readonly name: string;

  // INV-77 selected boundary: execution-engine owns provider IO and exposes
  // typed review creation, polling, closure, check, and merge-state metadata.
  createReview(opts: MergeGateCreateReviewOptions): Promise<MergeGateProviderResult>;

  checkApproval(opts: MergeGateCheckApprovalOptions): Promise<MergeGateApprovalStatus>;

  closeReview?(opts: MergeGateCloseReviewOptions): Promise<void>;

  /** Read the live PR body as published on the provider (e.g. GitHub). */
  getReviewBody?(opts: { identifier: string; cwd: string }): Promise<string>;

  /** Replace the live PR body as published on the provider (e.g. GitHub). */
  updateReviewBody?(opts: MergeGateUpdateReviewBodyOptions): Promise<void>;
}
