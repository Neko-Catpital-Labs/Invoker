export type WorkerDecision =
  | { readonly type: 'skip'; readonly reason?: string }
  | {
      readonly type: 'mutation';
      readonly workflowId: string;
      readonly channel: string;
      readonly args: unknown[];
      readonly priority?: string;
    }
  | {
      readonly type: 'effect';
      readonly name: string;
      readonly detail?: unknown;
    };

export interface DecisionFixture {
  readonly kind: string;
  readonly name: string;
  readonly decisions: readonly WorkerDecision[];
  readonly state?: unknown;
}
