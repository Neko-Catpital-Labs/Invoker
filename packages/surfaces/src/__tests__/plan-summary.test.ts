import { describe, it, expect } from 'vitest';
import { summarizePlanText, formatPlanSummaryLines } from '../slack/plan-summary.js';

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

  it('summarizes a Workers Surface workflow stack by workflow order', () => {
    const yaml = `
name: Workers Surface
workflows:
  - name: Workers Surface Contracts
    tasks:
      - id: verify-contracts
        description: Verify contracts
        dependencies: [define-contracts]
      - id: define-contracts
        description: Define contracts
  - name: Workers Surface UI
    tasks:
      - id: build-ui
        description: Build UI
      - id: verify-ui
        description: Verify UI
        dependencies: [build-ui]
`;
    const summary = summarizePlanText(yaml);
    expect(summary).not.toBeNull();
    expect(summary!.name).toBe('Workers Surface');
    expect(summary!.workflowCount).toBe(2);
    expect(summary!.taskCount).toBe(4);
    expect(summary!.steps).toEqual(['Workers Surface Contracts', 'Workers Surface UI']);
    expect(summary!.taskGroups).toEqual([
      { workflow: 'Workers Surface Contracts', tasks: ['Define contracts', 'Verify contracts'] },
      { workflow: 'Workers Surface UI', tasks: ['Build UI', 'Verify UI'] },
    ]);
  });

  it('groups a flat plan under a single null-workflow group in execution order', () => {
    const summary = summarizePlanText(`
name: Flat plan
tasks:
  - id: b
    description: Second task
    dependencies: [a]
  - id: a
    description: First task
`);
    expect(summary!.taskGroups).toEqual([
      { workflow: null, tasks: ['First task', 'Second task'] },
    ]);
  });
});

describe('formatPlanSummaryLines', () => {
  it('lists every task under its workflow name for a stacked plan', () => {
    const summary = summarizePlanText(`
name: Dark mode
workflows:
  - name: Add theme tokens
    tasks:
      - id: t1
        description: Add CSS variables
      - id: t2
        description: Test the tokens
  - name: Wire the toggle
    tasks:
      - id: t3
        description: Add the toggle control
`)!;
    expect(formatPlanSummaryLines(summary)).toEqual([
      'Add theme tokens',
      '   • Add CSS variables',
      '   • Test the tokens',
      'Wire the toggle',
      '   • Add the toggle control',
    ]);
  });

  it('lists one bullet per task with no workflow heading for a flat plan', () => {
    const summary = summarizePlanText(`
name: Flat plan
tasks:
  - id: a
    description: First task
  - id: b
    description: Second task
`)!;
    expect(formatPlanSummaryLines(summary)).toEqual(['• First task', '• Second task']);
  });

  it('keeps long descriptions intact after normalizing whitespace', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i + 1}`);
    const yaml = `
name: Long plan
tasks:
  - id: long
    description: "${words.join('  ')}"
`;
    const summary = summarizePlanText(yaml);
    expect(summary).not.toBeNull();
    expect(summary!.steps[0]).toBe(words.join(' '));
    expect(summary!.steps[0]).not.toContain('…');
    expect(summary!.steps[0].split(' ')).toHaveLength(40);
  });

  it('keeps long workflow names intact after normalizing whitespace', () => {
    const words = Array.from({ length: 24 }, (_, i) => `workflow${i + 1}`);
    const yaml = `
name: Long workflow stack
workflows:
  - name: "${words.join('  ')}"
    tasks:
      - id: task
        description: Run task
`;
    const summary = summarizePlanText(yaml);
    expect(summary).not.toBeNull();
    expect(summary!.steps[0]).toBe(words.join(' '));
    expect(summary!.steps[0]).not.toContain('…');
    expect(summary!.steps[0].split(' ')).toHaveLength(24);
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

  it('returns null when a stacked child workflow has no tasks', () => {
    const yaml = `
name: Bad Workers Surface
workflows:
  - name: Missing Tasks
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
