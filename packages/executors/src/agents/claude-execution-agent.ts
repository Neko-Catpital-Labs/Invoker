/**
 * ClaudeExecutionAgent — ExecutionAgent implementation for Anthropic's Claude CLI.
 *
 * Extracted from BaseFamiliar.buildClaudeArgs() / prepareClaudeSession().
 * Agents provide command specs; familiars own the spawn lifecycle.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ExecutionAgent, AgentCommandSpec } from '../agent.js';

export interface ClaudeExecutionAgentConfig {
  /** Command to invoke the Claude CLI. Default: 'claude'. */
  command?: string;
  /** Path to the Claude config directory on the host. Default: ~/.claude. */
  configDir?: string;
  /** Home directory inside Docker containers. Default: '/home/invoker'. */
  containerHomePath?: string;
  /** ANTHROPIC_API_KEY. Falls back to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
}

export class ClaudeExecutionAgent implements ExecutionAgent {
  readonly name = 'claude';
  readonly stdinMode = 'ignore' as const;
  readonly linuxTerminalTail = 'exec_bash' as const;

  private readonly command: string;
  private readonly configDir: string;
  private readonly containerHomePath: string;
  private readonly apiKey: string;

  constructor(config: ClaudeExecutionAgentConfig = {}) {
    this.command = config.command ?? 'claude';
    this.configDir = config.configDir ?? join(homedir(), '.claude');
    this.containerHomePath = config.containerHomePath ?? '/home/invoker';
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  }

  buildCommand(fullPrompt: string): AgentCommandSpec {
    const sessionId = randomUUID();
    return {
      cmd: this.command,
      args: ['--session-id', sessionId, '--dangerously-skip-permissions', '-p', fullPrompt],
      sessionId,
      fullPrompt,
    };
  }

  buildFixCommand(prompt: string): AgentCommandSpec {
    return {
      cmd: this.command,
      args: ['-p', prompt, '--dangerously-skip-permissions'],
    };
  }

  buildResumeArgs(sessionId: string): { cmd: string; args: string[] } {
    return {
      cmd: this.command,
      args: ['--resume', sessionId, '--dangerously-skip-permissions'],
    };
  }

  getContainerRequirements(): {
    mounts: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
    env: Record<string, string>;
  } {
    const containerClaudeDir = join(this.containerHomePath, '.claude');
    const mounts: Array<{ hostPath: string; containerPath: string; readonly?: boolean }> = [
      { hostPath: this.configDir, containerPath: containerClaudeDir },
    ];

    const claudeJsonPath = join(homedir(), '.claude.json');
    mounts.push({
      hostPath: claudeJsonPath,
      containerPath: join(containerClaudeDir, '.claude.json'),
      readonly: true,
    });

    return {
      mounts,
      env: {
        ANTHROPIC_API_KEY: this.apiKey,
      },
    };
  }
}
