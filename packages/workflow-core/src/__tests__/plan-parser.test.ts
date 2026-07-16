import { describe, it, expect } from 'vitest';
import { parsePlan, PlanParseError } from '../plan-parser.js';

describe('parsePlan (workflow-core)', () => {
  it('parses a plan with distinct task ids', () => {
    const yaml = `
name: Two Step Plan
repoUrl: git@github.com:test/repo.git
baseBranch: main
tasks:
  - id: build
    description: Build it
    command: echo "build"
  - id: deploy
    description: Ship it
    command: echo "deploy"
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks.map((t) => t.id)).toEqual(['build', 'deploy']);
  });

  it('rejects plans with duplicate task ids', () => {
    const yaml = `
name: Dup Plan
repoUrl: git@github.com:test/repo.git
baseBranch: main
tasks:
  - id: build
    description: First build
    command: echo "one"
  - id: build
    description: Second build
    command: echo "two"
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('Duplicate task id "build"');
  });

  it('rejects non-object task entries with a parse error', () => {
    const yaml = `
name: Bad Task Shape Plan
repoUrl: git@github.com:test/repo.git
baseBranch: main
tasks:
  - null
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow('Task at index 0 must be an object with an "id" field');
  });
  it('currently accepts pnpm vitest task commands', () => {
    const yaml = `
name: Bad Command Plan
repoUrl: git@github.com:test/repo.git
baseBranch: main
tasks:
  - id: test-it
    description: Run tests
    command: "cd packages/ui && pnpm vitest run src/__tests__/edge.test.tsx"
`;
    expect(() => parsePlan(yaml)).not.toThrow();
  });

  it('parses and trims executionModel from task definitions', () => {
    const yaml = `
name: Model Plan
repoUrl: git@github.com:test/repo.git
baseBranch: main
tasks:
  - id: claude-task
    description: Uses claude model
    command: echo "hi"
    executionModel: claude
  - id: padded-task
    description: Padded model
    command: echo "hi"
    executionModel: "  claude  "
  - id: empty-task
    description: Empty model
    command: echo "hi"
    executionModel: ""
  - id: default-task
    description: No model
    command: echo "hi"
`;
    const plan = parsePlan(yaml);
    expect(plan.tasks[0].executionModel).toBe('claude');
    expect(plan.tasks[1].executionModel).toBe('claude');
    expect(plan.tasks[2].executionModel).toBeUndefined();
    expect(plan.tasks[3].executionModel).toBeUndefined();
  });

  it('rejects a non-string executionModel with PlanParseError', () => {
    const yaml = `
name: Bad Model Plan
repoUrl: git@github.com:test/repo.git
baseBranch: main
tasks:
  - id: t1
    description: Bad model
    command: echo "hi"
    executionModel: 123
`;
    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow(/executionModel/);
  });
});
