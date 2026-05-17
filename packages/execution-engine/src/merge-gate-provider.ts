export interface MergeGateProviderResult {
  url: string;
  identifier: string;
}

export interface MergeGateApprovalStatus {
  approved: boolean;
  rejected: boolean;
  /**
   * True when the upstream PR was closed without being merged. Terminal-neutral:
   * the task should transition to `closed`, downstream tasks must NOT dispatch,
   * and PR polling must stop. Mutually exclusive with `approved` and `rejected`.
   */
  closedUnmerged: boolean;
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
    body?: string;
  }): Promise<MergeGateProviderResult>;

  checkApproval(opts: {
    identifier: string;
    cwd: string;
  }): Promise<MergeGateApprovalStatus>;
}
