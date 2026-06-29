import { describe, it, expect } from 'vitest';
import { summarizePlanText } from '../slack/plan-summary.js';

describe('summarizePlanText', () => {
  it('returns name, one step per task, and taskCount for a valid 2-task plan', () => {
    const yaml = `
name: Build the thing
tasks:
  - id: a
    description: First task
  - id: b
    description: Second task
`;
    const summary = summarizePlanText(yaml);
    expect(summary).not.toBeNull();
    expect(summary!.name).toBe('Build the thing');
    expect(summary!.steps).toEqual(['First task', 'Second task']);
    expect(summary!.taskCount).toBe(2);
  });

  it('orders tasks in execution order via dependencies', () => {
    const yaml = `
name: Ordered plan
tasks:
  - id: b
    description: Depends on A
    dependencies: [a]
  - id: a
    description: Runs first
`;
    const summary = summarizePlanText(yaml);
    expect(summary).not.toBeNull();
    expect(summary!.steps).toEqual(['Runs first', 'Depends on A']);
    expect(summary!.taskCount).toBe(2);
  });

  it('truncates a description longer than 30 words to 30 words + ellipsis', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i + 1}`);
    const yaml = `
name: Long plan
tasks:
  - id: a
    description: ${words.join(' ')}
`;
    const summary = summarizePlanText(yaml);
    expect(summary).not.toBeNull();
    const expected = words.slice(0, 30).join(' ') + ' …';
    expect(summary!.steps[0]).toBe(expected);
    expect(summary!.steps[0].split(' ')).toHaveLength(31); // 30 words + the ellipsis token
  });

  it('collapses whitespace and newlines in descriptions', () => {
    const yaml = `
name: Whitespace plan
tasks:
  - id: a
    description: "First   line\\n\\n  second line"
`;
    const summary = summarizePlanText(yaml);
    expect(summary).not.toBeNull();
    expect(summary!.steps[0]).toBe('First line second line');
  });

  it('returns null when name is missing', () => {
    const yaml = `
tasks:
  - id: a
    description: Something
`;
    expect(summarizePlanText(yaml)).toBeNull();
  });

  it('returns null when tasks is empty', () => {
    const yaml = `
name: Empty plan
tasks: []
`;
    expect(summarizePlanText(yaml)).toBeNull();
  });

  it('returns null when a task is missing its description', () => {
    const yaml = `
name: Bad task plan
tasks:
  - id: a
    description: Fine
  - id: b
`;
    expect(summarizePlanText(yaml)).toBeNull();
  });

  it('returns null for non-YAML garbage', () => {
    expect(summarizePlanText(': : : not [ valid } yaml :')).toBeNull();
  });

  it('returns null for a YAML scalar (non-object) plan', () => {
    expect(summarizePlanText('just a string')).toBeNull();
  });

  it('does not throw on a dependency cycle and still returns a summary', () => {
    const yaml = `
name: Cyclic plan
tasks:
  - id: a
    description: Task A
    dependencies: [b]
  - id: b
    description: Task B
    dependencies: [a]
`;
    const summary = summarizePlanText(yaml);
    expect(summary).not.toBeNull();
    expect(summary!.taskCount).toBe(2);
    expect(summary!.steps).toHaveLength(2);
  });

  it('falls back to listed order when a dependency id is unknown', () => {
    const yaml = `
name: Unknown dep plan
tasks:
  - id: a
    description: Task A
    dependencies: [ghost]
  - id: b
    description: Task B
`;
    const summary = summarizePlanText(yaml);
    expect(summary).not.toBeNull();
    expect(summary!.steps).toEqual(['Task A', 'Task B']);
    expect(summary!.taskCount).toBe(2);
  });
});
