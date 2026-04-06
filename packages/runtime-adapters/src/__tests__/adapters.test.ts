import { describe, it, expect } from 'vitest';
import { WorkspaceProbeAdapter } from '../workspace-probe.js';
import { ContainerProbeAdapter } from '../container-probe.js';
import { SessionProbeAdapter } from '../session-probe.js';

describe('WorkspaceProbeAdapter', () => {
  it('should return workspace path when available', async () => {
    const persistence = {
      getWorkspacePath: (taskId: string) => taskId === 'task-1' ? '/path/to/workspace' : null,
    };
    const probe = new WorkspaceProbeAdapter(persistence);

    const result = await probe.probeWorkspace('task-1');
    expect(result.workspacePath).toBe('/path/to/workspace');
  });

  it('should return undefined when workspace path not found', async () => {
    const persistence = {
      getWorkspacePath: () => null,
    };
    const probe = new WorkspaceProbeAdapter(persistence);

    const result = await probe.probeWorkspace('task-2');
    expect(result.workspacePath).toBeUndefined();
  });
});

describe('ContainerProbeAdapter', () => {
  it('should return container ID when available', async () => {
    const persistence = {
      getContainerId: (taskId: string) => taskId === 'task-1' ? 'container-123' : null,
    };
    const probe = new ContainerProbeAdapter(persistence);

    const result = await probe.probeContainer('task-1');
    expect(result.containerId).toBe('container-123');
  });

  it('should return undefined when container ID not found', async () => {
    const persistence = {
      getContainerId: () => null,
    };
    const probe = new ContainerProbeAdapter(persistence);

    const result = await probe.probeContainer('task-2');
    expect(result.containerId).toBeUndefined();
  });
});

describe('SessionProbeAdapter', () => {
  it('should return session ID and agent name when available', async () => {
    const persistence = {
      getAgentSessionId: (taskId: string) => taskId === 'task-1' ? 'session-123' : null,
      getExecutionAgent: (taskId: string) => taskId === 'task-1' ? 'claude' : null,
    };
    const probe = new SessionProbeAdapter(persistence);

    const result = await probe.probeSession('task-1');
    expect(result.sessionId).toBe('session-123');
    expect(result.agentName).toBe('claude');
  });

  it('should return undefined when session not found', async () => {
    const persistence = {
      getAgentSessionId: () => null,
      getExecutionAgent: () => null,
    };
    const probe = new SessionProbeAdapter(persistence);

    const result = await probe.probeSession('task-2');
    expect(result.sessionId).toBeUndefined();
    expect(result.agentName).toBeUndefined();
  });
});
