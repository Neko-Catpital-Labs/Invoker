import type { ContainerProbe, ContainerProbeResult } from '@invoker/runtime-domain';

/** Minimal persistence interface for container probe */
export interface ContainerPersistence {
  getContainerId(taskId: string): string | null;
}

/**
 * Container probe adapter - queries persisted container ID for a task.
 */
export class ContainerProbeAdapter implements ContainerProbe {
  constructor(private persistence: ContainerPersistence) {}

  async probeContainer(taskId: string): Promise<ContainerProbeResult> {
    const containerId = this.persistence.getContainerId(taskId);
    return { containerId: containerId ?? undefined };
  }
}
