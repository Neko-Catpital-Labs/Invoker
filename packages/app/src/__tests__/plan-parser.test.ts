import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePlan, PlanParseError, detectDefaultBranch } from '../plan-parser.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn(actual.execSync) };
});
import { execSync } from 'node:child_process';

describe('parsePlan', () => {
  it('parses valid YAML plan', () => {
    const yaml = `
name: Hello World Test
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
tasks:
  - id: ask
    description: Ask a question
    prompt: What is the meaning of life?
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].prompt).toBe('What is the meaning of life?');
    expect(plan.tasks[0].command).toBeUndefined();
  });

  it('parses autoFix and maxFixAttempts from task definitions', () => {
    const yaml = `
name: AutoFix Test
tasks:
  - id: fix-task
    description: "A fixable task"
    command: "npm test"
    autoFix: true
    maxFixAttempts: 3
  - id: normal-task
    description: "No fix"
    command: "echo hi"
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].autoFix).toBe(true);
    expect(plan.tasks[0].maxFixAttempts).toBe(3);
    expect(plan.tasks[1].autoFix).toBeUndefined();
  });

  describe('onFinish parsing', () => {
    it('parses plan with onFinish: merge', () => {
      const yaml = `
name: Merge Plan
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
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.onFinish).toBe('pull_request');
      // Auto-generates featureBranch from plan name
      expect(plan.featureBranch).toBe('plan/simple-plan');
    });

    it('auto-detects baseBranch when omitted', () => {
      const mockExecSync = vi.mocked(execSync);
      mockExecSync.mockImplementation(((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('symbolic-ref')) {
          return 'refs/remotes/origin/develop\n';
        }
        throw new Error('unexpected');
      }) as any);

      const yaml = `
name: No Base Branch
onFinish: merge
featureBranch: feat/x
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.baseBranch).toBe('develop');
      mockExecSync.mockRestore();
    });

    it('explicit baseBranch overrides auto-detection', () => {
      const yaml = `
name: Explicit Base
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

  it('parses description field from plan YAML', () => {
    const yaml = [
      'name: "Test Plan"',
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
      'tasks:',
      '  - id: task-1',
      '    description: "Do something"',
      '    command: "echo hello"',
      '    dependencies: []',
    ].join('\n');
    const result = parsePlan(yaml);
    expect(result.description).toBeUndefined();
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
