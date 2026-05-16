export interface CreateMergeGateReviewOptions {
  baseBranch: string;
  featureBranch: string;
  title: string;
  cwd: string;
  body?: string;
}

export interface MergeGateProviderResult {
  url: string;
  identifier: string;
}

export interface CheckMergeGateApprovalOptions {
  identifier: string;
  cwd: string;
}

export interface MergeGateApprovalStatus {
  approved: boolean;
  rejected: boolean;
  statusText: string;
  url: string;
}

/**
 * IO boundary for merge-gate reviews. The provider receives branches and cwd
 * only; graph state and merge dependency truth stay in workflow-core.
 */
export interface MergeGateProvider {
  readonly name: string;

  createReview(opts: CreateMergeGateReviewOptions): Promise<MergeGateProviderResult>;

  checkApproval(opts: CheckMergeGateApprovalOptions): Promise<MergeGateApprovalStatus>;
}
