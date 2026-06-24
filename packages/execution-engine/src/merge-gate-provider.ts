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

export interface MergeGateCheckSummary {
  state: 'pending' | 'success' | 'failure';
  failed: MergeGateFailedCheck[];
}

export interface MergeGateApprovalStatus {
  approved: boolean;
  rejected: boolean;
  closed?: boolean;
  statusText: string;
  url: string;
  headSha?: string;
  headRef?: string;
  mergeState?: 'clean' | 'dirty' | 'unknown';
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
}
