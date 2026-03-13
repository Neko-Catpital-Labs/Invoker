/**
 * Estimates the resource weight of a task for scheduling purposes.
 *
 * Uses static heuristics on cold start, then refines estimates from
 * historical execution durations as tasks complete.
 */

import type { TaskState } from '@invoker/graph';

export interface DurationRecord {
  totalMs: number;
  count: number;
}

const TEST_PATTERN = /\b(pnpm test|npm test|vitest|jest|pytest|cargo test|go test)\b/;
const BUILD_PATTERN = /\b(pnpm build|pnpm run build|npm run build|tsc|webpack|vite build|cargo build)\b/;

export class ResourceEstimator {
  private history = new Map<string, DurationRecord>();

  estimateWeight(task: TaskState): number {
    const pattern = this.normalizeCommand(task.config.command);
    if (pattern) {
      const record = this.history.get(pattern);
      if (record) {
        return this.durationToWeight(record.totalMs / record.count);
      }
    }

    return this.heuristicWeight(task);
  }

  recordCompletion(task: TaskState): void {
    const start = task.execution.startedAt;
    const end = task.execution.completedAt;
    if (!start || !end) return;

    const pattern = this.normalizeCommand(task.config.command);
    if (!pattern) return;

    const durationMs = end.getTime() - start.getTime();
    if (durationMs <= 0) return;

    const existing = this.history.get(pattern);
    if (existing) {
      existing.totalMs += durationMs;
      existing.count += 1;
    } else {
      this.history.set(pattern, { totalMs: durationMs, count: 1 });
    }
  }

  loadHistory(tasks: TaskState[]): void {
    for (const task of tasks) {
      if (task.status === 'completed') {
        this.recordCompletion(task);
      }
    }
  }

  /** Visible for testing. */
  heuristicWeight(task: TaskState): number {
    if (task.config.isMergeNode || task.config.isReconciliation) {
      return 0;
    }

    const cmd = task.config.command;
    if (cmd) {
      if (TEST_PATTERN.test(cmd)) return 3;
      if (BUILD_PATTERN.test(cmd)) return 2;
    }

    if (task.config.prompt && !task.config.command) {
      return 1;
    }

    return 1;
  }

  /** Map average duration (ms) to a weight bucket. */
  private durationToWeight(avgMs: number): number {
    if (avgMs < 10_000) return 1;
    if (avgMs < 60_000) return 2;
    return 3;
  }

  /**
   * Normalize a command string to a pattern key for history lookups.
   * Strips variable parts (hashes, UUIDs, timestamps) while preserving
   * the command structure.
   */
  normalizeCommand(command: string | undefined): string | undefined {
    if (!command) return undefined;

    return command
      .replace(/\d{10,}/g, '<ts>')
      .replace(/[0-9a-f]{8,}/gi, '<hash>')
      .replace(/\/tmp\/[^\s]+/g, '<tmpdir>')
      .trim();
  }
}
