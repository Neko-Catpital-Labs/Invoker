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
});
