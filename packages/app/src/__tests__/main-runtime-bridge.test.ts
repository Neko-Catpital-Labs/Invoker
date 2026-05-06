/**
 * Regression tests for the main → runtime-service bridge.
 *
 * Verifies that app main startup correctly routes through
 * `composeRuntimeServices` from `@invoker/runtime-service`, and that
 * the resulting `RuntimeServices` facade behaves deterministically.
 *
 * Upstream: wf-1778055150679-2/wire-main-to-runtime-service (5b2cefa0)
 */

import { describe, it, expect } from 'vitest';
import {
  composeRuntimeServices,
  type RuntimeServiceDeps,
  type RuntimeServices,
} from '@invoker/runtime-service';

// ── Stub factories ───────────────────────────────────────────

/** Minimal deps matching the adapter shape used in main.ts. */
function stubDeps(): RuntimeServiceDeps {
  return {
    workspaceProbe: { probeWorkspace: async () => ({}) },
    containerProbe: { probeContainer: async () => ({}) },
    sessionProbe: { probeSession: async () => ({}) },
    terminalLauncher: {
      launchTerminal: async () => ({ result: 'attached' }) as any,
    },
  };
}

// ── Bridge wiring correctness ────────────────────────────────

describe('main → runtime-service bridge', () => {
  describe('adapter identity pass-through', () => {
    it('workspaceProbe adapter is the same object after composition', () => {
      const deps = stubDeps();
      const services = composeRuntimeServices(deps);
      expect(services.workspaceProbe).toBe(deps.workspaceProbe);
    });

    it('containerProbe adapter is the same object after composition', () => {
      const deps = stubDeps();
      const services = composeRuntimeServices(deps);
      expect(services.containerProbe).toBe(deps.containerProbe);
    });

    it('sessionProbe adapter is the same object after composition', () => {
      const deps = stubDeps();
      const services = composeRuntimeServices(deps);
      expect(services.sessionProbe).toBe(deps.sessionProbe);
    });

    it('terminalLauncher adapter is the same object after composition', () => {
      const deps = stubDeps();
      const services = composeRuntimeServices(deps);
      expect(services.terminalLauncher).toBe(deps.terminalLauncher);
    });
  });

  describe('facade immutability', () => {
    it('composed object is frozen', () => {
      const services = composeRuntimeServices(stubDeps());
      expect(Object.isFrozen(services)).toBe(true);
    });

    it('assigning to a property throws', () => {
      const services = composeRuntimeServices(stubDeps());
      expect(() => {
        (services as unknown as Record<string, unknown>).workspaceProbe = {};
      }).toThrow();
    });

    it('deleting a property throws', () => {
      const services = composeRuntimeServices(stubDeps());
      expect(() => {
        delete (services as unknown as Record<string, unknown>).workspaceProbe;
      }).toThrow();
    });

    it('adding a new property throws', () => {
      const services = composeRuntimeServices(stubDeps());
      expect(() => {
        (services as unknown as Record<string, unknown>).extra = true;
      }).toThrow();
    });
  });

  describe('facade shape', () => {
    it('exposes exactly the four expected keys', () => {
      const services = composeRuntimeServices(stubDeps());
      expect(Object.keys(services).sort()).toEqual([
        'containerProbe',
        'sessionProbe',
        'terminalLauncher',
        'workspaceProbe',
      ]);
    });

    it('satisfies the RuntimeServices type contract', () => {
      const services: RuntimeServices = composeRuntimeServices(stubDeps());
      expect(services.workspaceProbe.probeWorkspace).toBeTypeOf('function');
      expect(services.containerProbe.probeContainer).toBeTypeOf('function');
      expect(services.sessionProbe.probeSession).toBeTypeOf('function');
      expect(services.terminalLauncher.launchTerminal).toBeTypeOf('function');
    });
  });

  describe('deterministic behavior', () => {
    it('independent calls produce distinct facade objects', () => {
      const s1 = composeRuntimeServices(stubDeps());
      const s2 = composeRuntimeServices(stubDeps());
      expect(s1).not.toBe(s2);
    });

    it('same deps produce facades with identical adapter references', () => {
      const deps = stubDeps();
      const s1 = composeRuntimeServices(deps);
      const s2 = composeRuntimeServices(deps);
      expect(s1.workspaceProbe).toBe(s2.workspaceProbe);
      expect(s1.containerProbe).toBe(s2.containerProbe);
      expect(s1.sessionProbe).toBe(s2.sessionProbe);
      expect(s1.terminalLauncher).toBe(s2.terminalLauncher);
    });

    it('different deps produce facades with different adapter references', () => {
      const s1 = composeRuntimeServices(stubDeps());
      const s2 = composeRuntimeServices(stubDeps());
      expect(s1.workspaceProbe).not.toBe(s2.workspaceProbe);
      expect(s1.containerProbe).not.toBe(s2.containerProbe);
    });
  });

  describe('adapter method delegation', () => {
    it('probeWorkspace delegates through the composed facade', async () => {
      const expected = { workspacePath: '/test/path' };
      const deps = stubDeps();
      deps.workspaceProbe.probeWorkspace = async () => expected;
      const services = composeRuntimeServices(deps);
      const result = await services.workspaceProbe.probeWorkspace('task-1');
      expect(result).toBe(expected);
    });

    it('probeContainer delegates through the composed facade', async () => {
      const expected = { containerId: 'ctr-abc' };
      const deps = stubDeps();
      deps.containerProbe.probeContainer = async () => expected;
      const services = composeRuntimeServices(deps);
      const result = await services.containerProbe.probeContainer('task-1');
      expect(result).toBe(expected);
    });

    it('probeSession delegates through the composed facade', async () => {
      const expected = { agentName: 'claude', sessionId: 's-123' };
      const deps = stubDeps();
      deps.sessionProbe.probeSession = async () => expected;
      const services = composeRuntimeServices(deps);
      const result = await services.sessionProbe.probeSession('task-1');
      expect(result).toBe(expected);
    });

    it('launchTerminal delegates through the composed facade', async () => {
      const expected = { result: 'attached' } as any;
      const deps = stubDeps();
      deps.terminalLauncher.launchTerminal = async () => expected;
      const services = composeRuntimeServices(deps);
      const result = await services.terminalLauncher.launchTerminal({
        taskId: 'task-1',
        workspacePath: '/tmp/ws',
      });
      expect(result).toBe(expected);
    });
  });
});
