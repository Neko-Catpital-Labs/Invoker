import type { SessionProbe, SessionProbeResult } from '@invoker/runtime-domain';

/** Minimal persistence interface for session probe */
export interface SessionPersistence {
  getAgentSessionId(taskId: string): string | null;
  getExecutionAgent?(taskId: string): string | null;
}

/**
 * Session probe adapter - queries persisted agent session ID and execution agent for a task.
 */
export class SessionProbeAdapter implements SessionProbe {
  constructor(private persistence: SessionPersistence) {}

  async probeSession(taskId: string): Promise<SessionProbeResult> {
    const sessionId = this.persistence.getAgentSessionId(taskId);
    const agentName = this.persistence.getExecutionAgent?.(taskId);
    return {
      sessionId: sessionId ?? undefined,
      agentName: agentName ?? undefined,
    };
  }
}
