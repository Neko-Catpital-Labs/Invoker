import type { ReviewGateArtifact } from '@invoker/workflow-core';

export interface ReviewGatePublishOptions {
  baseBranch: string;
  featureBranch: string;
  title: string;
  cwd: string;
  body?: string;
  preferredShape: 'stacked_diffs' | 'independent';
}

export interface ReviewGatePublishResult {
  sealed: boolean;
  relationship: { kind: 'stacked_diffs' | 'independent' | 'unknown'; managedBy: 'external' };
  artifacts: ReviewGateArtifact[];
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

export interface ReviewGateProvider {
  readonly name: string;

  // INV-77 selected boundary: execution-engine owns provider IO and exposes
  // typed review publishing, polling, closure, check, and merge-state metadata.
  publishReviewGate(opts: ReviewGatePublishOptions): Promise<ReviewGatePublishResult>;

  checkArtifact(opts: { identifier: string; cwd: string }): Promise<MergeGateApprovalStatus>;

  closeArtifact?(opts: { identifier: string; cwd: string }): Promise<void>;
}
