import { createHash, randomUUID } from 'node:crypto';

export interface ReviewBinding {
  token: string;
  contentHash: string;
  source: { kind: 'planPath'; planPath: string } | { kind: 'sessionId'; sessionId: string };
  createdAtMs: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export function hashPlanContent(planText: string): string {
  return createHash('sha256').update(planText).digest('hex');
}

export function createReviewTokenStore(ttlMs = DEFAULT_TTL_MS) {
  const bindings = new Map<string, ReviewBinding>();

  function prune(now = Date.now()): void {
    for (const [token, binding] of bindings) {
      if (now - binding.createdAtMs > ttlMs) {
        bindings.delete(token);
      }
    }
  }

  return {
    issue(input: {
      planText: string;
      source: ReviewBinding['source'];
    }): ReviewBinding {
      prune();
      const binding: ReviewBinding = {
        token: `rev_${randomUUID().replace(/-/g, '')}`,
        contentHash: hashPlanContent(input.planText),
        source: input.source,
        createdAtMs: Date.now(),
      };
      bindings.set(binding.token, binding);
      return binding;
    },

    get(token: string): ReviewBinding | undefined {
      prune();
      return bindings.get(token);
    },

    consume(token: string): ReviewBinding | undefined {
      prune();
      const binding = bindings.get(token);
      if (!binding) return undefined;
      bindings.delete(token);
      return binding;
    },

    clear(): void {
      bindings.clear();
    },
  };
}

export type ReviewTokenStore = ReturnType<typeof createReviewTokenStore>;

export function assertPlanUnchanged(expectedHash: string, planText: string): void {
  const actual = hashPlanContent(planText);
  if (actual !== expectedHash) {
    throw new Error(
      'Plan content changed after review. Call invoker_prepare_plan_review again and get a fresh approval.',
    );
  }
}
