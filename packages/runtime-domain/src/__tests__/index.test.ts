import { describe, expect, it } from 'vitest';
import {
  AttachmentFailureReason,
  AttachmentResult,
  type TerminalLauncher,
  type WorkspaceProbe,
  type ContainerProbe,
  type SessionProbe,
} from '../index.js';

describe('@invoker/runtime-domain exports', () => {
  it('exports attachment enums', () => {
    expect(AttachmentResult.Attached).toBe('attached');
    expect(AttachmentResult.Failed).toBe('failed');
    expect(AttachmentFailureReason.TaskNotFound).toBe('task_not_found');
    expect(AttachmentFailureReason.Unknown).toBe('unknown');
  });

  it('defines probe and launcher interfaces (compile-time)', () => {
    const workspaceProbe: WorkspaceProbe = {
      probeWorkspace: async () => ({ workspacePath: '/tmp/worktree' }),
    };
    const containerProbe: ContainerProbe = {
      probeContainer: async () => ({ containerId: 'container-123' }),
    };
    const sessionProbe: SessionProbe = {
      probeSession: async () => ({ agentName: 'codex', sessionId: 'session-123' }),
    };
    const launcher: TerminalLauncher = {
      launchTerminal: async () => ({ result: AttachmentResult.Attached }),
    };

    expect(workspaceProbe).toBeDefined();
    expect(containerProbe).toBeDefined();
    expect(sessionProbe).toBeDefined();
    expect(launcher).toBeDefined();
  });
});
