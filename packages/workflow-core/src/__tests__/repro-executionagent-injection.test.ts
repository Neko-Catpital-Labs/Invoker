/**
 * Repro: executionAgent not validated at parse time for injection chars
 *
 * Symptom: executionAgent values with injection characters (semicolons,
 * newlines, shell metacharacters) are stored as-is. While runtime agent
 * lookup may fail, malformed values reach the persistence layer.
 *
 * Root cause: parsePlan only trims executionAgent, no validation for
 * dangerous characters or format. The agent registry check happens
 * later in the headless-run flow, not at parse time.
 *
 * Invariant: executionAgent must be a valid identifier at parse time.
 * Values with newlines, semicolons, or other shell metacharacters
 * should be rejected immediately to avoid injection risks.
 *
 * Fix applied:
 * - parsePlan now validates executionAgent with isValidAgentName()
 * - Values with shell metacharacters are rejected at parse time
 */

import { describe, it, expect } from 'vitest';
import { parsePlan, PlanParseError } from '../plan-parser.js';

describe('executionAgent format validation', () => {
  it('parsePlan should reject executionAgent with semicolon (shell injection)', () => {
    const yamlContent = `
name: Injection test
repoUrl: git@github.com:example/repo.git
tasks:
  - id: task1
    description: Test task
    command: echo test
    executionAgent: "claude; id"
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject executionAgent with newline', () => {
    const yamlContent = `
name: Newline test
repoUrl: git@github.com:example/repo.git
tasks:
  - id: task1
    description: Test task
    command: echo test
    executionAgent: "claude\\nid"
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject executionAgent with backtick (command substitution)', () => {
    const yamlContent = `
name: Backtick test
repoUrl: git@github.com:example/repo.git
tasks:
  - id: task1
    description: Test task
    command: echo test
    executionAgent: "claude\`id\`"
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject executionAgent with $() (command substitution)', () => {
    const yamlContent = `
name: Command sub test
repoUrl: git@github.com:example/repo.git
tasks:
  - id: task1
    description: Test task
    command: echo test
    executionAgent: "claude$(id)"
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should accept valid executionAgent names', () => {
    const yamlContent = `
name: Valid agent test
repoUrl: git@github.com:example/repo.git
tasks:
  - id: task1
    description: Test task
    command: echo test
    executionAgent: claude
`;

    const plan = parsePlan(yamlContent);
    expect(plan.tasks[0].executionAgent).toBe('claude');
  });

  it('parsePlan should accept executionAgent with hyphen', () => {
    const yamlContent = `
name: Hyphen agent test
repoUrl: git@github.com:example/repo.git
tasks:
  - id: task1
    description: Test task
    command: echo test
    executionAgent: my-custom-agent
`;

    const plan = parsePlan(yamlContent);
    expect(plan.tasks[0].executionAgent).toBe('my-custom-agent');
  });
});
