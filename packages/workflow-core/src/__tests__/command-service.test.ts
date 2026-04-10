import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandService } from '../command-service.js';
import type { CommandEnvelope } from '@invoker/contracts';
import type { Orchestrator } from '../orchestrator.js';
import type { TaskState } from '@invoker/workflow-graph';

// ── Helpers ─────────────────────────────────────────────────

function makeEnvelope<P>(
  payload: P,
  idempotencyKey = 'key-1',
): CommandEnvelope<P> {
  return {
    commandId: 'cmd-1',
    source: 'headless',
    scope: 'task',
    idempotencyKey,
    payload,
  };
}

function stubOrchestrator(overrides: Partial<Orchestrator> = {}): Orchestrator {
  return {
    approve: vi.fn().mockResolvedValue([] as TaskState[]),
    reject: vi.fn(),
    getTask: vi.fn().mockReturnValue(undefined),
    revertConflictResolution: vi.fn(),
    ...overrides,
  } as unknown as Orchestrator;
}

// ── Tests ───────────────────────────────────────────────────

describe('CommandService', () => {
  let orchestrator: Orchestrator;
  let service: CommandService;

  beforeEach(() => {
    orchestrator = stubOrchestrator();
    service = new CommandService(orchestrator, { ttlMs: 5 * 60 * 1000 });
  });

  // ── approve ─────────────────────────────────────────────

  describe('approve', () => {
    it('delegates to orchestrator.approve on first call', async () => {
      const envelope = makeEnvelope({ taskId: 't-1' });
      const result = await service.approve(envelope);

      expect(result).toEqual({ ok: true, data: [] });
      expect(orchestrator.approve).toHaveBeenCalledWith('t-1');
      expect(orchestrator.approve).toHaveBeenCalledTimes(1);
    });

    it('returns cached result on duplicate idempotencyKey', async () => {
      const envelope = makeEnvelope({ taskId: 't-1' }, 'dup-key');
      await service.approve(envelope);
      const second = await service.approve(envelope);

      expect(second).toEqual({ ok: true, data: [] });
      expect(orchestrator.approve).toHaveBeenCalledTimes(1);
    });

    it('allows different idempotencyKeys to call orchestrator', async () => {
      await service.approve(makeEnvelope({ taskId: 't-1' }, 'key-a'));
      await service.approve(makeEnvelope({ taskId: 't-2' }, 'key-b'));

      expect(orchestrator.approve).toHaveBeenCalledTimes(2);
    });

    it('wraps orchestrator errors in CommandResult', async () => {
      orchestrator = stubOrchestrator({
        approve: vi.fn().mockRejectedValue(new Error('boom')),
      });
      service = new CommandService(orchestrator);

      const result = await service.approve(makeEnvelope({ taskId: 't-1' }));

      expect(result).toEqual({
        ok: false,
        error: { code: 'APPROVE_FAILED', message: 'boom' },
      });
    });

    it('caches error results too (no retry on same key)', async () => {
      orchestrator = stubOrchestrator({
        approve: vi.fn().mockRejectedValue(new Error('boom')),
      });
      service = new CommandService(orchestrator);

      await service.approve(makeEnvelope({ taskId: 't-1' }, 'err-key'));
      const second = await service.approve(
        makeEnvelope({ taskId: 't-1' }, 'err-key'),
      );

      expect(second.ok).toBe(false);
      expect(orchestrator.approve).toHaveBeenCalledTimes(1);
    });
  });

  // ── dedup regression ───────────────────────────────

  describe('idempotency-key dedup regression', () => {
    it('caches by idempotencyKey and invokes orchestrator once per unique key', async () => {
      const spyApprove = vi.fn().mockResolvedValue([{ id: 't-1' }] as unknown as TaskState[]);
      orchestrator = stubOrchestrator({ approve: spyApprove });
      service = new CommandService(orchestrator);

      const envelope = makeEnvelope({ taskId: 't-1' }, 'dedup-key');

      // First call — orchestrator invoked.
      const first = await service.approve(envelope);
      expect(first).toEqual({ ok: true, data: [{ id: 't-1' }] });
      expect(spyApprove).toHaveBeenCalledTimes(1);

      // Second call, same key — cached, orchestrator NOT re-invoked.
      const second = await service.approve(envelope);
      expect(second).toEqual({ ok: true, data: [{ id: 't-1' }] });
      expect(spyApprove).toHaveBeenCalledTimes(1);

      // Third call, different key — orchestrator invoked again.
      const differentEnvelope = makeEnvelope({ taskId: 't-2' }, 'other-key');
      await service.approve(differentEnvelope);
      expect(spyApprove).toHaveBeenCalledTimes(2);
    });
  });

  // ── reject ──────────────────────────────────────────────

  describe('reject', () => {
    it('delegates to orchestrator.reject when no pendingFixError', () => {
      const envelope = makeEnvelope({ taskId: 't-1', reason: 'bad' });
      const result = service.reject(envelope);

      expect(result).toEqual({ ok: true, data: undefined });
      expect(orchestrator.reject).toHaveBeenCalledWith('t-1', 'bad');
      expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
    });

    it('calls revertConflictResolution when pendingFixError exists', () => {
      (orchestrator.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        execution: { pendingFixError: 'merge conflict' },
      });
      const envelope = makeEnvelope({ taskId: 't-1', reason: 'bad' });
      const result = service.reject(envelope);

      expect(result).toEqual({ ok: true, data: undefined });
      expect(orchestrator.revertConflictResolution).toHaveBeenCalledWith(
        't-1',
        'merge conflict',
      );
      expect(orchestrator.reject).not.toHaveBeenCalled();
    });

    it('returns cached result on duplicate idempotencyKey', () => {
      const envelope = makeEnvelope(
        { taskId: 't-1', reason: 'bad' },
        'dup-reject',
      );
      service.reject(envelope);
      const second = service.reject(envelope);

      expect(second).toEqual({ ok: true, data: undefined });
      expect(orchestrator.reject).toHaveBeenCalledTimes(1);
    });
  });

  // ── TOCTOU race protection ──────────────────────────────

  describe('concurrent approve coalescing', () => {
    it('coalesces concurrent calls with the same key into one orchestrator invocation', async () => {
      let resolveApprove!: (val: TaskState[]) => void;
      const slowApprove = vi.fn().mockImplementation(
        () => new Promise<TaskState[]>((resolve) => { resolveApprove = resolve; }),
      );
      orchestrator = stubOrchestrator({ approve: slowApprove });
      service = new CommandService(orchestrator);

      const envelope = makeEnvelope({ taskId: 't-1' }, 'race-key');
      const p1 = service.approve(envelope);
      const p2 = service.approve(envelope);

      // Resolve the single in-flight call.
      resolveApprove([]);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual({ ok: true, data: [] });
      expect(r2).toEqual({ ok: true, data: [] });
      expect(slowApprove).toHaveBeenCalledTimes(1);
    });
  });

  // ── TTL expiry ──────────────────────────────────────────

  describe('TTL expiry', () => {
    it('evicts expired entries and re-invokes orchestrator', async () => {
      service = new CommandService(orchestrator, { ttlMs: 100 });

      await service.approve(makeEnvelope({ taskId: 't-1' }, 'ttl-key'));
      expect(orchestrator.approve).toHaveBeenCalledTimes(1);

      // Fast-forward past TTL.
      vi.useFakeTimers();
      vi.advanceTimersByTime(200);

      await service.approve(makeEnvelope({ taskId: 't-1' }, 'ttl-key'));
      expect(orchestrator.approve).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  // ── LRU eviction ────────────────────────────────────────

  describe('LRU eviction', () => {
    it('evicts oldest entry when cache reaches maxSize', async () => {
      service = new CommandService(orchestrator, {
        ttlMs: 60_000,
        maxSize: 2,
      });

      await service.approve(makeEnvelope({ taskId: 't-1' }, 'a'));
      await service.approve(makeEnvelope({ taskId: 't-2' }, 'b'));
      // Cache is full (a, b). Adding c evicts a.
      await service.approve(makeEnvelope({ taskId: 't-3' }, 'c'));
      expect(orchestrator.approve).toHaveBeenCalledTimes(3);

      // 'a' was evicted, so it re-invokes orchestrator.
      await service.approve(makeEnvelope({ taskId: 't-1' }, 'a'));
      expect(orchestrator.approve).toHaveBeenCalledTimes(4);

      // 'c' is still cached.
      await service.approve(makeEnvelope({ taskId: 't-3' }, 'c'));
      expect(orchestrator.approve).toHaveBeenCalledTimes(4);
    });
  });

  // ── Instance isolation ──────────────────────────────────

  describe('instance isolation', () => {
    it('separate instances have independent caches', async () => {
      const orch1 = stubOrchestrator();
      const orch2 = stubOrchestrator();
      const svc1 = new CommandService(orch1);
      const svc2 = new CommandService(orch2);

      const envelope = makeEnvelope({ taskId: 't-1' }, 'shared-key');
      await svc1.approve(envelope);
      await svc2.approve(envelope);

      // Each service called its own orchestrator.
      expect(orch1.approve).toHaveBeenCalledTimes(1);
      expect(orch2.approve).toHaveBeenCalledTimes(1);
    });
  });
});
