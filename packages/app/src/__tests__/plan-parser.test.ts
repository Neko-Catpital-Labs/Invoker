import { describe, it, expect } from 'vitest';
import { parsePlan, PlanParseError } from '../plan-parser.js';

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

    it('defaults onFinish to merge when omitted', () => {
      const yaml = `
name: Simple Plan
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.onFinish).toBe('merge');
      // Auto-generates featureBranch from plan name
      expect(plan.featureBranch).toBe('plan/simple-plan');
    });

    it('defaults baseBranch to main when omitted', () => {
      const yaml = `
name: No Base Branch
onFinish: merge
featureBranch: feat/x
tasks:
  - id: build
    description: Build the project
`;
      const plan = parsePlan(yaml);
      expect(plan.baseBranch).toBe('main');
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
  });
});
