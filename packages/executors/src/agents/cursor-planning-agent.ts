/**
 * CursorPlanningAgent — PlanningAgent implementation for Cursor's agent CLI.
 *
 * Extracted from plan-conversation.ts spawnCursor().
 */

import type { PlanningAgent } from '../agent.js';

export interface CursorPlanningAgentConfig {
  /** Command to invoke the Cursor CLI. Default: 'cursor'. */
  command?: string;
}

export class CursorPlanningAgent implements PlanningAgent {
  readonly name = 'cursor';

  private readonly command: string;

  constructor(config: CursorPlanningAgentConfig = {}) {
    this.command = config.command ?? 'cursor';
  }

  buildPlanningCommand(prompt: string): { command: string; args: string[] } {
    return {
      command: this.command,
      args: ['agent', '--print', '--trust', prompt],
    };
  }
}
