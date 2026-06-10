import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentResult } from '@invoker/runtime-domain';
import { TerminalLauncherAdapter } from '../terminal-launcher.js';
import {
  buildMacOSOsascriptArgs,
  spawnDetachedTerminal,
} from '../terminal-launch.js';

vi.mock('../terminal-launch.js', () => ({
  buildLinuxXTerminalBashScript: vi.fn(() => 'cd /tmp && codex resume'),
  buildMacOSOsascriptArgs: vi.fn(() => ['-e', 'do script']),
  spawnDetachedTerminal: vi.fn(async () => ({ opened: true })),
}));

describe('TerminalLauncherAdapter', () => {
  beforeEach(() => {
    vi.mocked(buildMacOSOsascriptArgs).mockClear();
    vi.mocked(spawnDetachedTerminal).mockClear();
  });

  it('uses the injected resolver for agent resume commands', async () => {
    const launcher = new TerminalLauncherAdapter({
      platform: 'darwin',
      resumeCommandResolver: (agentName, sessionId) => ({
        command: agentName,
        args: ['resume', '--dangerously-bypass-approvals-and-sandbox', sessionId],
      }),
    });

    const result = await launcher.launchTerminal({
      taskId: 'task-codex',
      workspacePath: '/tmp/workspace',
      agentName: 'codex',
      sessionId: 'codex-session',
    });

    expect(result.result).toBe(AttachmentResult.Attached);
    expect(buildMacOSOsascriptArgs).toHaveBeenCalledWith(
      {
        cwd: '/tmp/workspace',
        command: 'codex',
        args: ['resume', '--dangerously-bypass-approvals-and-sandbox', 'codex-session'],
      },
      '/tmp/workspace',
    );
  });

  it('keeps the legacy fallback when no resolver is configured', async () => {
    const launcher = new TerminalLauncherAdapter({ platform: 'darwin' });

    await launcher.launchTerminal({
      taskId: 'task-claude',
      workspacePath: '/tmp/workspace',
      agentName: 'claude',
      sessionId: 'claude-session',
    });

    expect(buildMacOSOsascriptArgs).toHaveBeenCalledWith(
      {
        cwd: '/tmp/workspace',
        command: 'claude',
        args: ['--resume', 'claude-session'],
      },
      '/tmp/workspace',
    );
  });
});
