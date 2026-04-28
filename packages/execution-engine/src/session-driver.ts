/**
 * SessionDriver — post-execution session processing, separate from ExecutionAgent.
 *
 * Agents say what to run. Drivers handle what happens to the output after exit.
 * Co-registered alongside the agent via AgentRegistry.registerExecution().
 */

import type { AgentMessage } from './codex-session.js';

export interface RemoteTarget {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
}

export type AgentSessionState = 'running' | 'finished' | 'error';

export interface AgentSessionInspection {
  state: AgentSessionState;
  reason?: string;
}

export interface SessionDriver {
  /** Post-exit: store raw stdout and return human-readable text for callers. */
  processOutput(sessionId: string, rawStdout: string): string;
  /** Load stored session content by ID for viewing. */
  loadSession(sessionId: string): string | null;
  /** Parse stored session content into displayable messages. */
  parseSession(raw: string): AgentMessage[];
  /** Inspect a stored session and infer a small lifecycle state. */
  inspectSession(raw: string): AgentSessionInspection;
  /** Extract the real backend session/thread ID from raw stdout (e.g. codex thread ID for resume). */
  extractSessionId?(rawStdout: string): string | undefined;
  /** Fetch session from a remote SSH host. Returns raw content or null. */
  fetchRemoteSession?(sessionId: string, target: RemoteTarget): Promise<string | null>;
}
