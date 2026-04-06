import type { WorkspaceProbe, WorkspaceProbeResult } from '@invoker/runtime-domain';

/** Minimal persistence interface for workspace probe */
export interface WorkspacePersistence {
  getWorkspacePath(taskId: string): string | null;
}

/**
 * Workspace probe adapter - queries persisted workspace path for a task.
 */
export class WorkspaceProbeAdapter implements WorkspaceProbe {
  constructor(private persistence: WorkspacePersistence) {}

  async probeWorkspace(taskId: string): Promise<WorkspaceProbeResult> {
    const workspacePath = this.persistence.getWorkspacePath(taskId);
    return { workspacePath: workspacePath ?? undefined };
  }
}
