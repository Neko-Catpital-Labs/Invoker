import type { Executor } from './executor.js';

export class ExecutorRegistry {
  private executors = new Map<string, Executor>();

  register(type: string, executor: Executor): void {
    this.executors.set(type, executor);
  }

  get(type: string): Executor | undefined {
    return this.executors.get(type);
  }

  getDefault(): Executor {
    const worktree = this.executors.get('worktree');
    if (!worktree) {
      throw new Error('No "worktree" executor registered. Register one before calling getDefault().');
    }
    return worktree;
  }

  getAll(): Executor[] {
    return Array.from(this.executors.values());
  }
}
