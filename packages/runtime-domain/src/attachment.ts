export enum AttachmentResult {
  Attached = 'attached',
  Failed = 'failed',
}

export enum AttachmentFailureReason {
  TaskNotFound = 'task_not_found',
  TaskRunning = 'task_running',
  WorkspaceUnavailable = 'workspace_unavailable',
  ContainerUnavailable = 'container_unavailable',
  SessionUnavailable = 'session_unavailable',
  TerminalUnavailable = 'terminal_unavailable',
  Unsupported = 'unsupported',
  Unknown = 'unknown',
}

export interface AttachmentSuccess {
  result: AttachmentResult.Attached;
}

export interface AttachmentFailure {
  result: AttachmentResult.Failed;
  reason: AttachmentFailureReason;
  message?: string;
}

export type AttachmentOutcome = AttachmentSuccess | AttachmentFailure;
