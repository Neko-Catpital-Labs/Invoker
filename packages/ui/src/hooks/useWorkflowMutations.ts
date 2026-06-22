import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkflowMutationAcceptedResult, WorkflowMutationStatusEntry } from '@invoker/contracts';

const HIGH_PRIORITY_CHANNELS: Record<string, true> = {
  'invoker:delete-workflow': true,
  'invoker:detach-workflow': true,
  'invoker:restart-task': true,
  'invoker:cancel-task': true,
  'invoker:cancel-workflow': true,
  'invoker:replace-task': true,
  'invoker:recreate-workflow': true,
  'invoker:recreate-task': true,
  'invoker:recreate-downstream': true,
  'invoker:retry-workflow': true,
  'invoker:rebase-retry': true,
  'invoker:rebase-recreate': true,
};

function newestFirst(a: WorkflowMutationStatusEntry, b: WorkflowMutationStatusEntry): number {
  return b.intentId - a.intentId;
}

export function useWorkflowMutations(pollMs = 2000): {
  mutations: WorkflowMutationStatusEntry[];
  mutationsByWorkflow: Map<string, WorkflowMutationStatusEntry[]>;
  recordAcceptedMutation: (accepted: WorkflowMutationAcceptedResult | undefined | void) => void;
  refreshWorkflowMutations: () => Promise<void>;
} {
  const [mutations, setMutations] = useState<WorkflowMutationStatusEntry[]>([]);

  const refreshWorkflowMutations = useCallback(async () => {
    try {
      const rows = await window.invoker?.getWorkflowMutationStatuses?.();
      if (rows) {
        setMutations([...rows].sort(newestFirst));
      }
    } catch {
      // ignore polling errors
    }
  }, []);

  useEffect(() => {
    void refreshWorkflowMutations();
    const interval = window.setInterval(() => {
      void refreshWorkflowMutations();
    }, pollMs);
    return () => window.clearInterval(interval);
  }, [pollMs, refreshWorkflowMutations]);

  const recordAcceptedMutation = useCallback((accepted: WorkflowMutationAcceptedResult | undefined | void) => {
    if (!accepted?.accepted) return;

    const entry: WorkflowMutationStatusEntry = {
      intentId: accepted.intentId,
      workflowId: accepted.workflowId,
      channel: accepted.channel,
      label: accepted.label,
      status: 'queued',
      priority: HIGH_PRIORITY_CHANNELS[accepted.channel] ? 'high' : 'normal',
      createdAt: new Date().toISOString(),
      args: [],
    };

    setMutations((current) => {
      const withoutExisting = current.filter((row) => row.intentId !== entry.intentId);
      return [entry, ...withoutExisting].sort(newestFirst);
    });
  }, []);

  const mutationsByWorkflow = useMemo(() => {
    const grouped = new Map<string, WorkflowMutationStatusEntry[]>();
    for (const mutation of mutations) {
      const rows = grouped.get(mutation.workflowId) ?? [];
      rows.push(mutation);
      grouped.set(mutation.workflowId, rows);
    }
    for (const rows of grouped.values()) {
      rows.sort(newestFirst);
    }
    return grouped;
  }, [mutations]);

  return {
    mutations,
    mutationsByWorkflow,
    recordAcceptedMutation,
    refreshWorkflowMutations,
  };
}
