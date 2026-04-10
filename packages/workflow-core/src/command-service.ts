/**
 * CommandService — Wraps orchestrator methods with idempotency-key dedup.
 *
 * Instance-scoped LRU cache keyed by `idempotencyKey` with a 5-minute TTL.
 * Duplicate envelopes return the cached CommandResult without re-invoking
 * the orchestrator.
 */

import type { CommandEnvelope, CommandResult } from '@invoker/contracts';
import type { Orchestrator } from './orchestrator.js';
import type { TaskState } from '@invoker/workflow-graph';

// ── Cache Entry ─────────────────────────────────────────────

interface CacheEntry<T> {
  result: CommandResult<T>;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_SIZE = 1000;

// ── CommandService ──────────────────────────────────────────

export class CommandService {
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<CommandResult<unknown>>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly orchestrator: Orchestrator;

  constructor(
    orchestrator: Orchestrator,
    opts?: { ttlMs?: number; maxSize?: number },
  ) {
    this.orchestrator = orchestrator;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSize = opts?.maxSize ?? DEFAULT_MAX_SIZE;
  }

  // ── Public Commands ─────────────────────────────────────

  async approve(
    envelope: CommandEnvelope<{ taskId: string }>,
  ): Promise<CommandResult<TaskState[]>> {
    const cached = this.getFromCache<TaskState[]>(envelope.idempotencyKey);
    if (cached) return cached;

    // Coalesce concurrent calls with the same key onto a single in-flight promise.
    const existing = this.inFlight.get(envelope.idempotencyKey);
    if (existing) return existing as Promise<CommandResult<TaskState[]>>;

    const promise = this.executeApprove(envelope);
    this.inFlight.set(envelope.idempotencyKey, promise as Promise<CommandResult<unknown>>);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(envelope.idempotencyKey);
    }
  }

  reject(
    envelope: CommandEnvelope<{ taskId: string; reason?: string }>,
  ): CommandResult<void> {
    const cached = this.getFromCache<void>(envelope.idempotencyKey);
    if (cached) return cached;

    try {
      const task = this.orchestrator.getTask(envelope.payload.taskId);
      if (task?.execution.pendingFixError !== undefined) {
        this.orchestrator.revertConflictResolution(
          envelope.payload.taskId,
          task.execution.pendingFixError,
        );
      } else {
        this.orchestrator.reject(
          envelope.payload.taskId,
          envelope.payload.reason,
        );
      }
      const result: CommandResult<void> = { ok: true, data: undefined };
      this.setInCache(envelope.idempotencyKey, result);
      return result;
    } catch (err) {
      const result: CommandResult<void> = {
        ok: false,
        error: {
          code: 'REJECT_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
      this.setInCache(envelope.idempotencyKey, result);
      return result;
    }
  }

  // ── Private Helpers ────────────────────────────────────

  private async executeApprove(
    envelope: CommandEnvelope<{ taskId: string }>,
  ): Promise<CommandResult<TaskState[]>> {
    try {
      const started = await this.orchestrator.approve(envelope.payload.taskId);
      const result: CommandResult<TaskState[]> = { ok: true, data: started };
      this.setInCache(envelope.idempotencyKey, result);
      return result;
    } catch (err) {
      const result: CommandResult<TaskState[]> = {
        ok: false,
        error: {
          code: 'APPROVE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
      this.setInCache(envelope.idempotencyKey, result);
      return result;
    }
  }

  // ── Cache Internals ─────────────────────────────────────

  private getFromCache<T>(key: string): CommandResult<T> | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.result as CommandResult<T>;
  }

  private setInCache<T>(key: string, result: CommandResult<T>): void {
    // Evict oldest entry if at capacity (Map preserves insertion order).
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, {
      result,
      expiresAt: Date.now() + this.ttlMs,
    });
  }
}
