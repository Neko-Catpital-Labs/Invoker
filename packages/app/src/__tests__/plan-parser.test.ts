import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePlan, PlanParseError, detectDefaultBranch, applyPlanDefinitionDefaults } from '../plan-parser.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn(actual.execSync) };
});
import { execSync } from 'node:child_process';

const isolatedConfigPath = join(tmpdir(), `invoker-plan-parser-config-${process.pid}.json`);

beforeEach(() => {
  process.env.INVOKER_REPO_CONFIG_PATH = isolatedConfigPath;
});

describe('applyPlanDefinitionDefaults', () => {
  it('fills baseBranch, featureBranch, onFinish when omitted (GUI yaml.load shape)', () => {
    const plan = applyPlanDefinitionDefaults({
      name: 'My Plan',
      repoUrl: 'git@github.com:test/repo.git',
      tasks: [{ id: 'a', description: 'd', command: 'echo' }],
    });
    expect(plan.onFinish).toBe('pull_request');
    expect(plan.featureBranch).toBe('plan/my-plan');
    expect(plan.baseBranch).toBeDefined();
    expect(typeof plan.baseBranch).toBe('string');
  });

  it('preserves explicit baseBranch, featureBranch, and onFinish', () => {
    const plan = applyPlanDefinitionDefaults({
      name: 'X',
      baseBranch: 'develop',
      featureBranch: 'feat/x',
      onFinish: 'merge',
      tasks: [{ id: 'a', description: 'd', command: 'echo' }],
    });
    expect(plan.baseBranch).toBe('develop');
    expect(plan.featureBranch).toBe('feat/x');
    expect(plan.onFinish).toBe('merge');
  });

  it('treats empty or whitespace baseBranch like omitted (YAML `baseBranch:`)', () => {
    const empty = applyPlanDefinitionDefaults({
      name: 'Remote PR Plan',
      repoUrl: 'git@github.com:test/repo.git',
      baseBranch: '',
      tasks: [{ id: 'a', description: 'd', command: 'echo' }],
    });
    expect(empty.baseBranch).toBeDefined();
    expect(empty.baseBranch!.length).toBeGreaterThan(0);

    const spaces = applyPlanDefinitionDefaults({
      name: 'Remote PR Plan',
      repoUrl: 'git@github.com:test/repo.git',
      baseBranch: '   ',
      tasks: [{ id: 'a', description: 'd', command: 'echo' }],
    });
    expect(spaces.baseBranch).toEqual(empty.baseBranch);
  });
});

describe('parsePlan', () => {
  it('rejects plan without repoUrl', () => {
    const yaml = `
name: No Repo Plan
tasks:
  - id: greet
    description: Say hello
    command: echo "Hello"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('must have a "repoUrl" field');
  });

  it('parses valid YAML plan', () => {
    const yaml = `
name: Hello World Test
repoUrl: git@github.com:test/repo.git
tasks:
  - id: greet
    description: Say hello
    command: echo "Hello, World!"
`;
    const plan = parsePlan(yaml);
    expect(plan.name).toBe('Hello World Test');
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].id).toBe('greet');
    expect(plan.tasks[0].description).toBe('Say hello');
    expect(plan.tasks[0].command).toBe('echo "Hello, World!"');
  });

  it('parses plan with dependencies', () => {
    const yaml = `
name: Dependency Test
repoUrl: git@github.com:test/repo.git
tasks:
  - id: first
    description: First task
    command: echo "first"
  - id: second
    description: Second task
    command: echo "second"
    dependencies: [first]
  - id: third
    description: Third task
    command: echo "third"
    dependencies: [first, second]
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks[0].dependencies).toEqual([]);
    expect(plan.tasks[1].dependencies).toEqual(['first']);
    expect(plan.tasks[2].dependencies).toEqual(['first', 'second']);
  });

  it('parses externalDependencies with default requiredStatus', () => {
    const yaml = `
name: External Dependency Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: gated
    description: Wait for prior workflow task
    command: echo "go"
    externalDependencies:
      - workflowId: wf-123
        taskId: verify-control-plane-regression
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].externalDependencies).toEqual([
      {
        workflowId: 'wf-123',
        taskId: 'verify-control-plane-regression',
        requiredStatus: 'completed',
        gatePolicy: 'review_ready',
      },
    ]);
  });

  it('defaults externalDependencies without taskId to upstream merge gate', () => {
    const yaml = `
name: External Dependency By Workflow
repoUrl: git@github.com:test/repo.git
tasks:
  - id: gated
    description: Wait for prior workflow merge gate
    command: echo "go"
    externalDependencies:
      - workflowId: wf-123
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].externalDependencies).toEqual([
      { workflowId: 'wf-123', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'review_ready' },
    ]);
  });

  it('parses externalDependencies.gatePolicy review_ready', () => {
    const yaml = `
name: External Dependency Review Ready
repoUrl: git@github.com:test/repo.git
tasks:
  - id: gated
    description: Wait for prior workflow merge gate to be review-ready
    command: echo "go"
    externalDependencies:
      - workflowId: wf-123
        taskId: __merge__
        gatePolicy: review_ready
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].externalDependencies).toEqual([
      { workflowId: 'wf-123', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'review_ready' },
    ]);
  });

  it('parses top-level externalDependencies and applies them to root tasks', () => {
    const yaml = `
name: Workflow Chain Step
repoUrl: git@github.com:test/repo.git
externalDependencies:
  - workflowId: wf-123
    taskId: __merge__
tasks:
  - id: root-a
    description: Root A
    command: echo "a"
  - id: root-b
    description: Root B
    command: echo "b"
  - id: child
    description: Child
    command: echo "c"
    dependencies: [root-a]
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].externalDependencies).toEqual([
      { workflowId: 'wf-123', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'review_ready' },
    ]);
    expect(plan.tasks[1].externalDependencies).toEqual([
      { workflowId: 'wf-123', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'review_ready' },
    ]);
    expect(plan.tasks[2].externalDependencies).toBeUndefined();
  });

  it('lets task-level externalDependencies override inherited top-level dependency by workflow+task', () => {
    const yaml = `
name: Workflow Chain Override
repoUrl: git@github.com:test/repo.git
externalDependencies:
  - workflowId: wf-123
    taskId: __merge__
    gatePolicy: review_ready
tasks:
  - id: root
    description: Root
    command: echo "go"
    externalDependencies:
      - workflowId: wf-123
        taskId: __merge__
        gatePolicy: completed
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].externalDependencies).toEqual([
      { workflowId: 'wf-123', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
    ]);
  });

  it('rejects invalid top-level externalDependencies.gatePolicy', () => {
    const yaml = `
name: Bad Top-Level External Dependency Gate Policy
repoUrl: git@github.com:test/repo.git
externalDependencies:
  - workflowId: wf-123
    taskId: __merge__
    gatePolicy: whenever
tasks:
  - id: gated
    description: Wait
    command: echo "go"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('"gatePolicy" must be "completed" or "review_ready"');
  });

  it('rejects invalid externalDependencies.requiredStatus', () => {
    const yaml = `
name: Bad External Dependency Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: gated
    description: Wait
    command: echo "go"
    externalDependencies:
      - workflowId: wf-123
        taskId: verify-control-plane-regression
        requiredStatus: running
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('"requiredStatus" must be "completed"');
  });

  it('rejects invalid externalDependencies.gatePolicy', () => {
    const yaml = `
name: Bad External Dependency Gate Policy
repoUrl: git@github.com:test/repo.git
tasks:
  - id: gated
    description: Wait
    command: echo "go"
    externalDependencies:
      - workflowId: wf-123
        taskId: __merge__
        gatePolicy: whenever
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('"gatePolicy" must be "completed" or "review_ready"');
  });

  it('rejects deprecated "approved" gatePolicy value', () => {
    const yaml = `
name: Deprecated Approved Gate Policy
repoUrl: git@github.com:test/repo.git
tasks:
  - id: gated
    description: Wait
    command: echo "go"
    externalDependencies:
      - workflowId: wf-123
        taskId: __merge__
        gatePolicy: approved
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow("gatePolicy value 'approved' is no longer supported. Use 'completed' instead.");
  });

  it('rejects plan without name', () => {
    const yaml = `
tasks:
  - id: greet
    description: Say hello
    command: echo "Hello"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('must have a "name" field');
  });

  it('rejects plan without tasks', () => {
    const yaml = `
name: Empty Plan
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('must have a non-empty "tasks" array');
  });

  it('rejects plan with empty tasks array', () => {
    const yaml = `
name: Empty Plan
tasks: []
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('must have a non-empty "tasks" array');
  });

  it('rejects task without id', () => {
    const yaml = `
name: Bad Task Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - description: No ID here
    command: echo "oops"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('must have an "id" field');
  });

  it('rejects task without description', () => {
    const yaml = `
name: Bad Task Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: no-desc
    command: echo "oops"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('must have a "description" field');
  });

  it('rejects task commands using npx vitest run', () => {
    const yaml = `
name: Bad Command Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: test-it
    description: "Run tests"
    command: "cd packages/surfaces && npx vitest run"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('npx vitest run');
  });

  it('parses task with prompt instead of command', () => {
    const yaml = `
name: Prompt Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: ask
    description: Ask a question
    prompt: What is the meaning of life?
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].prompt).toBe('What is the meaning of life?');
    expect(plan.tasks[0].command).toBeUndefined();
  });

  it('parses autoFix from task definitions', () => {
    const yaml = `
name: AutoFix Test
repoUrl: git@github.com:test/repo.git
tasks:
  - id: fix-task
    description: "A fixable task"
    command: "npm test"
    autoFix: true
  - id: normal-task
    description: "No fix"
    command: "echo hi"
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].autoFix).toBe(true);
    expect(plan.tasks[1].autoFix).toBeUndefined();
  });

  it('parses executionAgent from task definitions', () => {
    const yaml = `
name: Agent Test
repoUrl: git@github.com:test/repo.git
tasks:
  - id: codex-task
    description: "Task using codex"
    command: "npm test"
    executionAgent: codex
  - id: claude-task
    description: "Task using claude"
    prompt: "Fix the bug"
    executionAgent: claude
  - id: default-task
    description: "No agent specified"
    command: "echo hi"
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].executionAgent).toBe('codex');
    expect(plan.tasks[1].executionAgent).toBe('claude');
    expect(plan.tasks[2].executionAgent).toBeUndefined();
  });

  it('trims whitespace from executionAgent and treats empty as undefined', () => {
    const yaml = `
name: Agent Trim Test
repoUrl: git@github.com:test/repo.git
tasks:
  - id: padded
    description: "Padded agent"
    command: "echo hi"
    executionAgent: "  codex  "
  - id: empty
    description: "Empty agent"
    command: "echo hi"
    executionAgent: ""
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].executionAgent).toBe('codex');
    expect(plan.tasks[1].executionAgent).toBeUndefined();
  });

  describe('onFinish parsing', () => {
    it('parses plan with onFinish: merge', () => {
      const yaml = `
name: Merge Plan
repoUrl: git@github.com:test/repo.git
onFinish: merge
baseBranch: develop
featureBranch: feat/x
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.onFinish).toBe('merge');
      expect(plan.baseBranch).toBe('develop');
      expect(plan.featureBranch).toBe('feat/x');
    });

    it('parses plan with onFinish: pull_request', () => {
      const yaml = `
name: PR Plan
repoUrl: git@github.com:test/repo.git
onFinish: pull_request
featureBranch: feat/pr
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.onFinish).toBe('pull_request');
    });

    it('defaults onFinish to pull_request when omitted', () => {
      const yaml = `
name: Simple Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.onFinish).toBe('pull_request');
      // Auto-generates featureBranch from plan name
      expect(plan.featureBranch).toBe('plan/simple-plan');
    });

    it('auto-detects baseBranch when omitted', async () => {
      // Mock loadConfig to return empty config so local ~/.invoker/config.json
      // doesn't short-circuit the remote branch detection.
      const configMod = await import('../config.js');
      const loadConfigSpy = vi.spyOn(configMod, 'loadConfig').mockReturnValue({});

      const mockExecSync = vi.mocked(execSync);
      mockExecSync.mockImplementation(((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('ls-remote')) {
          return 'ref: refs/heads/develop\tHEAD\nabc123\tHEAD\n';
        }
        throw new Error('unexpected');
      }) as any);

      const yaml = `
name: No Base Branch
repoUrl: git@github.com:test/repo.git
onFinish: merge
featureBranch: feat/x
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.baseBranch).toBe('develop');
      mockExecSync.mockRestore();
      loadConfigSpy.mockRestore();
    });

    it('explicit baseBranch overrides auto-detection', () => {
      const yaml = `
name: Explicit Base
repoUrl: git@github.com:test/repo.git
onFinish: merge
baseBranch: release
featureBranch: feat/x
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.baseBranch).toBe('release');
    });

    it('rejects invalid onFinish value', () => {
      const yaml = `
name: Bad Finish
repoUrl: git@github.com:test/repo.git
onFinish: explode
tasks:
  - id: build
    description: Build the project
`;
      expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    });

    it('auto-generates featureBranch when onFinish is merge without explicit branch', () => {
      const yaml = `
name: Missing Feature Branch
repoUrl: git@github.com:test/repo.git
onFinish: merge
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.onFinish).toBe('merge');
      expect(plan.featureBranch).toBe('plan/missing-feature-branch');
    });

    it('auto-generates featureBranch even when onFinish is none', () => {
      const yaml = `
name: No Finish Branch
repoUrl: git@github.com:test/repo.git
onFinish: none
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.onFinish).toBe('none');
      expect(plan.featureBranch).toBe('plan/no-finish-branch');
    });
  });

  it('parses executorType without any warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const yaml = `
name: Executor Type Plan
repoUrl: git@github.com:test/repo.git
executorType: worktree
tasks:
  - id: build
    description: Build the project
    command: echo "build"
    executorType: docker
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].executorType).toBe('docker');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('parses description field from plan YAML', () => {
    const yaml = [
      'name: "Test Plan"',
      'repoUrl: "git@github.com:test/repo.git"',
      'description: "This plan adds feature X"',
      'tasks:',
      '  - id: task-1',
      '    description: "Do something"',
      '    command: "echo hello"',
      '    dependencies: []',
    ].join('\n');
    const result = parsePlan(yaml);
    expect(result.description).toBe('This plan adds feature X');
  });

  it('description is optional', () => {
    const yaml = [
      'name: "Test Plan"',
      'repoUrl: "git@github.com:test/repo.git"',
      'tasks:',
      '  - id: task-1',
      '    description: "Do something"',
      '    command: "echo hello"',
      '    dependencies: []',
    ].join('\n');
    const result = parsePlan(yaml);
    expect(result.description).toBeUndefined();
  });

  it('parses visualProof field from plan YAML', () => {
    const yaml = [
      'name: "Test Plan"',
      'repoUrl: "git@github.com:test/repo.git"',
      'description: "Architecture context"',
      'visualProof: true',
      'tasks:',
      '  - id: task-1',
      '    description: "Do something"',
      '    command: "echo hello"',
      '    dependencies: []',
    ].join('\n');
    const result = parsePlan(yaml);
    expect(result.visualProof).toBe(true);
  });

  it('visualProof defaults to undefined when not set', () => {
    const yaml = [
      'name: "Test Plan"',
      'repoUrl: "git@github.com:test/repo.git"',
      'tasks:',
      '  - id: task-1',
      '    description: "Do something"',
      '    command: "echo hello"',
      '    dependencies: []',
    ].join('\n');
    const result = parsePlan(yaml);
    expect(result.visualProof).toBeUndefined();
  });
});

describe('detectDefaultBranch', () => {
  const mockExecSync = vi.mocked(execSync);

  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns branch from git symbolic-ref when available', () => {
    mockExecSync.mockImplementation(((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('symbolic-ref')) {
        return 'refs/remotes/origin/master\n';
      }
      throw new Error('unexpected');
    }) as any);

    expect(detectDefaultBranch()).toBe('master');
  });

  it('falls back to main when symbolic-ref fails but main exists', () => {
    let callCount = 0;
    mockExecSync.mockImplementation(((cmd: string) => {
      callCount++;
      if (typeof cmd === 'string' && cmd.includes('symbolic-ref')) {
        throw new Error('not set');
      }
      if (typeof cmd === 'string' && cmd.includes('rev-parse') && cmd.includes('main')) {
        return 'abc123\n';
      }
      throw new Error('unexpected');
    }) as any);

    expect(detectDefaultBranch()).toBe('main');
    expect(callCount).toBe(2);
  });

  it('falls back to master when both symbolic-ref and main fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(detectDefaultBranch()).toBe('master');
  });
});
