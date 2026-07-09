import type { TaskDelta } from '@invoker/workflow-core';

export interface TaskDeltaStreamSequence {
  current: () => number;
  stamp: (delta: TaskDelta) => TaskDelta;
}

export function createTaskDeltaStreamSequence(): TaskDeltaStreamSequence {
  let counter = 0;
  return {
    current: () => counter,
    stamp: (delta) => {
      counter += 1;
      return { ...delta, streamSequence: counter } as TaskDelta;
    },
  };
}
