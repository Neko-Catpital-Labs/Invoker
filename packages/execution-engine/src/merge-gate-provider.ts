export interface MergeGateProviderResult {
  url: string;
  identifier: string;
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
  checks?: {
    state: 'pending' | 'success' | 'failure';
    failed: MergeGateFailedCheck[];
  };
}

export interface MergeGateFailedCheck {
  name: string;
  conclusion?: string;
  detailsUrl?: string;
  summary?: string;
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

  closeReview?(opts: {
    identifier: string;
    cwd: string;
  }): Promise<void>;
}
