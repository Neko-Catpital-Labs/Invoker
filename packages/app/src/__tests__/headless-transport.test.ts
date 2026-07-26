import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';

import {
  HeadlessTransport,
  type HeadlessTransportDeps,
} from '../headless-transport.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<HeadlessTransportDeps> = {}): HeadlessTransportDeps {
  return {
    messageBus: new LocalBus(),
    ...overrides,
  };
}

/** Register a standalone owner on the given bus. */
function registerStandaloneOwner(
  bus: LocalBus,
  execHandler: (req: unknown) => Promise<unknown> = async () => ({ ok: true }),
): void {
  bus.onRequest('headless.owner-ping', async () => ({
    ok: true,
    ownerId: 'owner-standalone',
    mode: 'standalone',
  }));
  bus.onRequest('headless.exec', execHandler);
  bus.onRequest('headless.run', async (req: unknown) => {
    const { planPath } = req as { planPath: string };
    return { workflowId: `wf-${planPath}`, tasks: [] };
  });
  bus.onRequest('headless.resume', async (req: unknown) => {
    const { workflowId } = req as { workflowId: string };
    return { workflowId, tasks: [] };
  });
}

/** Register a GUI owner on the given bus. */
function registerGuiOwner(
  bus: LocalBus,
  execHandler: (req: unknown) => Promise<unknown> = async () => ({ ok: true }),
): void {
  bus.onRequest('headless.owner-ping', async () => ({
    ok: true,
    ownerId: 'owner-gui',
    mode: 'gui',
  }));
  bus.onRequest('headless.exec', execHandler);
  bus.onRequest('headless.run', async (req: unknown) => {
    const { planPath } = req as { planPath: string };
    return { workflowId: `wf-${planPath}`, tasks: [] };
  });
  bus.onRequest('headless.resume', async (req: unknown) => {
    const { workflowId } = req as { workflowId: string };
    return { workflowId, tasks: [] };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HeadlessTransport', () => {
  // =========================================================================
  // resolveOwnerMode
  // =========================================================================

  describe('resolveOwnerMode', () => {
    it('returns "standalone" when a standalone owner responds', async () => {
      const bus = new LocalBus();
      registerStandaloneOwner(bus);
      const transport = new HeadlessTransport(makeDeps({ messageBus: bus }));

      expect(await transport.resolveOwnerMode()).toBe('standalone');
    });

    it('returns "gui" when a GUI owner responds', async () => {
      const bus = new LocalBus();
      registerGuiOwner(bus);
      const transport = new HeadlessTransport(makeDeps({ messageBus: bus }));

      expect(await transport.resolveOwnerMode()).toBe('gui');
    });

    it('returns "none" when no owner responds', async () => {
      const transport = new HeadlessTransport(makeDeps());

      expect(await transport.resolveOwnerMode()).toBe('none');
    });
  });

  // =========================================================================
  // exec — standalone mode (owner already running)
  // =========================================================================

  describe('exec (standalone owner present)', () => {
    it('delegates a mutating command to the standalone owner', async () => {
      const bus = new LocalBus();
      const execHandler = vi.fn(async () => ({ ok: true }));
      registerStandaloneOwner(bus, execHandler);
      const transport = new HeadlessTransport(makeDeps({ messageBus: bus }));

      const result = await transport.exec(['retry', 'wf-1'], { noTrack: true });

      expect(result.ok).toBe(true);
      expect(result.args).toEqual(['retry', 'wf-1']);
      expect(execHandler).toHaveBeenCalledWith(expect.objectContaining({
        args: ['retry', 'wf-1'],
        noTrack: true,
        waitForApproval: undefined,
      }));
    });

    it('delegates "run" via the headless.run channel', async () => {
      const bus = new LocalBus();
      const runHandler = vi.fn(async () => ({
        workflowId: 'wf-new',
        tasks: [],
      }));
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-1',
        mode: 'standalone',
      }));
      bus.onRequest('headless.run', runHandler);
      const transport = new HeadlessTransport(makeDeps({ messageBus: bus }));

      const result = await transport.exec(
        ['run', '/tmp/plan.yaml'],
        { noTrack: true },
      );

      expect(result.ok).toBe(true);
      expect(runHandler).toHaveBeenCalledWith(
        expect.objectContaining({ planPath: expect.stringContaining('plan.yaml') }),
      );
    });

    it('delegates "resume" via the headless.resume channel', async () => {
      const bus = new LocalBus();
      const resumeHandler = vi.fn(async () => ({
        workflowId: 'wf-42',
        tasks: [],
      }));
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-1',
        mode: 'standalone',
      }));
      bus.onRequest('headless.resume', resumeHandler);
      const transport = new HeadlessTransport(makeDeps({ messageBus: bus }));

      const result = await transport.exec(
        ['resume', 'wf-42'],
        { noTrack: true },
      );

      expect(result.ok).toBe(true);
      expect(resumeHandler).toHaveBeenCalledWith(
        expect.objectContaining({ workflowId: 'wf-42' }),
      );
    });

    it('returns ok: false when a mutating command has no plan path', async () => {
      const bus = new LocalBus();
      registerStandaloneOwner(bus);
      const transport = new HeadlessTransport(makeDeps({ messageBus: bus }));

      // "run" with no plan path — delegation fails gracefully
      const result = await transport.exec(['run'], { noTrack: true });

      expect(result.ok).toBe(false);
    });
  });

  // =========================================================================
  // exec — shared-owner mode (GUI owner, then bootstrap standalone)
  // =========================================================================

  describe('exec (shared-owner / GUI owner mode)', () => {
    it('delegates mutations to a GUI owner without bootstrapping another owner', async () => {
      const firstBus = new LocalBus();
      const secondBus = new LocalBus();
      const guiExecHandler = vi.fn(async () => ({ ok: true }));

      registerGuiOwner(firstBus, guiExecHandler);
      registerStandaloneOwner(secondBus);

      const ensureStandaloneOwner = vi.fn(async () => {});
      const refreshMessageBus = vi.fn(async () => secondBus);

      const transport = new HeadlessTransport(makeDeps({
        messageBus: firstBus,
        ensureStandaloneOwner,
        refreshMessageBus,
      }));

      const result = await transport.exec(
        ['retry', 'wf-1'],
        { noTrack: true },
      );

      expect(result.ok).toBe(true);
      expect(guiExecHandler).toHaveBeenCalledWith(expect.objectContaining({
        args: ['retry', 'wf-1'],
        noTrack: true,
      }));
      expect(refreshMessageBus).not.toHaveBeenCalled();
      expect(ensureStandaloneOwner).not.toHaveBeenCalled();
    });

    it('bootstraps a standalone owner when no owner is present', async () => {
      const emptyBus = new LocalBus();
      const ownerBus = new LocalBus();
      registerStandaloneOwner(ownerBus);

      const ensureStandaloneOwner = vi.fn(async () => {});
      const refreshMessageBus = vi.fn(async () => ownerBus);

      const transport = new HeadlessTransport(makeDeps({
        messageBus: emptyBus,
        ensureStandaloneOwner,
        refreshMessageBus,
      }));

      const result = await transport.exec(
        ['recreate', 'wf-5'],
        { noTrack: true },
      );

      expect(result.ok).toBe(true);
      expect(ensureStandaloneOwner).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // exec — read-only commands
  // =========================================================================

  describe('exec (read-only commands)', () => {
    it('falls back to local executor for read-only commands', async () => {
      const execLocal = vi.fn(async () => 0);
      const transport = new HeadlessTransport(makeDeps({ execLocal }));

      const result = await transport.exec(['list']);

      expect(result.ok).toBe(true);
      expect(execLocal).toHaveBeenCalledWith(['list']);
    });

    it('returns ok: false for read-only commands with no local executor', async () => {
      const transport = new HeadlessTransport(makeDeps());

      const result = await transport.exec(['query', 'workflows']);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no local executor/i);
    });

    it('captures local executor non-zero exit as ok: false', async () => {
      const execLocal = vi.fn(async () => 1);
      const transport = new HeadlessTransport(makeDeps({ execLocal }));

      const result = await transport.exec(['status']);

      expect(result.ok).toBe(false);
      expect(result.response).toEqual({ exitCode: 1 });
    });
  });

  // =========================================================================
  // exec — error handling
  // =========================================================================

  describe('exec (error handling)', () => {
    it('captures delegation errors as ok: false with an error message', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-1',
        mode: 'standalone',
      }));
      bus.onRequest('headless.exec', async () => {
        throw new Error('owner crashed');
      });
      const transport = new HeadlessTransport(makeDeps({ messageBus: bus }));

      const result = await transport.exec(
        ['retry', 'wf-broken'],
        { noTrack: true },
      );

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/owner crashed/);
    });

    it('captures bootstrap errors as ok: false', async () => {
      const emptyBus = new LocalBus();
      const ensureStandaloneOwner = vi.fn(async () => {
        throw new Error('bootstrap failed');
      });
      const transport = new HeadlessTransport(makeDeps({
        messageBus: emptyBus,
        ensureStandaloneOwner,
      }));

      const result = await transport.exec(
        ['retry', 'wf-1'],
        { noTrack: true },
      );

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/bootstrap failed/);
    });
  });

  // =========================================================================
  // batchExec
  // =========================================================================

  describe('batchExec', () => {
    it('executes multiple commands sequentially by default', async () => {
      const bus = new LocalBus();
      const callOrder: string[] = [];
      const execHandler = vi.fn(async (req: unknown) => {
        const { args } = req as { args: string[] };
        callOrder.push(args.join(' '));
        return { ok: true };
      });
      registerStandaloneOwner(bus, execHandler);
      const transport = new HeadlessTransport(makeDeps({ messageBus: bus }));

      const results = await transport.batchExec(
        [
          { args: ['retry', 'wf-1'] },
          { args: ['retry', 'wf-2'] },
          { args: ['retry', 'wf-3'] },
        ],
        { noTrack: true },
      );

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(callOrder).toEqual(['retry wf-1', 'retry wf-2', 'retry wf-3']);
    });

    it('executes commands in parallel when parallel > 1', async () => {
      const bus = new LocalBus();
      let concurrency = 0;
      let maxConcurrency = 0;
      const execHandler = vi.fn(async () => {
        concurrency += 1;
        maxConcurrency = Math.max(maxConcurrency, concurrency);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrency -= 1;
        return { ok: true };
      });
      registerStandaloneOwner(bus, execHandler);
      const transport = new HeadlessTransport(makeDeps({ messageBus: bus }));

      const results = await transport.batchExec(
        [
          { args: ['retry', 'wf-1'] },
          { args: ['retry', 'wf-2'] },
          { args: ['retry', 'wf-3'] },
          { args: ['retry', 'wf-4'] },
        ],
        { noTrack: true, parallel: 3 },
      );

      expect(results).toHaveLength(4);
      expect(results.every((r) => r.ok)).toBe(true);
      // With 4 items and parallel=3, at least 2 should run concurrently
      expect(maxConcurrency).toBeGreaterThanOrEqual(2);
    });

    it('returns results in input order regardless of completion order', async () => {
      const bus = new LocalBus();
      const delays = [30, 10, 20];
      let callIndex = 0;
      const execHandler = vi.fn(async (req: unknown) => {
        const delay = delays[callIndex] ?? 0;
        callIndex += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        const { args } = req as { args: string[] };
        return { ok: true, id: args[1] };
      });
      registerStandaloneOwner(bus, execHandler);
      const transport = new HeadlessTransport(makeDeps({ messageBus: bus }));

      const results = await transport.batchExec(
        [
          { args: ['retry', 'wf-a'] },
          { args: ['retry', 'wf-b'] },
          { args: ['retry', 'wf-c'] },
        ],
        { noTrack: true, parallel: 3 },
      );

      expect(results[0].args).toEqual(['retry', 'wf-a']);
      expect(results[1].args).toEqual(['retry', 'wf-b']);
      expect(results[2].args).toEqual(['retry', 'wf-c']);
    });

    it('isolates failures so one bad command does not abort the batch', async () => {
      const bus = new LocalBus();
      let callCount = 0;
      const execHandler = vi.fn(async () => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error('owner rejected command');
        }
        return { ok: true };
      });
      registerStandaloneOwner(bus, execHandler);
      const transport = new HeadlessTransport(makeDeps({ messageBus: bus }));

      const results = await transport.batchExec(
        [
          { args: ['retry', 'wf-1'] },
          { args: ['retry', 'wf-2'] },
          { args: ['retry', 'wf-3'] },
        ],
        { noTrack: true },
      );

      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(false);
      expect(results[1].error).toMatch(/owner rejected command/);
      expect(results[2].ok).toBe(true);
    });

    it('returns empty results for empty input', async () => {
      const transport = new HeadlessTransport(makeDeps());

      const results = await transport.batchExec([], { noTrack: true });

      expect(results).toEqual([]);
    });

    it('clamps parallel to 1 when given 0', async () => {
      const bus = new LocalBus();
      const callOrder: number[] = [];
      let callIndex = 0;
      const execHandler = vi.fn(async () => {
        callOrder.push(callIndex);
        callIndex += 1;
        return { ok: true };
      });
      registerStandaloneOwner(bus, execHandler);
      const transport = new HeadlessTransport(makeDeps({ messageBus: bus }));

      const results = await transport.batchExec(
        [{ args: ['retry', 'wf-1'] }, { args: ['retry', 'wf-2'] }],
        { noTrack: true, parallel: 0 },
      );

      expect(results).toHaveLength(2);
      // With parallel=0 clamped to 1, calls are strictly sequential
      expect(callOrder).toEqual([0, 1]);
    });
  });

  // =========================================================================
  // Transport decision: IPC vs standalone
  // =========================================================================

  describe('transport decision centralisation', () => {
    it('never delegates read-only commands to the owner', async () => {
      const bus = new LocalBus();
      const execHandler = vi.fn(async () => ({ ok: true }));
      registerStandaloneOwner(bus, execHandler);
      const execLocal = vi.fn(async () => 0);

      const transport = new HeadlessTransport(makeDeps({
        messageBus: bus,
        execLocal,
      }));

      await transport.exec(['list']);
      await transport.exec(['status']);
      await transport.exec(['query', 'workflows']);

      // read-only commands should go to local executor, not IPC
      expect(execHandler).not.toHaveBeenCalled();
      expect(execLocal).toHaveBeenCalledTimes(3);
    });

    it('always delegates mutating commands via IPC when an owner is available', async () => {
      const bus = new LocalBus();
      const execHandler = vi.fn(async () => ({ ok: true }));
      registerStandaloneOwner(bus, execHandler);
      const execLocal = vi.fn(async () => 0);

      const transport = new HeadlessTransport(makeDeps({
        messageBus: bus,
        execLocal,
      }));

      await transport.exec(['retry', 'wf-1'], { noTrack: true });
      await transport.exec(['approve', 'wf-1/task-1'], { noTrack: true });
      await transport.exec(['cancel', 'wf-1/task-1'], { noTrack: true });

      // All mutating commands should go via IPC
      expect(execHandler).toHaveBeenCalledTimes(3);
      expect(execLocal).not.toHaveBeenCalled();
    });
  });
});
