import type { AttachmentOutcome } from './attachment.js';

export interface WorkspaceProbeResult {
  workspacePath?: string;
}

export interface ContainerProbeResult {
  containerId?: string;
}

export interface SessionProbeResult {
  agentName?: string;
  sessionId?: string;
}

export interface TerminalLaunchRequest {
  taskId: string;
  workspacePath?: string;
  containerId?: string;
  sessionId?: string;
  agentName?: string;
}

export interface WorkspaceProbe {
  probeWorkspace(taskId: string): Promise<WorkspaceProbeResult>;
}

export interface ContainerProbe {
  probeContainer(taskId: string): Promise<ContainerProbeResult>;
}

export interface SessionProbe {
  probeSession(taskId: string): Promise<SessionProbeResult>;
}

export interface TerminalLauncher {
  launchTerminal(request: TerminalLaunchRequest): Promise<AttachmentOutcome>;
}
