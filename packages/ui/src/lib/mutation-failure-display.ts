import type { WorkflowMutationFailedEvent } from '@invoker/contracts';

export function mutationFailureTitle(event: WorkflowMutationFailedEvent): string {
  if (event.channel === 'invoker:approve') return 'Approve failed';
  if (event.channel === 'invoker:reject') return 'Reject failed';
  if (event.channel === 'invoker:fix-with-agent') return 'Fix failed';
  if (event.headlessCommand === 'fix') return 'Fix failed';
  if (event.headlessCommand === 'approve') return 'Approve failed';
  if (event.headlessCommand === 'reject') return 'Reject failed';
  return `Mutation failed (${event.channel})`;
}

