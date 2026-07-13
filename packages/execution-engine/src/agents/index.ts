/**
 * Agent barrel — re-exports and builtin registration.
 */

export { ClaudeExecutionAgent, type ClaudeExecutionAgentConfig } from './claude-execution-agent.js';
export { CodexExecutionAgent, type CodexExecutionAgentConfig } from './codex-execution-agent.js';
export { OmpExecutionAgent, type OmpExecutionAgentConfig } from './omp-execution-agent.js';
export { KimiExecutionAgent, type KimiExecutionAgentConfig } from './kimi-execution-agent.js';
export { QwenExecutionAgent, type QwenExecutionAgentConfig } from './qwen-execution-agent.js';
export { CursorPlanningAgent, type CursorPlanningAgentConfig } from './cursor-planning-agent.js';
export { OmpPlanningAgent, type OmpPlanningAgentConfig } from './omp-planning-agent.js';
export { CodexPlanningAgent, type CodexPlanningAgentConfig } from './codex-planning-agent.js';

import { AgentRegistry } from '../agent-registry.js';
import { ClaudeExecutionAgent, type ClaudeExecutionAgentConfig } from './claude-execution-agent.js';
import { CodexExecutionAgent, type CodexExecutionAgentConfig } from './codex-execution-agent.js';
import { OmpExecutionAgent, type OmpExecutionAgentConfig } from './omp-execution-agent.js';
import { KimiExecutionAgent, type KimiExecutionAgentConfig } from './kimi-execution-agent.js';
import { QwenExecutionAgent, type QwenExecutionAgentConfig } from './qwen-execution-agent.js';
import { CursorPlanningAgent, type CursorPlanningAgentConfig } from './cursor-planning-agent.js';
import { OmpPlanningAgent, type OmpPlanningAgentConfig } from './omp-planning-agent.js';
import { CodexPlanningAgent, type CodexPlanningAgentConfig } from './codex-planning-agent.js';
import { CodexSessionDriver } from '../codex-session-driver.js';
import { ClaudeSessionDriver } from '../claude-session-driver.js';
import { OmpSessionDriver } from '../omp-session-driver.js';

/**
 * Create an AgentRegistry pre-populated with builtin agents.
 */
export function registerBuiltinAgents(opts?: {
  claude?: ClaudeExecutionAgentConfig;
  codex?: CodexExecutionAgentConfig;
  omp?: OmpExecutionAgentConfig;
  kimi?: KimiExecutionAgentConfig;
  qwen?: QwenExecutionAgentConfig;
  cursor?: CursorPlanningAgentConfig;
  ompPlanning?: OmpPlanningAgentConfig;
  codexPlanning?: CodexPlanningAgentConfig;
}): AgentRegistry {
  const registry = new AgentRegistry();
  registry.registerExecution(new ClaudeExecutionAgent(opts?.claude), new ClaudeSessionDriver());
  registry.registerExecution(new CodexExecutionAgent(opts?.codex), new CodexSessionDriver());
  registry.registerExecution(new OmpExecutionAgent(opts?.omp), new OmpSessionDriver());
  registry.registerExecution(new KimiExecutionAgent(opts?.kimi));
  registry.registerExecution(new QwenExecutionAgent(opts?.qwen));
  registry.registerPlanning(new CursorPlanningAgent(opts?.cursor));
  registry.registerPlanning(new OmpPlanningAgent(opts?.ompPlanning));
  registry.registerPlanning(new CodexPlanningAgent(opts?.codexPlanning));
  return registry;
}
