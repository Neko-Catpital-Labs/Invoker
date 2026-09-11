import type { SurfaceEvent, WorkflowProgress, WorkflowStatus } from '@invoker/surfaces';

export function formatWorkflowStatus(status: WorkflowStatus, workflowId?: string): string {
  return [
    `**Workflow status${workflowId ? ` · \`${workflowId}\`` : ''}**`,
    `Total: ${status.total} · Completed: ${status.completed} · Running: ${status.running} · Pending: ${status.pending} · Failed: ${status.failed} · Closed: ${status.closed}`,
  ].join('\n');
}

export function formatWorkflowProgress(progress: WorkflowProgress): string {
  const { counts } = progress;
  return [
    `**${progress.name}** ${progress.percentComplete}% · ${counts.completed} done · ${counts.running} running · ${counts.pending} pending · ${counts.failed} failed`,
    ...progress.tasks.map((task) => `• \`${task.id}\` ${task.status}${task.phase ? ` (${task.phase})` : ''}`),
    ...(progress.prUrl ? [`PR: ${progress.prUrl}`] : []),
  ].join('\n');
}

export function formatSurfaceEventText(event: SurfaceEvent): string | null {
  switch (event.type) {
    case 'workflow_status':
      return formatWorkflowStatus(event.status, event.workflowId);
    case 'workflow_progress':
      return formatWorkflowProgress(event.progress);
    case 'alert':
      return `**${event.severity.toUpperCase()}** · ${event.source} · ${event.subject}\n${event.message}`;
    case 'error':
      return `Error: ${event.message}`;
    case 'task_delta': {
      const delta = event.delta;
      if (delta.type === 'created') return `Task \`${delta.task.id}\` created: ${delta.task.description}`;
      if (delta.type !== 'updated') return null;
      const status = (delta.changes.status as string | undefined) ?? (delta.changes.execution?.phase ? 'running' : undefined);
      if (!status) return null;
      const error = delta.changes.execution?.error as string | undefined;
      return `Task \`${delta.taskId}\`: ${status}${error ? `\n${error}` : ''}`;
    }
    case 'workflow_created':
      return null;
  }
}
