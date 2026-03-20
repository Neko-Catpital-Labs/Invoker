export interface MergeGateProviderResult {
  url: string;
  identifier: string;
}

export interface MergeGateApprovalStatus {
  approved: boolean;
  rejected: boolean;
  statusText: string;
  url: string;
}

export interface MergeGateProvider {
  readonly name: string;

  createReview(opts: {
    baseBranch: string;
    featureBranch: string;
    title: string;
    cwd: string;
  }): Promise<MergeGateProviderResult>;

  checkApproval(opts: {
    identifier: string;
    cwd: string;
  }): Promise<MergeGateApprovalStatus>;
}
