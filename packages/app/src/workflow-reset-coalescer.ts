/**
 * Coalesce concurrent workflow reset intents (recreate/rebase family) per workflow.
 *
 * If a reset is already in-flight for a workflow, subsequent callers wait for the
 * same promise and receive `coalesced: true`.
 */

const inflightByWorkflow = new Map<string, Promise<unknown>>();

export async function withCoalescedWorkflowReset<T>(
  workflowId: string,
  run: () => Promise<T>,
): Promise<{ coalesced: boolean; value: T }> {
  const existing = inflightByWorkflow.get(workflowId) as Promise<T> | undefined;
  if (existing) {
    const value = await existing;
    return { coalesced: true, value };
  }

  const promise = (async () => run())();
  inflightByWorkflow.set(workflowId, promise);

  try {
    const value = await promise;
    return { coalesced: false, value };
  } finally {
    if (inflightByWorkflow.get(workflowId) === promise) {
      inflightByWorkflow.delete(workflowId);
    }
  }
}
