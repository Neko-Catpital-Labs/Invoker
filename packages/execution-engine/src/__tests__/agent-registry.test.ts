import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from '../agent-registry.js';
import { registerBuiltinAgents } from '../agents/index.js';
import type { ExecutionAgent } from '../agent.js';

function makeExecutionAgent(name: string, opts?: {
  bundledSkillRoot?: string;
  bundledSkills?: readonly string[];
}): ExecutionAgent {
  return {
    name,
    buildCommand: () => ({ cmd: name, args: [] }),
    buildResumeArgs: (sessionId: string) => ({ cmd: name, args: ['resume', sessionId] }),
    buildFixCommand: (prompt: string) => ({ cmd: name, args: ['fix', prompt] }),
    stdinMode: 'pipe',
    ...(opts?.bundledSkillRoot !== undefined && { bundledSkillRoot: opts.bundledSkillRoot }),
    ...(opts?.bundledSkills !== undefined && { bundledSkills: opts.bundledSkills }),
  };
}

describe('registerBuiltinAgents', () => {
  it('registers claude, codex, and omp execution agents', () => {
    const names = registerBuiltinAgents().listExecution().map((agent) => agent.name);
    expect(names).toEqual(expect.arrayContaining(['claude', 'codex', 'omp']));
  });
});

describe('AgentRegistry', () => {
  let registry: AgentRegistry;
  let claude: ExecutionAgent;
  let codex: ExecutionAgent;

  beforeEach(() => {
    registry = new AgentRegistry();
    claude = makeExecutionAgent('claude');
    codex = makeExecutionAgent('codex');
    registry.registerExecution(claude);
    registry.registerExecution(codex);
  });

  it('defaults nullish execution agent names to claude', () => {
    expect(registry.getOrThrow(undefined)).toBe(claude);
    expect(registry.getOrThrow(null)).toBe(claude);
    expect(registry.getOrThrow('')).toBe(claude);
    expect(registry.getOrThrow('   ')).toBe(claude);
    expect(registry.getOrThrow('null')).toBe(claude);
    expect(registry.getOrThrow('undefined')).toBe(claude);
  });

  it('keeps explicit valid execution agent names working', () => {
    expect(registry.getOrThrow('codex')).toBe(codex);
    expect(registry.getOrThrow(' codex ')).toBe(codex);
  });

  it('still throws for real unknown execution agent names', () => {
    expect(() => registry.getOrThrow('cluade')).toThrow(
      'No execution agent registered with name "cluade". Available: [claude, codex]',
    );
  });

  describe('capability lookup', () => {
    let prClaude: ExecutionAgent;
    let prCodex: ExecutionAgent;
    let noCapsAgent: ExecutionAgent;
    let capRegistry: AgentRegistry;

    beforeEach(() => {
      capRegistry = new AgentRegistry();
      prClaude = makeExecutionAgent('claude', {
        bundledSkillRoot: '/home/user/.claude/skills',
        bundledSkills: ['make-pr'],
      });
      prCodex = makeExecutionAgent('codex', {
        bundledSkillRoot: '/home/user/.codex/skills',
        bundledSkills: ['make-pr'],
      });
      noCapsAgent = makeExecutionAgent('bare-agent');
      capRegistry.registerExecution(prClaude);
      capRegistry.registerExecution(prCodex);
      capRegistry.registerExecution(noCapsAgent);
    });

    it('getWithCapability returns the first agent registered with the skill', () => {
      const agent = capRegistry.getWithCapability('make-pr');
      expect(agent).toBe(prClaude);
    });

    it('getWithCapability is deterministic across repeated calls', () => {
      const first = capRegistry.getWithCapability('make-pr');
      const second = capRegistry.getWithCapability('make-pr');
      expect(first).toBe(second);
    });

    it('getWithCapability returns undefined for unknown skills', () => {
      expect(capRegistry.getWithCapability('deploy')).toBeUndefined();
    });

    it('getWithCapability skips agents without bundledSkills', () => {
      // Register only an agent without capabilities
      const minimal = new AgentRegistry();
      minimal.registerExecution(noCapsAgent);
      expect(minimal.getWithCapability('make-pr')).toBeUndefined();
    });

    it('listWithCapability returns all agents that bundle the skill', () => {
      const agents = capRegistry.listWithCapability('make-pr');
      expect(agents).toHaveLength(2);
      expect(agents[0]).toBe(prClaude);
      expect(agents[1]).toBe(prCodex);
    });

    it('listWithCapability returns empty array for unknown skills', () => {
      expect(capRegistry.listWithCapability('deploy')).toEqual([]);
    });

    it('listWithCapability excludes agents without bundledSkills', () => {
      const agents = capRegistry.listWithCapability('make-pr');
      expect(agents).not.toContain(noCapsAgent);
    });

    it('bundledSkillRoot resolves only for PR-capable agents', () => {
      // PR-capable agents expose their skill root
      expect(prClaude.bundledSkillRoot).toBe('/home/user/.claude/skills');
      expect(prCodex.bundledSkillRoot).toBe('/home/user/.codex/skills');
      // Agent without capabilities has no skill root
      expect(noCapsAgent.bundledSkillRoot).toBeUndefined();
    });

    it('registration order determines getWithCapability winner', () => {
      // Register codex first in a fresh registry
      const reversed = new AgentRegistry();
      reversed.registerExecution(prCodex);
      reversed.registerExecution(prClaude);
      expect(reversed.getWithCapability('make-pr')).toBe(prCodex);
    });
    it('listWithCapability preserves stable insertion order for fallback chains', () => {
      // The PR-authoring pipeline builds a fallback chain from this list.
      // Order must be deterministic and match registration order.
      const reg = new AgentRegistry();
      const a = makeExecutionAgent('alpha', { bundledSkills: ['make-pr'] });
      const b = makeExecutionAgent('bravo', { bundledSkills: ['make-pr'] });
      const c = makeExecutionAgent('charlie', { bundledSkills: ['make-pr'] });
      reg.registerExecution(b);
      reg.registerExecution(a);
      reg.registerExecution(c);

      const agents = reg.listWithCapability('make-pr');
      expect(agents.map((ag) => ag.name)).toEqual(['bravo', 'alpha', 'charlie']);
      // Repeated calls produce the same order
      expect(reg.listWithCapability('make-pr').map((ag) => ag.name)).toEqual(['bravo', 'alpha', 'charlie']);
    });

    it('listWithCapability returns empty when all agents lack the skill', () => {
      const reg = new AgentRegistry();
      reg.registerExecution(makeExecutionAgent('agent-a'));
      reg.registerExecution(makeExecutionAgent('agent-b', { bundledSkills: ['deploy'] }));
      expect(reg.listWithCapability('make-pr')).toEqual([]);
    });

    it('get resolves preferred agent by name for fallback chain head', () => {
      // The PR-authoring fallback starts with the preferred agent resolved via get().
      // Even when the preferred agent lacks make-pr, get() must still return it.
      expect(capRegistry.get('bare-agent')).toBe(noCapsAgent);
      // A preferred agent without make-pr should appear in the fallback chain
      // but will be skipped by skill-path resolution — that's the task-runner's job.
      expect(noCapsAgent.bundledSkills).toBeUndefined();
    });

    it('get returns undefined for unregistered preferred agent names', () => {
      expect(capRegistry.get('nonexistent')).toBeUndefined();
    });

    it('listWithCapability filters agents with multiple skills to only those with the queried skill', () => {
      const reg = new AgentRegistry();
      const multiSkill = makeExecutionAgent('multi', { bundledSkills: ['make-pr', 'deploy', 'lint'] });
      const prOnly = makeExecutionAgent('pr-only', { bundledSkills: ['make-pr'] });
      const deployOnly = makeExecutionAgent('deploy-only', { bundledSkills: ['deploy'] });
      reg.registerExecution(multiSkill);
      reg.registerExecution(prOnly);
      reg.registerExecution(deployOnly);

      const prAgents = reg.listWithCapability('make-pr');
      expect(prAgents.map((a) => a.name)).toEqual(['multi', 'pr-only']);
      expect(prAgents).not.toContainEqual(expect.objectContaining({ name: 'deploy-only' }));

      const deployAgents = reg.listWithCapability('deploy');
      expect(deployAgents.map((a) => a.name)).toEqual(['multi', 'deploy-only']);
    });

    it('re-registration overwrites an agent and preserves the new position in capability lists', () => {
      const reg = new AgentRegistry();
      const v1 = makeExecutionAgent('claude', { bundledSkills: ['make-pr'] });
      const other = makeExecutionAgent('codex', { bundledSkills: ['make-pr'] });
      reg.registerExecution(v1);
      reg.registerExecution(other);

      // Re-register claude with updated skills
      const v2 = makeExecutionAgent('claude', { bundledSkills: ['make-pr', 'deploy'] });
      reg.registerExecution(v2);

      // The re-registered agent replaces the old one
      expect(reg.get('claude')).toBe(v2);
      expect(reg.get('claude')).not.toBe(v1);

      // Capability list reflects the updated agent
      const prAgents = reg.listWithCapability('make-pr');
      expect(prAgents).toContain(v2);
      expect(prAgents).not.toContain(v1);
    });

    it('getWithCapability and listWithCapability agree on first agent', () => {
      // Regression: getWithCapability must return the same agent as listWithCapability[0]
      const reg = new AgentRegistry();
      const agents = [
        makeExecutionAgent('a1', { bundledSkills: ['make-pr'] }),
        makeExecutionAgent('a2', { bundledSkills: ['make-pr'] }),
        makeExecutionAgent('a3', { bundledSkills: ['make-pr'] }),
      ];
      for (const a of agents) reg.registerExecution(a);

      const first = reg.getWithCapability('make-pr');
      const list = reg.listWithCapability('make-pr');
      expect(first).toBe(list[0]);
    });
  });
});
