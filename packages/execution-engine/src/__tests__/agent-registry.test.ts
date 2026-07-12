import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRegistry } from '../agent-registry.js';
import { registerBuiltinAgents } from '../agents/index.js';
import { assertExecutionModelSupported, type ExecutionAgent } from '../agent.js';
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      status: 1,
      stdout: '',
      stderr: '',
      output: [],
      pid: 0,
      signal: null,
    })),
  };
});

beforeEach(() => {
  vi.mocked(spawnSync).mockReset();
  vi.mocked(spawnSync).mockReturnValue({
    status: 1,
    stdout: '',
    stderr: '',
    output: [],
    pid: 0,
    signal: null,
  } as any);
});

function makeExecutionAgent(name: string, opts?: {
  bundledSkillRoot?: string;
  bundledSkills?: readonly string[];
  supportedModels?: readonly { id: string; label: string }[];
}): ExecutionAgent {
  return {
    name,
    buildCommand: () => ({ cmd: name, args: [] }),
    buildResumeArgs: (sessionId: string) => ({ cmd: name, args: ['resume', sessionId] }),
    buildFixCommand: (prompt: string) => ({ cmd: name, args: ['fix', prompt] }),
    stdinMode: 'pipe',
    ...(opts?.bundledSkillRoot !== undefined && { bundledSkillRoot: opts.bundledSkillRoot }),
    ...(opts?.bundledSkills !== undefined && { bundledSkills: opts.bundledSkills }),
    ...(opts?.supportedModels !== undefined && { supportedModels: opts.supportedModels }),
  };
}

describe('registerBuiltinAgents', () => {
  it('registers claude, codex, omp, kimi, and qwen execution agents', () => {
    const names = registerBuiltinAgents().listExecution().map((agent) => agent.name);
    expect(names).toEqual(expect.arrayContaining(['claude', 'codex', 'omp', 'kimi', 'qwen']));
  });

  it('exposes curated built-in model choices per harness', () => {
    const harnesses = registerBuiltinAgents().listExecutionHarnesses();
    expect(harnesses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'claude',
        supportedModels: expect.arrayContaining([
          { id: 'sonnet', label: 'Claude Sonnet' },
          { id: 'opus', label: 'Claude Opus' },
        ]),
      }),
      expect.objectContaining({
        name: 'codex',
        supportedModels: expect.arrayContaining([
          { id: 'gpt-5', label: 'GPT-5' },
          { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
        ]),
      }),
      expect.objectContaining({
        name: 'omp',
        supportedModels: expect.arrayContaining([
          { id: 'chatgpt-5.4', label: 'ChatGPT 5.4' },
          { id: 'anthropic/claude-opus-4', label: 'Anthropic Claude Opus 4' },
          { id: 'openai/gpt-5', label: 'OpenAI GPT-5' },
          { id: 'openrouter/~moonshotai/kimi-latest', label: 'OpenRouter Kimi Latest' },
          { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
          { id: 'ollama/qwen2.5-coder:7b', label: 'Ollama Qwen2.5 Coder 7B' },
        ]),
      }),
      expect.objectContaining({
        name: 'kimi',
        supportedModels: expect.arrayContaining([
          { id: 'kimi-k2.6', label: 'Kimi K2.6' },
        ]),
      }),
      expect.objectContaining({
        name: 'qwen',
        supportedModels: expect.arrayContaining([
          { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus' },
        ]),
      }),
    ]));
  });
  it('prefers Codex models discovered from the CLI', () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        models: [
          { slug: 'gpt-5.5', display_name: 'GPT-5.5' },
          { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4 Mini' },
          { slug: 'gpt-5.5', display_name: 'Duplicate GPT-5.5' },
        ],
      }),
      stderr: '',
      output: [],
      pid: 1,
      signal: null,
    } as any);

    const codexAgent = registerBuiltinAgents().getOrThrow('codex');

    expect(codexAgent.supportedModels).toEqual([
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    ]);
    expect(() => assertExecutionModelSupported(codexAgent, 'gpt-5.5')).not.toThrow();
  });


  it('registers cursor, omp, and codex planning agents', () => {
    const registry = registerBuiltinAgents();
    expect(registry.getPlanningOrThrow('cursor').name).toBe('cursor');
    expect(registry.getPlanningOrThrow('omp').name).toBe('omp');
    expect(registry.getPlanningOrThrow('codex').name).toBe('codex');
  });

  it('threads the planning model into the cursor command', () => {
    const cursor = registerBuiltinAgents().getPlanningOrThrow('cursor');
    expect(cursor.buildPlanningCommand('p', { model: 'codex' })).toEqual({
      command: 'cursor',
      args: ['agent', '--print', '--trust', '--model', 'codex', 'p'],
    });
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

  it('lists serializable harness metadata for the UI', () => {
    registry = new AgentRegistry();
    registry.registerExecution(makeExecutionAgent('claude', {
      supportedModels: [{ id: 'sonnet', label: 'Claude Sonnet' }],
    }));

    expect(registry.listExecutionHarnesses()).toEqual([
      {
        name: 'claude',
        supportedModels: [{ id: 'sonnet', label: 'Claude Sonnet' }],
      },
    ]);
  });

  it('defaults nullish execution agent names to codex', () => {
    expect(registry.getOrThrow(undefined)).toBe(codex);
    expect(registry.getOrThrow(null)).toBe(codex);
    expect(registry.getOrThrow('')).toBe(codex);
    expect(registry.getOrThrow('   ')).toBe(codex);
    expect(registry.getOrThrow('null')).toBe(codex);
    expect(registry.getOrThrow('undefined')).toBe(codex);
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
  it('accepts versioned OpenAI-style models for codex', () => {
    const codexAgent = registerBuiltinAgents().getOrThrow('codex');
    expect(() => assertExecutionModelSupported(codexAgent, 'gpt-5.1-codex-max')).not.toThrow();
  });

  it('rejects clearly foreign models for codex', () => {
    const codexAgent = registerBuiltinAgents().getOrThrow('codex');
    expect(() => assertExecutionModelSupported(codexAgent, 'claude')).toThrow(
      'Execution model "claude" is not supported for execution agent "codex".',
    );
  });
  it('accepts Claude aliases and versioned Claude model ids', () => {
    const claudeAgent = registerBuiltinAgents().getOrThrow('claude');
    expect(() => assertExecutionModelSupported(claudeAgent, 'sonnet')).not.toThrow();
    expect(() => assertExecutionModelSupported(claudeAgent, 'anthropic/claude-opus-4-8-20260528')).not.toThrow();
  });

  it('rejects plain claude as an execution model for Claude', () => {
    const claudeAgent = registerBuiltinAgents().getOrThrow('claude');
    expect(() => assertExecutionModelSupported(claudeAgent, 'claude')).toThrow(
      'Execution model "claude" is not supported for execution agent "claude".',
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
