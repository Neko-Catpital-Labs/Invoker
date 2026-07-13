import type { Workflow } from '@invoker/data-store';

export type WorkflowLister = () => Workflow[];

export interface StartupWorkflowCache {
  set(workflows: readonly Workflow[]): void;
  takeOrLoad(fallback: WorkflowLister): Workflow[];
  invalidate(): void;
  hasCached(): boolean;
}

export function createStartupWorkflowCache(): StartupWorkflowCache {
  let cached: readonly Workflow[] | null = null;

  return {
    set(workflows) {
      cached = workflows;
    },
    takeOrLoad(fallback) {
      if (cached === null) {
        return fallback();
      }
      const snapshot = cached;
      cached = null;
      return [...snapshot];
    },
    invalidate() {
      cached = null;
    },
    hasCached() {
      return cached !== null;
    },
  };
}
