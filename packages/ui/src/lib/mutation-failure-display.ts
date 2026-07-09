import type { WorkflowMutationFailedEvent } from '@invoker/contracts';

const HEADLESS_COMMAND_LABELS: Record<string, string> = {
  fix: 'Fix failed',
  approve: 'Approve failed',
  reject: 'Reject failed',
  'resolve-conflict': 'Resolve conflict failed',
  cancel: 'Cancel failed',
  'retry-task': 'Retry failed',
  'recreate-task': 'Recreate task failed',
  'delete-task': 'Delete task failed',
};

export function mutationFailureTitle(event: WorkflowMutationFailedEvent): string {
  if (event.channel === 'invoker:approve') return 'Approve failed';
  if (event.channel === 'invoker:reject') return 'Reject failed';
  if (event.channel === 'invoker:fix-with-agent') return 'Fix failed';
  if (event.headlessCommand) {
    const label = HEADLESS_COMMAND_LABELS[event.headlessCommand];
    if (label) return label;
  }
  return `Mutation failed (${event.channel})`;
}

export function mutationFailureHasTaskTarget(
  event: WorkflowMutationFailedEvent,
): boolean {
  return Boolean(event.taskId);
}

export function mutationFailureBannerMessage(
  event: WorkflowMutationFailedEvent,
): string {
  if (mutationFailureHasTaskTarget(event)) {
    return 'See the task panel for details.';
  }
  return summarizeBannerMessage(event.message);
}

function summarizeBannerMessage(message: string): string {
  let text = message.replace(/^Error:\s*/, '').trim();
  const stackIdx = text.indexOf('\n    at ');
  if (stackIdx >= 0) text = text.slice(0, stackIdx).trim();
  const firstLine = text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? text;
  if (firstLine.length <= 160) return firstLine;
  return `${firstLine.slice(0, 159).trimEnd()}…`;
}
