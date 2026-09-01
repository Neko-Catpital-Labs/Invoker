/**
 * Repro: Path-traversal task id accepted
 *
 * Symptom: Task id `../etc/passwd` stored as `wf-…/../etc/passwd`.
 * Task ids are concatenated into workflow-scoped paths without sanitizing.
 *
 * Root cause: parsePlan does not validate task ids for path-unsafe characters.
 * Task ids with `..`, `/`, or `\` can escape the intended directory scope.
 *
 * Fix applied:
 * - parsePlan now validates task ids with isPathSafeId()
 * - Task ids containing "..", "/", "\", or starting with "." are rejected
 */

import { describe, it, expect } from 'vitest';
import { parsePlan, PlanParseError } from '../plan-parser.js';

describe('path-traversal task id validation', () => {
  it('parsePlan should reject task id with ".." path traversal', () => {
    const yamlContent = `
name: Path traversal task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "../etc/passwd"
    description: Task with path traversal in id
    command: echo pwned
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject task id with forward slash', () => {
    const yamlContent = `
name: Forward slash task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "foo/bar"
    description: Task with forward slash in id
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject task id with backslash', () => {
    const yamlContent = `
name: Backslash task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: 'foo\\bar'
    description: Task with backslash in id
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject task id starting with dot', () => {
    const yamlContent = `
name: Dot prefix task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: ".hidden-task"
    description: Task starting with dot
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should accept task id with safe characters', () => {
    const yamlContent = `
name: Safe task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "safe-task_123"
    description: Task with safe characters
    command: echo test
`;

    const plan = parsePlan(yamlContent);
    expect(plan.tasks[0].id).toBe('safe-task_123');
  });

  it('parsePlan should accept task id with hyphen and underscore', () => {
    const yamlContent = `
name: Special chars task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "my-task_v2"
    description: Task with hyphen and underscore
    command: echo test
`;

    const plan = parsePlan(yamlContent);
    expect(plan.tasks[0].id).toBe('my-task_v2');
  });

  it('parsePlan should reject task id with absolute path', () => {
    const yamlContent = `
name: Absolute path task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "/tmp/w3-escape"
    description: Task with absolute path in id
    command: echo pwned
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject task id with RTL override character', () => {
    const yamlContent = `
name: RTL task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "task\u202Ename"
    description: Task with RTL override in id
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject experimentVariant id with path traversal', () => {
    const yamlContent = `
name: Variant escape task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "pivot-task"
    description: Pivot task with malicious variant
    command: echo test
    pivot: true
    experimentVariants:
      - id: "../etc/passwd"
        description: Malicious variant
        command: echo pwned
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject experimentVariant id starting with dot', () => {
    const yamlContent = `
name: Hidden variant task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "pivot-task"
    description: Pivot task with hidden variant
    command: echo test
    pivot: true
    experimentVariants:
      - id: ".hidden"
        description: Hidden variant
        command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should accept experimentVariant id with safe characters', () => {
    const yamlContent = `
name: Safe variant task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "pivot-task"
    description: Pivot task with safe variant
    command: echo test
    pivot: true
    experimentVariants:
      - id: "variant-v1"
        description: Safe variant
        command: echo test
`;

    const plan = parsePlan(yamlContent);
    expect(plan.tasks[0].experimentVariants![0].id).toBe('variant-v1');
  });

  it('parsePlan should reject task id that is exactly ".."', () => {
    const yamlContent = `
name: Double dot task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: ".."
    description: Task with .. as id
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject task id that is exactly "."', () => {
    const yamlContent = `
name: Single dot task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "."
    description: Task with . as id
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject task id that is whitespace only', () => {
    const yamlContent = `
name: Whitespace task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "   "
    description: Task with whitespace-only id
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });
});

describe('path-traversal plan name validation', () => {
  it('parsePlan should reject plan name with ".." path traversal', () => {
    const yamlContent = `
name: "../etc/passwd"
repoUrl: git@github.com:example/repo.git
tasks:
  - id: safe-task
    description: Safe task
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject plan name with forward slash', () => {
    const yamlContent = `
name: "foo/bar"
repoUrl: git@github.com:example/repo.git
tasks:
  - id: safe-task
    description: Safe task
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should accept plan name with safe characters', () => {
    const yamlContent = `
name: "My Safe Plan 2026"
repoUrl: git@github.com:example/repo.git
tasks:
  - id: safe-task
    description: Safe task
    command: echo test
`;

    const plan = parsePlan(yamlContent);
    expect(plan.name).toBe('My Safe Plan 2026');
  });
});
