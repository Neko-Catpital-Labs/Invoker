import type {
  TerminalLauncher,
  TerminalLaunchRequest,
  AttachmentOutcome,
} from '@invoker/runtime-domain';
import { AttachmentResult, AttachmentFailureReason } from '@invoker/runtime-domain';
import {
  buildLinuxXTerminalBashScript,
  buildMacOSOsascriptArgs,
  spawnDetachedTerminal,
} from './terminal-launch.js';

/**
 * Terminal launcher adapter - launches external OS terminal for a task.
 * Platform-specific implementation (macOS Terminal.app / Linux x-terminal-emulator).
 */
export class TerminalLauncherAdapter implements TerminalLauncher {
  constructor(
    private options: {
      platform?: NodeJS.Platform;
      onTerminalClose?: (taskId: string) => void;
    } = {},
  ) {}

  async launchTerminal(request: TerminalLaunchRequest): Promise<AttachmentOutcome> {
    const { taskId, workspacePath, sessionId, agentName } = request;
    const platform = this.options.platform ?? process.platform;

    if (!workspacePath) {
      return {
        result: AttachmentResult.Failed,
        reason: AttachmentFailureReason.WorkspaceUnavailable,
        message: `Cannot launch terminal for task "${taskId}": workspace path not available`,
      };
    }

    const spec: { cwd?: string; command?: string; args?: string[] } = { cwd: workspacePath };

    // Build command spec for agent resume if session available
    if (sessionId && agentName) {
      spec.command = agentName;
      spec.args = ['--resume', sessionId];
    }

    const onClose = () => {
      this.options.onTerminalClose?.(taskId);
    };

    let result;
    if (platform === 'linux') {
      const cleanEnv: Record<string, string> = {};
      const keep = [
        'HOME', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY',
        'SHELL', 'USER', 'TERM', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'LANG',
        'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY',
      ];
      for (const k of keep) {
        if (process.env[k]) cleanEnv[k] = process.env[k]!;
      }
      cleanEnv.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
      if (!cleanEnv.TERM) cleanEnv.TERM = 'xterm-256color';

      const bashScript = buildLinuxXTerminalBashScript(spec, workspacePath);
      const termArgs = ['-e', 'bash', '-c', bashScript];
      result = await spawnDetachedTerminal('x-terminal-emulator', termArgs, { env: cleanEnv }, onClose);
    } else if (platform === 'darwin') {
      if (spec.command) {
        const osaArgs = buildMacOSOsascriptArgs(spec, workspacePath);
        result = await spawnDetachedTerminal('osascript', osaArgs, {}, onClose);
      } else {
        result = await spawnDetachedTerminal('open', ['-a', 'Terminal', workspacePath], {}, onClose);
      }
    } else {
      return {
        result: AttachmentResult.Failed,
        reason: AttachmentFailureReason.Unsupported,
        message: `External terminal is not supported on platform: ${platform}`,
      };
    }

    if (result.opened) {
      return { result: AttachmentResult.Attached };
    } else {
      return {
        result: AttachmentResult.Failed,
        reason: AttachmentFailureReason.TerminalUnavailable,
        message: result.reason ?? 'Failed to launch terminal',
      };
    }
  }
}
