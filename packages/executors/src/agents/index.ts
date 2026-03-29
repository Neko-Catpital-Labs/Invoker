/**
 * Agent barrel — re-exports and builtin registration.
 */

export { ClaudeExecutionAgent, type ClaudeExecutionAgentConfig } from './claude-execution-agent.js';
export { CursorPlanningAgent, type CursorPlanningAgentConfig } from './cursor-planning-agent.js';

import { AgentRegistry } from '../agent-registry.js';
import { ClaudeExecutionAgent, type ClaudeExecutionAgentConfig } from './claude-execution-agent.js';
import { CursorPlanningAgent, type CursorPlanningAgentConfig } from './cursor-planning-agent.js';

/**
 * Create an AgentRegistry pre-populated with builtin agents.
 */
export function registerBuiltinAgents(opts?: {
  claude?: ClaudeExecutionAgentConfig;
  cursor?: CursorPlanningAgentConfig;
}): AgentRegistry {
  const registry = new AgentRegistry();
  registry.registerExecution(new ClaudeExecutionAgent(opts?.claude));
  registry.registerPlanning(new CursorPlanningAgent(opts?.cursor));
  return registry;
}
