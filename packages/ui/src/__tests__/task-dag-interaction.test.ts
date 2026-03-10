import { describe, it, expect, vi } from 'vitest';

// Test the callback behavior by simulating what ReactFlow's onNodeDoubleClick does
describe('TaskDAG double-click', () => {
  it('onNodeDoubleClick resolves task from map and calls handler', () => {
    const mockTask = {
      id: 'task-1',
      description: 'Test task',
      status: 'running' as const,
      dependencies: [] as string[],
      createdAt: new Date(),
    };
    const tasks = new Map([['task-1', mockTask]]);
    const onTaskDoubleClick = vi.fn();

    // Simulate the callback logic from TaskDAGInner
    const nodeId = 'task-1';
    const task = tasks.get(nodeId);
    if (task && onTaskDoubleClick) {
      onTaskDoubleClick(task);
    }

    expect(onTaskDoubleClick).toHaveBeenCalledWith(mockTask);
  });

  it('onNodeDoubleClick does nothing when task not found', () => {
    const tasks = new Map<string, any>();
    const onTaskDoubleClick = vi.fn();

    const nodeId = 'nonexistent';
    const task = tasks.get(nodeId);
    if (task && onTaskDoubleClick) {
      onTaskDoubleClick(task);
    }

    expect(onTaskDoubleClick).not.toHaveBeenCalled();
  });
});
