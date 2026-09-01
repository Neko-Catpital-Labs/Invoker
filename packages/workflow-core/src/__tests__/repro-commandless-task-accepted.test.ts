/**
 * Repro: Command-less / prompt-less task accepted
 *
 * Symptom: CLI headless run accepted a task with neither command nor prompt.
 * Workflow loaded; task stayed pending forever; merge gate waited indefinitely.
 *
 * Root cause: parsePlan only validates id/description, not that at least one
 * of command|prompt is present. A task without either cannot run.
 *
 * Fix applied:
 * - parsePlan now validates that each task has at least one of command|prompt
 * - Tasks without either are rejected with a clear error message
 */

import { describe, it, expect } from 'vitest';
import { parsePlan, PlanParseError } from '../plan-parser.js';

describe('command-less / prompt-less task validation', () => {
  it('parsePlan should reject task with neither command nor prompt', () => {
    const yamlContent = `
name: No action task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: do-nothing
    description: This task has no command and no prompt
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject task with empty command and no prompt', () => {
    const yamlContent = `
name: Empty command task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: empty-action
    description: This task has empty command and no prompt
    command: ""
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject task with whitespace-only command and no prompt', () => {
    const yamlContent = `
name: Whitespace command task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: whitespace-action
    description: This task has whitespace-only command and no prompt
    command: "   "
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should accept task with command only', () => {
    const yamlContent = `
name: Command only task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: has-command
    description: This task has a command
    command: echo hello
`;

    const plan = parsePlan(yamlContent);
    expect(plan.tasks[0].command).toBe('echo hello');
  });

  it('parsePlan should accept task with prompt only', () => {
    const yamlContent = `
name: Prompt only task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: has-prompt
    description: This task has a prompt
    prompt: Fix the bug
`;

    const plan = parsePlan(yamlContent);
    expect(plan.tasks[0].prompt).toBe('Fix the bug');
  });

  it('parsePlan should accept task with both command and prompt', () => {
    const yamlContent = `
name: Both task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: has-both
    description: This task has both
    command: echo hello
    prompt: Also fix the bug
`;

    const plan = parsePlan(yamlContent);
    expect(plan.tasks[0].command).toBe('echo hello');
    expect(plan.tasks[0].prompt).toBe('Also fix the bug');
  });
});
