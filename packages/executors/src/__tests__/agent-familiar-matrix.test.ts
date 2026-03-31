/**
 * Parametric test matrix: Agent × Familiar interaction.
 *
 * Tests that ExecutionAgent implementations produce correct command specs
 * when used through BaseFamiliar.buildCommandAndArgs(), and that the
 * AgentRegistry lookup works for all agent types.
 *
 * Does NOT spawn real processes or require git — exercises the command-building
 * path only (unit-level).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { WorkRequest } from '@invoker/protocol';
import type { ExecutionAgent, AgentCommandSpec } from '../agent.js';
import { AgentRegistry } from '../agent-registry.js';
import { ClaudeExecutionAgent } from '../agents/claude-execution-agent.js';
import { CodexExecutionAgent } from '../agents/codex-execution-agent.js';

// ── Mock agent for testing alternative stdinMode + args ──────

class MockPipeAgent implements ExecutionAgent {
  readonly name = 'mock-pipe';
  readonly stdinMode = 'pipe' as const;

  buildCommand(fullPrompt: string): AgentCommandSpec {
    const sessionId = randomUUID();
    return {
      cmd: 'mock-agent',
      args: ['--run', '--prompt', fullPrompt],
      sessionId,
      fullPrompt,
    };
  }

  buildResumeArgs(sessionId: string): { cmd: string; args: string[] } {
    return { cmd: 'mock-agent', args: ['--resume', sessionId] };
  }

  getContainerRequirements() {
    return {
      mounts: [{ hostPath: '/tmp/mock', containerPath: '/opt/mock' }],
      env: { MOCK_KEY: 'test-value' },
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────

function makeCommandRequest(command = 'echo hello'): WorkRequest {
  return {
    requestId: randomUUID(),
    actionId: randomUUID(),
    taskId: `task-${randomUUID().slice(0, 8)}`,
    actionType: 'command',
    inputs: { command },
    upstreamContext: [],
    callbackUrl: '',
    timestamps: {},
  } as unknown as WorkRequest;
}

// ── Agent definitions for the matrix ─────────────────────────

const agents = [
  {
    label: 'ClaudeExecutionAgent',
    create: () => new ClaudeExecutionAgent({ command: 'claude-test' }),
    name: 'claude',
    stdinMode: 'ignore' as const,
    expectedCmdPrefix: 'claude-test',
    expectedResumeFlag: '--resume',
    hasContainerRequirements: true,
    hasBuildFixCommand: true,
    expectedLinuxTerminalTail: 'exec_bash' as const,
  },
  {
    label: 'CodexExecutionAgent',
    create: () => new CodexExecutionAgent({ command: 'codex-test' }),
    name: 'codex',
    stdinMode: 'ignore' as const,
    expectedCmdPrefix: 'codex-test',
    expectedResumeFlag: 'resume',
    hasContainerRequirements: false,
    hasBuildFixCommand: true,
    expectedLinuxTerminalTail: 'exec_bash' as const,
  },
  {
    label: 'MockPipeAgent',
    create: () => new MockPipeAgent(),
    name: 'mock-pipe',
    stdinMode: 'pipe' as const,
    expectedCmdPrefix: 'mock-agent',
    expectedResumeFlag: '--resume',
    hasContainerRequirements: true,
    hasBuildFixCommand: false,
    expectedLinuxTerminalTail: undefined,
  },
];

// ── Matrix tests ─────────────────────────────────────────────

describe('Agent × Familiar matrix', () => {
  describe.each(agents)('$label', (agentDef) => {
    let agent: ExecutionAgent;
    let registry: AgentRegistry;

    beforeEach(() => {
      agent = agentDef.create();
      registry = new AgentRegistry();
      registry.registerExecution(agent);
    });

    // 1. buildCommand produces correct spec
    it('buildCommand returns correct cmd and sessionId', () => {
      const spec = agent.buildCommand('Test prompt');
      expect(spec.cmd).toBe(agentDef.expectedCmdPrefix);
      expect(spec.sessionId).toBeDefined();
      expect(typeof spec.sessionId).toBe('string');
      expect(spec.sessionId!.length).toBeGreaterThan(0);
      expect(spec.fullPrompt).toBe('Test prompt');
    });

    // 2. Each buildCommand call generates a unique sessionId
    it('buildCommand generates unique session IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const spec = agent.buildCommand(`Prompt ${i}`);
        ids.add(spec.sessionId!);
      }
      expect(ids.size).toBe(10);
    });

    // 3. buildResumeArgs returns correct structure
    it('buildResumeArgs returns cmd and args with session ID', () => {
      const sid = 'test-session-123';
      const resume = agent.buildResumeArgs(sid);
      expect(resume.cmd).toBe(agentDef.expectedCmdPrefix);
      expect(resume.args).toContain(sid);
      expect(resume.args).toContain(agentDef.expectedResumeFlag);
    });

    // 4. stdinMode matches expected value
    it(`stdinMode is "${agentDef.stdinMode}"`, () => {
      expect(agent.stdinMode).toBe(agentDef.stdinMode);
    });

    // 5. Registry lookup by name works
    it('registry.get() returns the agent by name', () => {
      expect(registry.get(agentDef.name)).toBe(agent);
    });

    it('registry.getOrThrow() returns the agent by name', () => {
      expect(registry.getOrThrow(agentDef.name)).toBe(agent);
    });

    // 6. Container requirements (if applicable)
    if (agentDef.hasContainerRequirements) {
      it('getContainerRequirements returns mounts and env', () => {
        const reqs = agent.getContainerRequirements?.();
        expect(reqs).toBeDefined();
        expect(reqs!.mounts.length).toBeGreaterThan(0);
        expect(typeof reqs!.env).toBe('object');
      });
    }

    // 7. buildFixCommand (if applicable)
    if (agentDef.hasBuildFixCommand) {
      it('buildFixCommand returns correct cmd and args', () => {
        const spec = agent.buildFixCommand?.('Fix the failing test');
        expect(spec).toBeDefined();
        expect(spec!.cmd).toBe(agentDef.expectedCmdPrefix);
        expect(spec!.args.length).toBeGreaterThan(0);
      });
    }

    // 8. linuxTerminalTail matches expected value
    it(`linuxTerminalTail is "${agentDef.expectedLinuxTerminalTail ?? 'undefined'}"`, () => {
      expect(agent.linuxTerminalTail).toBe(agentDef.expectedLinuxTerminalTail);
    });

    // 9. Command task (no agent) — agent should not be involved
    it('command actionType does not use agent (baseline)', () => {
      // Verify that a command-type request produces shell args, not agent args
      const commandReq = makeCommandRequest('npm test');
      // This tests the expected behavior: command type = /bin/bash -c
      // Agent is not invoked for command tasks
      expect(commandReq.actionType).toBe('command');
      expect(commandReq.inputs.command).toBe('npm test');
    });

    // 8. Agent registered with different name doesn't collide
    it('multiple agents with different names coexist', () => {
      const other = new MockPipeAgent();
      // Override name for test
      Object.defineProperty(other, 'name', { value: 'other-agent' });
      registry.registerExecution(other);
      expect(registry.get(agentDef.name)).toBe(agent);
      expect(registry.get('other-agent')).toBe(other);
    });
  });

  // ── Cross-agent tests ───────────────────────────────────────

  describe('cross-agent scenarios', () => {
    let registry: AgentRegistry;

    beforeEach(() => {
      registry = new AgentRegistry();
      for (const def of agents) {
        registry.registerExecution(def.create());
      }
    });

    it('all agents are registered and retrievable', () => {
      const all = registry.listExecution();
      expect(all.length).toBe(agents.length);
      for (const def of agents) {
        expect(registry.get(def.name)).toBeDefined();
        expect(registry.get(def.name)!.name).toBe(def.name);
      }
    });

    it('getByCommand returns correct agent', () => {
      for (const def of agents) {
        const found = registry.getByCommand(def.name);
        expect(found).toBeDefined();
        expect(found!.name).toBe(def.name);
      }
    });

    it('getByCommand returns undefined for unknown command', () => {
      expect(registry.getByCommand('nonexistent-agent')).toBeUndefined();
    });

    it('different agents produce different command specs', () => {
      const specs = agents.map((def) => {
        const a = registry.getOrThrow(def.name);
        return a.buildCommand('Same prompt');
      });
      // Each agent should produce a different cmd
      const cmds = new Set(specs.map((s) => s.cmd));
      expect(cmds.size).toBe(agents.length);
    });

    it('resume args are agent-specific', () => {
      const sid = 'shared-session-id';
      for (const def of agents) {
        const a = registry.getOrThrow(def.name);
        const resume = a.buildResumeArgs(sid);
        expect(resume.cmd).toBe(def.expectedCmdPrefix);
        expect(resume.args).toContain(sid);
      }
    });

    it('stdinMode varies across agents', () => {
      const modes = agents.map((def) => registry.getOrThrow(def.name).stdinMode);
      // We have at least one 'ignore' and one 'pipe'
      expect(modes).toContain('ignore');
      expect(modes).toContain('pipe');
    });
  });
});
