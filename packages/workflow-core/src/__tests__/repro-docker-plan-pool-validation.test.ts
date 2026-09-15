import { describe, expect, it } from 'vitest';
import { parsePlan, PlanParseError } from '../plan-parser.js';

describe('Docker plan-level pool validation', () => {
  it('rejects a plan-level pool when the task is Docker-routed', () => {
    const yaml = `
name: Docker plan pool
repoUrl: git@github.com:example/repo.git
poolId: ssh-pool
tasks:
  - id: docker-task
    description: Run in Docker
    command: echo ok
    dockerImage: node:20
`;

    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow(/dockerImage.*poolId|poolId.*dockerImage/);
  });
});
